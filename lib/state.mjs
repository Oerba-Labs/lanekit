/**
 * Everything a page needs to draw a repository's lanes, read fresh on every ask.
 *
 * NOTHING IS WRITTEN DOWN, here as in lanes.mjs. Git knows the worktrees, their
 * branches and where each forked; a lane's environment file knows its port; the
 * gate's run records know what was tested. This reads all three every time rather
 * than keeping a copy, because a copy is right until somebody works in a terminal,
 * which is most of the time.
 *
 * THE ONE THING CACHED is the queue's plan, because it is the one thing that costs:
 * it snapshots every dirty lane and merges every pair. It is kept against a
 * fingerprint of everything it reads — main's commit, each lane's commit and dirt,
 * the newest gate run — and made again the moment any of those moves.
 *
 * A LANE THAT HAS LANDED AND A LANE THAT IS EMPTY look alike to git: both are
 * contained in the integration branch. They are told apart by where the lane's
 * commit sits. A lane that landed was merged with `--no-ff`, so its commit is the
 * second parent of a merge and never on the integration branch's first-parent line;
 * a lane made a minute ago points at a commit that is. The difference matters
 * because only one of them is safe to sweep.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_NAME, loadConfig } from './config.mjs'
import { lanes as lanesOf, listenersOn, portOf } from './lanes.mjs'
import { planQueue } from './queue.mjs'
import { listRuns } from './runs.mjs'

const STACK_LIMIT = 20
const SPINE_LENGTH = 12
const FIRST_PARENT_DEPTH = 500

const gitIn = (cwd, args) => {
    const result = spawnSync('git', args, {
        cwd, encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

// Unit and record separators: a subject can hold any printable character, these two it cannot.
const LOG_FORMAT = '--format=%H%x1f%h%x1f%ct%x1f%an%x1f%s%x1e'

const commits = (cwd, args) => {
    const result = gitIn(cwd, ['log', LOG_FORMAT, ...args])
    if (!result.ok) return []
    return result.out.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
        const [sha, short, seconds, author, subject] = record.split('\x1f')
        return { sha, short, at: Number(seconds) * 1000, author, subject }
    })
}

const headOf = (cwd, ref = 'HEAD') => commits(cwd, ['-1', ref])[0] ?? null

const count = (cwd, range) => {
    const result = gitIn(cwd, ['rev-list', '--count', range])
    return result.ok ? Number(result.out) : null
}

/** Uncommitted paths, less the lane's links to main's rebuildable directories, which the gate ignores too. */
const dirtOf = (cwd, config) => {
    const result = gitIn(cwd, ['status', '--porcelain'])
    if (!result.ok) return 0
    return result.out.split('\n').filter(Boolean)
        .filter((line) => !(config.lane.linkOnCreate ?? []).some((rel) => line.includes(rel)))
        .length
}

/**
 * What is uncommitted, file by file: `{ status, path }`, status M (changed), A (added), D (deleted),
 * R (renamed) or ? (new to git), less the links to main's rebuildable directories. The newest hundred.
 */
export const changesOf = (cwd, config) => {
    // Untrimmed: a status column may begin with a space, and trimming the first entry would eat it.
    const result = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    if (result.status !== 0) return []
    const parts = (result.stdout ?? '').split('\0')
    const files = []
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i]
        if (entry.length < 4) continue
        const [x, y, file] = [entry[0], entry[1], entry.slice(3)]
        if (x === 'R' || x === 'C') i++   // the old name follows a rename
        if ((config.lane.linkOnCreate ?? []).some((rel) => file.includes(rel))) continue
        const status = x === '?' ? '?' : y !== ' ' ? y : x
        files.push({ status: status === 'U' ? 'M' : status, path: file })
    }
    return files.slice(0, 100)
}

/** A rebase or a merge left half-done, which makes everything else about the checkout provisional. */
const operationOf = (cwd) => {
    const gitDir = gitIn(cwd, ['rev-parse', '--git-dir'])
    if (!gitDir.ok) return null
    const dir = path.resolve(cwd, gitDir.out)
    if (fs.existsSync(path.join(dir, 'rebase-merge')) || fs.existsSync(path.join(dir, 'rebase-apply'))) return 'rebase'
    if (fs.existsSync(path.join(dir, 'MERGE_HEAD'))) return 'merge'
    return null
}

