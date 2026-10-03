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
 * the newest gate run — and made again the moment any of those moves. (How long
 * main's line is, a walk of all of it, is kept too, against main's commit: a
 * commit's history never changes, so there is nothing for it to go stale on.)
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
// Main's line is read twelve commits deep, and a page asks further back a page at a time (the service keeps how far,
// for each repository), as far as SPINE_MOST: past that git log has them, and a page of hundreds of rows helps nobody.
export const SPINE_LENGTH = 12
export const SPINE_PAGE = 25
export const SPINE_MOST = 500
const FIRST_PARENT_DEPTH = 500

// How many commits main's own line holds, for "37 of 1,204": a walk of the whole line, so counted once for each commit
// main is at, and never again while it stays there.
const lineLengths = new Map()   // commit -> its first-parent line's length, itself included
const lineLengthOf = (repo, tip) => {
    if (!tip) return null
    if (!lineLengths.has(tip)) {
        if (lineLengths.size > 200) lineLengths.clear()
        const counted = gitIn(repo, ['rev-list', '--first-parent', '--count', tip])
        lineLengths.set(tip, counted.ok ? Number(counted.out) : null)
    }
    return lineLengths.get(tip)
}

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

const DAY = 24 * 60 * 60 * 1000
/**
 * When anything last happened in a checkout: its newest commit of its own (`head`, given for a lane with commits of its
 * own), the newest change to a file not yet committed, or, with neither, when its folder was made (its .git file).
 */
const lastActiveOf = (cwd, head, changes) => {
    const times = []
    if (head?.at) times.push(head.at)
    for (const change of changes ?? []) {
        try { times.push(fs.statSync(path.join(cwd, change.path)).mtimeMs) } catch { /* deleted: the commit or the making says when */ }
    }
    if (!times.length) {
        try { const made = fs.statSync(path.join(cwd, '.git')); times.push(made.birthtimeMs || made.mtimeMs) } catch { return null }
    }
    return Math.max(...times)
}

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
 * R (renamed, with the name it had as `from`) or ? (new to git), less the links to main's rebuildable
 * directories. The first hundred, or `limit`: what carries work elsewhere needs every one.
 */
export const changesOf = (cwd, config, { limit = 100 } = {}) => {
    // Untrimmed: a status column may begin with a space, and trimming the first entry would eat it.
    const result = spawnSync('git', ['status', '--porcelain=v1', '-z'], { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
    if (result.status !== 0) return []
    const parts = (result.stdout ?? '').split('\0')
    const files = []
    for (let i = 0; i < parts.length; i++) {
        const entry = parts[i]
        if (entry.length < 4) continue
        const [x, y, file] = [entry[0], entry[1], entry.slice(3)]
        // The old name follows a rename.
        const from = x === 'R' || x === 'C' ? parts[++i] : null
        if ((config.lane.linkOnCreate ?? []).some((rel) => file.includes(rel))) continue
        const status = x === '?' ? '?' : y !== ' ' ? y : x
        files.push({ status: status === 'U' ? 'M' : status, path: file, ...(from && x === 'R' ? { from } : {}) })
    }
    return files.slice(0, limit)
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

/**
 * Where a branch is pushed to, and how far apart the two are, as of the last fetch. Nothing is fetched here.
 *
 * `foreign`: how many of the commits there are not this branch's own, rebased or not: somebody pushed to it (a
 * colleague, GitHub's Update branch, a suggestion committed from a review). A branch rebased since it was pushed has
 * none, since each old commit is the same change as one of its new ones; replacing origin's copy then loses nothing.
 * One that has some would lose them, so the page never offers to replace it. Commits `mains` has (the integration
 * branch, here and on origin) are nobody's own work to lose: a lane moved back along main leaves main's newer ones there.
 */
export const upstreamOf = (cwd, branch, mains = []) => {
    const name = gitIn(cwd, ['rev-parse', '--abbrev-ref', `${branch}@{upstream}`])
    if (!name.ok || !name.out) return null
    // Where it is, too: the page tags that commit with its name, as ISL tags remote/main.
    const sha = gitIn(cwd, ['rev-parse', '--verify', '--quiet', `${name.out}^{commit}`])
    const sides = gitIn(cwd, ['rev-list', '--left-right', '--count', `${name.out}...${branch}`])
    if (!sides.ok) return { name: name.out, sha: sha.ok ? sha.out : null, ahead: null, behind: null, foreign: null }
    const [behind, ahead] = sides.out.split(/\s+/).map(Number)
    const theirs = behind && ahead ? gitIn(cwd, ['rev-list', '--count', '--left-only', '--cherry-pick', `${name.out}...${branch}`, ...(mains.length ? ['--not', ...mains] : [])]) : null
    const foreign = !behind ? 0 : !ahead ? behind : theirs.ok ? Number(theirs.out) : null
    return { name: name.out, sha: sha.ok ? sha.out : null, ahead, behind, foreign }
}

/**
 * How many commits `branch` has after `sha`, where `sha` is one of its own: the commits a lane gained after the one its
 * pull request was merged at. Null where `sha` is not in its history (rebased since, or never fetched here).
 */
export const commitsAfter = (cwd, sha, branch) => {
    if (!/^[0-9a-f]{40,64}$/.test(String(sha ?? ''))) return null
    if (!gitIn(cwd, ['merge-base', '--is-ancestor', sha, branch]).ok) return null
    const counted = gitIn(cwd, ['rev-list', '--count', `${sha}..${branch}`])
    return counted.ok ? Number(counted.out) : null
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

/** A repository's own checkout with no lanes yet: a `.git` directory (a lane's is a file) and no config. */
const isBareCheckout = (dir) => {
    try {
        return !fs.existsSync(path.join(dir, CONFIG_NAME)) && fs.statSync(path.join(dir, '.git')).isDirectory()
    } catch {
        return false
    }
}

/**
 * The repositories in `dir`, or `dir` itself, that have no lanes yet: what the page offers to give them, after a
 * look at what that writes. Directly inside, as findRepos looks, hidden folders aside; a folder, a stat and no git,
 * so it costs nothing to ask on every reading.
 */
export const findWithoutLanes = (dir) => {
    const root = path.resolve(dir)
    if (isMainCheckout(root)) return []
    if (isBareCheckout(root)) return [root]
    let entries = []
    try {
        entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
        return []
    }
    return entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => path.join(root, entry.name))
        .filter(isBareCheckout)
        .sort()
}

/** Those of several folders, each once: `{ id, path }`, as a repository with lanes is named. */
export const withoutLanesIn = (dirs) => [...new Set(dirs.flatMap((dir) => findWithoutLanes(dir)))].sort()
    .map((repo) => ({ id: path.basename(repo), path: repo }))

/**
 * One repository, whole: its main checkout, its integration branch's recent history and
 * every lane with what it holds. Never throws; what cannot be read is said in `error`.
 * `spineLength`: how many of the integration branch's commits to read, SPINE_LENGTH unless a page asked further back.
 */
export const repoState = (repo, { spineLength = SPINE_LENGTH } = {}) => {
    const length = Number.isInteger(spineLength) ? Math.min(SPINE_MOST, Math.max(SPINE_LENGTH, spineLength)) : SPINE_LENGTH
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
        // What is uncommitted there, file by file, as a lane's is: drawn on main's line, to move into a lane or discard.
        changes: changesOf(repo, config),
        operation: operationOf(repo),
        upstream: upstreamOf(repo, base),
        fetchedAt: fetchedAtOf(repo)
    }
    // One further than is shown, to know whether main's line goes on below the log: the page dashes it if so.
    const read = commits(repo, ['--first-parent', `-n${length + 1}`, base])
    const spine = read.slice(0, length)
    const total = lineLengthOf(repo, spine[0]?.sha)
    const firstParent = new Set(
        gitIn(repo, ['rev-list', '--first-parent', `--max-count=${FIRST_PARENT_DEPTH}`, base]).out
            .split('\n').filter(Boolean))
    const runs = listRuns(repo)
    // Which lanes a person has set aside (lane aside): kept in the clone's git settings, one read for all of them.
    const asideOf = new Map(gitIn(repo, ['config', '--get-regexp', '^branch\\..*\\.lanekitaside$']).out.split('\n').filter(Boolean).map((line) => {
        const space = line.indexOf(' ')
        return [line.slice('branch.'.length, line.lastIndexOf('.', space)), line.slice(space + 1)]
    }))
    const quietAfter = config.lane.staleAfterDays ?? 14

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
        const changes = changesOf(lane.path, config)
        const active = lastActiveOf(lane.path, kind === 'working' ? head : null, changes)
        const quietDays = active ? Math.floor((Date.now() - active) / DAY) : null

        return {
            ...shared,
            kind,
            head,
            ahead, behind,
            base: fork.ok ? fork.out : null,
            stack: stack.slice(0, STACK_LIMIT),
            more: stack.length > STACK_LIMIT,
            dirty: dirtOf(lane.path, config),
            changes,
            // When anything last happened in it, and whether that makes it quiet: a commit of its own, a change not yet
            // committed, or, for a lane with neither, its making.
            lastActive: active,
            quietDays,
            quiet: kind !== 'landed' && quietDays !== null && quietDays >= quietAfter,
            aside: asideOf.get(branch) ?? null,
            ...(() => { const operation = operationOf(lane.path); return { operation, conflicts: operation ? conflictsOf(lane.path) : [] } })(),
            serving: port ? listenersOn(port).length > 0 : false,
            upstream: upstreamOf(repo, branch, [base, main.upstream?.name].filter(Boolean)),
            gate: head ? lastGate(runs, branch, lane.path, head.sha) : null
        }
    })

    // The plan covers every lane with something in it: not a landed one, which has nothing left to order, nor one with
    // nothing committed and nothing changed, nor one a person has set aside.
    const planned = found.filter((lane) => lane.exists && lane.kind !== 'landed' && !lane.aside && !(lane.kind === 'fresh' && !lane.dirty))
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
        spineMore: read.length > length,
        // Read further back than the newest twelve, so the page offers them alone again; as far back as is ever read.
        spineDeeper: length > SPINE_LENGTH,
        spineAtMost: length >= SPINE_MOST,
        // Main's line, whole, and how many of it the next ask further back would add: 0 where there are no more to read.
        spineTotal: total,
        spineNext: read.length > length ? Math.max(0, Math.min(SPINE_PAGE, SPINE_MOST - length, (total ?? Infinity) - length)) : 0,
        lanes: withQueue,
        plannedAt: plan.at,
        planError: plan.error
    }
}
