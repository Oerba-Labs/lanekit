/**
 * Which worktrees are lanes, and what each one claims.
 *
 * NOTHING IS WRITTEN DOWN. There is no registry of live lanes and there must
 * not be one: git already knows which worktrees exist, and each lane's own
 * environment file already records the port and paths it was given. A registry
 * would be a second copy of both, and the failure mode of a second copy is that
 * it is right until somebody removes a worktree by hand.
 *
 * So a lane is discovered, not remembered: `git worktree list`, filtered to
 * directories whose name starts with the main checkout's own name and a dash.
 * That prefix is derived rather than configured — the project the tooling came
 * from carried its directory name as a literal in three process predicates, and
 * it was correct there and wrong in every clone.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const git = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * The checkout that owns the git directory — main, even when called from a lane.
 *
 * `--git-common-dir` rather than `--git-dir`: a worktree's own git dir is under
 * main's, and it is main we want.
 */
export const mainRepoFrom = (cwd) => {
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
    return path.dirname(common)
}

/** `<main>-`, the prefix every lane directory carries. Derived, never configured. */
export const prefixFor = (mainRepo) => `${path.basename(mainRepo)}-`

const parseWorktrees = (porcelain) => {
    const out = []
    let current = null
    for (const line of porcelain.split('\n')) {
        if (line.startsWith('worktree ')) {
            current = { path: line.slice('worktree '.length), branch: null }
            out.push(current)
        } else if (line.startsWith('branch ') && current) {
            current.branch = line.slice('branch refs/heads/'.length)
        }
    }
    return out
}

export const worktrees = (cwd) => parseWorktrees(git(['worktree', 'list', '--porcelain'], cwd))

/**
 * The lanes of this repository.
 *
 * A lane's NAME is its directory suffix, not its branch: the two can differ,
 * and every resource a lane owns — its directory, its database file, its
 * environment — is named after the directory.
 */
export const lanes = (cwd = process.cwd(), integrationBranch = null) => {
    const mainRepo = mainRepoFrom(cwd)
    const prefix = prefixFor(mainRepo)
    const parent = path.dirname(mainRepo)
    return worktrees(cwd)
        .filter((tree) => tree.path !== mainRepo && path.basename(tree.path).startsWith(prefix))
        // A checkout of the integration branch is not a lane, whatever it is
        // called. The directory prefix alone cannot tell them apart — a worktree
        // at `<main>-main` matches it exactly — and the consequence is not
        // cosmetic: `sweep` would find that checkout "contained in main", which
        // is trivially true of the branch itself, and remove the integration
        // checkout somebody is working in.
        .filter((tree) => !integrationBranch || tree.branch !== integrationBranch)
        .map((tree) => ({
            ...tree,
            name: path.basename(tree.path).slice(prefix.length),
            exists: fs.existsSync(tree.path)
        }))
        .map((lane) => ({ ...lane, parent }))
}

export const laneDirFor = (mainRepo, name) =>
    path.join(path.dirname(mainRepo), `${prefixFor(mainRepo)}${name}`)

// ---------------------------------------------------------------------------
// environment files — how a lane records what it was given
// ---------------------------------------------------------------------------

/**
 * Parse a dotenv file well enough to read a value back.
 *
 * Deliberately not a dependency and deliberately not clever: it reads what this
 * package writes, plus the ordinary `KEY=value` a person writes. Quotes are
 * stripped because a quoted port that comes back as `"8100"` is a port nobody
 * is listening on and a comparison nobody can see is failing.
 */
export const parseEnv = (text) => {
    const values = {}
    for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const eq = trimmed.indexOf('=')
        if (eq === -1) continue
        const key = trimmed.slice(0, eq).trim()
        let value = trimmed.slice(eq + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1)
        }
        values[key] = value
    }
    return values
}

export const readEnv = (file) => {
    try {
        return parseEnv(fs.readFileSync(file, 'utf8'))
    } catch {
        return {}
    }
}

/**
 * Set keys in a dotenv file, replacing rather than appending.
 *
 * Appending looks like it works: dotenv takes the last value, so the file reads
 * correctly and shows two lines for the same key. It stops working the moment
 * anything reads the file with a parser that takes the first, and it makes a
 * lane's environment unreadable to a person, which is when they are looking at
 * it because something is already wrong.
 */
export const writeEnv = (file, updates) => {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const lines = existing ? existing.split('\n') : []
    const seen = new Set()

    const next = lines.map((line) => {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) return line
        const eq = trimmed.indexOf('=')
        if (eq === -1) return line
        const key = trimmed.slice(0, eq).trim()
        if (!(key in updates)) return line
        seen.add(key)
        return `${key}=${updates[key]}`
    })

    for (const [key, value] of Object.entries(updates)) {
        if (!seen.has(key)) next.push(`${key}=${value}`)
    }

    let text = next.join('\n')
    if (!text.endsWith('\n')) text += '\n'
    fs.writeFileSync(file, text)
}

// ---------------------------------------------------------------------------
// ports
// ---------------------------------------------------------------------------

/** Who is listening on a port, if anyone. Empty when `lsof` is unavailable. */
export const listenersOn = (port) => {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8' })
    if (result.status !== 0 || !result.stdout) return []
    return result.stdout.split('\n').filter(Boolean).map(Number)
}

export const portOf = (lane, config) => {
    const envFile = path.join(lane.path, config.lane.env.file)
    const value = readEnv(envFile)[config.lane.env.portKey]
    const port = Number(value)
    return Number.isInteger(port) && port > 0 ? port : null
}

/**
 * The next port no lane claims and nobody is serving.
 *
 * BOTH TESTS, not just the first. A lane removed by hand leaves its server
 * running; the port is then unclaimed by any lane and very much in use, and a
 * new lane handed it writes that port into its own environment and spends the
 * afternoon talking to a server running out of a directory that no longer
 * exists. It answers, which is what makes it expensive.
 */
export const nextFreePort = (config, cwd = process.cwd()) => {
    const claimed = new Set(lanes(cwd, config.integrationBranch).map((lane) => portOf(lane, config)).filter(Boolean))
    for (let port = config.lane.portBase; port <= config.lane.portCeiling; port++) {
        if (claimed.has(port)) continue
        if (listenersOn(port).length) continue
        return port
    }
    throw new Error(
        `no free port between ${config.lane.portBase} and ${config.lane.portCeiling}.\n` +
        `  Every port in the lane window is claimed or being served. ` +
        `Sweep a finished lane, or widen lane.portCeiling.`)
}

/** Same directory, or inside it — the separator is what stops a prefix match. */
export const isUnder = (child, parent) => {
    if (!child || !parent) return false
    const base = parent.endsWith('/') ? parent.slice(0, -1) : parent
    return child === base || child.startsWith(base + path.sep)
}