/** When this repository last heard from its remote: FETCH_HEAD's date, in its common git directory. */
const fetchedAtOf = (repo) => {
    const common = gitIn(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
    if (!common.ok) return null
    try {
        return fs.statSync(path.join(common.out, 'FETCH_HEAD')).mtimeMs
    } catch {
        return null
    }
}

/** The files a rebase or a merge stopped on, still unmerged. */
const conflictsOf = (cwd) => gitIn(cwd, ['diff', '--name-only', '--diff-filter=U']).out.split('\n').filter(Boolean)

/** Where a branch is pushed to, and how far apart the two are, as of the last fetch. Nothing is fetched here. */
const upstreamOf = (cwd, branch) => {
    const name = gitIn(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
    if (!name.ok || !name.out) return null
    // Where it is, too: the page tags that commit with its name, as ISL tags remote/main.
    const sha = gitIn(cwd, ['rev-parse', '--verify', '--quiet', `${name.out}^{commit}`])
    const sides = gitIn(cwd, ['rev-list', '--left-right', '--count', `${name.out}...${branch}`])
    if (!sides.ok) return { name: name.out, sha: sha.ok ? sha.out : null, ahead: null, behind: null }
    const [behind, ahead] = sides.out.split(/\s+/).map(Number)
    return { name: name.out, sha: sha.ok ? sha.out : null, ahead, behind }
}

/**
 * The newest gate run for a branch in this worktree, and whether it is about the commit there now.
 * A run from another worktree tested another tree, so it is not this lane's, whatever its branch.
 */
const lastGate = (runs, branch, worktree, headSha) => {
    const run = runs.find((candidate) =>
        candidate.branch === branch && (!candidate.worktree || candidate.worktree === worktree))
    if (!run) return null
    return {
        id: run.id,
        result: run.result,
        tier: run.tier,
        earned: run.earned,
        narrowed: Boolean(run.narrowed),
        current: run.sha === headSha,
        at: Date.parse(run.startedAt) || null,
        seconds: run.durationSeconds ?? null,
        // What failed, and its last lines, for the page to show why (gate.mjs keeps them since 30 Sep).
        failures: (run.failures ?? []).map((failure) => ({
            what: failure.what, status: failure.status,
            tail: String(failure.tail ?? '').split('\n').slice(-12).join('\n')
        }))
    }
}

// ---------------------------------------------------------------------------
// the queue, planned only when something it reads has moved
// ---------------------------------------------------------------------------

const plans = new Map()

const planFor = (repo, candidates, config, fingerprint) => {
    const kept = plans.get(repo)
    if (kept && kept.fingerprint === fingerprint) return kept
    let entries = new Map()
    let error = null
    try {
        const plan = planQueue(repo, candidates, config)
        entries = new Map(plan.entries.map((entry) => [entry.name, entry]))
    } catch (caught) {
        error = caught.message
    }
    const made = { fingerprint, entries, error, at: Date.now() }
    plans.set(repo, made)
    return made
}

// ---------------------------------------------------------------------------
// repositories
// ---------------------------------------------------------------------------

/** A main checkout: its config is there and its `.git` is a directory. A lane's `.git` is a file. */
const isMainCheckout = (dir) => {
    try {
        return fs.existsSync(path.join(dir, CONFIG_NAME)) && fs.statSync(path.join(dir, '.git')).isDirectory()
    } catch {
        return false
    }
}

/**
 * The main checkout that owns the git directory `dir` is in — a lane's, or a folder inside
 * either — when that checkout has lanes. Null for anything else, a folder outside git included.
 */
const ownerOf = (dir) => {
    const result = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    })
    if (result.status !== 0 || !result.stdout) return null
    const main = path.dirname(result.stdout.trim())
    return isMainCheckout(main) ? main : null
}

/**
 * Every main checkout directly under `dir`, or `dir` itself when it is one; failing both,
 * the main checkout of the repository `dir` is inside.
 *
 * One level, not a walk: a workspace keeps its repositories side by side in /work with
 * their lanes beside them, and a walk would find each lane's config and each
 * dependency's vendored copy of somebody else's. The last case is an editor opened on one
 * lane, or on a folder deep inside a checkout: its repository is still the one to show.
 */
export const findRepos = (dir) => {
    const root = path.resolve(dir)
    if (isMainCheckout(root)) return [root]
    let entries = []
    try {
        entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
        return []
    }
    const found = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(root, entry.name))
        .filter(isMainCheckout)
        .sort()
    if (found.length) return found
    const owner = ownerOf(root)
    return owner ? [owner] : []
}

/** The repositories of several folders at once, each once, in order of path. */
export const findReposIn = (dirs) => [...new Set(dirs.flatMap((dir) => findRepos(dir)))].sort()

/**
 * One repository, whole: its main checkout, its integration branch's recent history and
 * every lane with what it holds. Never throws; what cannot be read is said in `error`.
 */
export const repoState = (repo) => {
    const id = path.basename(repo)
    let config
    try {
        config = loadConfig(repo)
    } catch (error) {
        return { id, path: repo, error: error.message, lanes: [], spine: [] }
    }
    const base = config.integrationBranch

    const current = gitIn(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const main = {
        path: repo,
        branch: current.ok ? current.out : null,
        onIntegration: current.ok && current.out === base,
        head: headOf(repo, base),
        dirty: dirtOf(repo, config),
        operation: operationOf(repo),
        upstream: upstreamOf(repo, base),
        fetchedAt: fetchedAtOf(repo)
    }
    // One further than is shown, to know whether main's line goes on below the log: the page dashes it if so.
    const read = commits(repo, ['--first-parent', `-n${SPINE_LENGTH + 1}`, base])
    const spine = read.slice(0, SPINE_LENGTH)
    const firstParent = new Set(
        gitIn(repo, ['rev-list', '--first-parent', `--max-count=${FIRST_PARENT_DEPTH}`, base]).out
            .split('\n').filter(Boolean))
    const runs = listRuns(repo)

    const discovered = lanesOf(repo, base)
    const found = discovered.map((lane) => {
        const branch = lane.branch ?? lane.name
        const port = portOf(lane, config)
        const shared = { name: lane.name, branch, path: lane.path, exists: lane.exists, port }
        if (!lane.exists) return { ...shared, kind: 'missing', serving: false }

        const head = headOf(lane.path)
        const sides = gitIn(repo, ['rev-list', '--left-right', '--count', `${base}...${branch}`])
        const [behind, ahead] = sides.ok ? sides.out.split(/\s+/).map(Number) : [null, null]
        const fork = gitIn(repo, ['merge-base', base, branch])
        const contained = ahead === 0
        const kind = !contained ? 'working'
            : head && firstParent.has(head.sha) ? 'fresh'
                : 'landed'
        const stack = contained ? [] : commits(repo, [`-n${STACK_LIMIT + 1}`, `${base}..${branch}`])

        return {
            ...shared,
            kind,
            head,
            ahead, behind,
            base: fork.ok ? fork.out : null,
            stack: stack.slice(0, STACK_LIMIT),
            more: stack.length > STACK_LIMIT,
            dirty: dirtOf(lane.path, config),
            changes: changesOf(lane.path, config),
            ...(() => { const operation = operationOf(lane.path); return { operation, conflicts: operation ? conflictsOf(lane.path) : [] } })(),
            serving: port ? listenersOn(port).length > 0 : false,
            upstream: upstreamOf(repo, branch),
            gate: head ? lastGate(runs, branch, lane.path, head.sha) : null
        }
    })

    // The plan covers every lane with something in it; a landed one has nothing left to order.
    const planned = found.filter((lane) => lane.exists && lane.kind !== 'landed')
    const fingerprint = [
        main.head?.sha,
        ...planned.map((lane) => `${lane.name}:${lane.head?.sha}:${lane.dirty}:${lane.operation}`),
        runs[0]?.id
    ].join('|')
    const plan = planned.length
        ? planFor(repo, discovered.filter((lane) => planned.some((p) => p.name === lane.name)), config, fingerprint)
        : { entries: new Map(), error: null, at: Date.now() }

    const withQueue = found.map((lane) => {
        const entry = plan.entries.get(lane.name)
        if (!entry) return { ...lane, queue: null }
        return {
            ...lane,
            queue: {
                verdict: entry.verdict,
                why: entry.why ?? null,
                // Its place among the lanes it collides with: 0 lands first (queue.mjs, the costlier first).
                position: entry.position ?? null,
                tier: entry.tier ?? null,
                green: Boolean(entry.green),
                files: (entry.files ?? []).slice(0, 200),
                collisions: (entry.collisions ?? []).map((collision) => ({ lane: collision.lane, paths: collision.paths.slice(0, 20) }))
            }
        }
    })

    return {
        id,
        path: repo,
        name: config.name,
        slug: config.slug,
        integrationBranch: base,
        portWindow: [config.lane.portBase, config.lane.portCeiling],
        main,
        spine,
        spineMore: read.length > SPINE_LENGTH,
        lanes: withQueue,
        plannedAt: plan.at,
        planError: plan.error
    }
}
