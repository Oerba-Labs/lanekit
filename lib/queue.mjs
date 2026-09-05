/**
 * Which lane should land next, and which lanes would collide.
 *
 * WHY THIS EXISTS AT ALL. The gate answers for one branch. Nothing answers for
 * the relationship between them — and a gate result names a sha, so the moment
 * one lane lands, every green run on a conflicting lane is void and its gate
 * has to run again. Order badly and you pay for the same run twice.
 *
 * IT PREDICTS RATHER THAN GUESSES. Collisions come from `git merge-tree` —
 * git's own three-way merge — so two lanes that both touched a file git can
 * reconcile are not reported as colliding. A filename comparison would say they
 * conflict, which is wrong often enough to be ignored, and a queue that is
 * ignored is worse than none.
 *
 * IT DECIDES NOTHING ABOUT MERGING. Every verdict is advice except through
 * `landBlockers`, which is the one list `land` acts on, so the reason a merge
 * was refused is the reason the queue printed.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { tierFor } from './tiers.mjs'
import { greenFor } from './runs.mjs'

const MAX_PAIRS = 200

const gitIn = (repo, args, env) => {
    const result = spawnSync('git', args, {
        cwd: repo, encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }
    })
    return { ok: result.status === 0, code: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

/**
 * A commit standing for everything a lane currently holds, committed or not.
 *
 * NOT `git stash create`. That is the obvious tool and it cannot see untracked
 * files — it takes no `-u` — and a new module, a new test or a new script
 * starts untracked. A lane's most interesting work is routinely invisible to
 * it, so the prediction would be made against a tree missing exactly the files
 * most likely to collide.
 *
 * So: a throwaway index, `read-tree` the head, `add -A` into it, `write-tree`,
 * `commit-tree`. The lane's real index is never touched — `GIT_INDEX_FILE`
 * points somewhere else for the duration.
 *
 * REFUSES MID-OPERATION. A lane part-way through a rebase or a merge has a
 * working tree that means nothing yet, and snapshotting it would predict
 * against conflict markers.
 */
export const snapshotOf = (lane) => {
    const gitDir = gitIn(lane.path, ['rev-parse', '--git-dir'])
    if (!gitDir.ok) return { ok: false, why: 'not a git checkout' }
    const dir = path.resolve(lane.path, gitDir.out)
    for (const marker of ['rebase-merge', 'rebase-apply', 'MERGE_HEAD']) {
        if (fs.existsSync(path.join(dir, marker))) {
            return { ok: false, why: `part-way through a ${marker.startsWith('rebase') ? 'rebase' : 'merge'}` }
        }
    }

    const head = gitIn(lane.path, ['rev-parse', 'HEAD'])
    if (!head.ok) return { ok: false, why: 'has no commits' }

    const status = gitIn(lane.path, ['status', '--porcelain'])
    if (status.ok && !status.out) return { ok: true, sha: head.out, dirty: false }

    const indexFile = path.join(os.tmpdir(), `lanekit-queue-${process.pid}-${lane.name}.idx`)
    try {
        const env = { GIT_INDEX_FILE: indexFile }
        if (!gitIn(lane.path, ['read-tree', 'HEAD'], env).ok) return { ok: true, sha: head.out, dirty: true }
        gitIn(lane.path, ['add', '-A'], env)
        const tree = gitIn(lane.path, ['write-tree'], env)
        if (!tree.ok) return { ok: true, sha: head.out, dirty: true }
        const commit = gitIn(lane.path, ['commit-tree', tree.out, '-p', head.out, '-m', 'queue snapshot'], env)
        if (!commit.ok) return { ok: true, sha: head.out, dirty: true }
        return { ok: true, sha: commit.out, dirty: true }
    } finally {
        try { fs.rmSync(indexFile, { force: true }) } catch { /* nothing to clean */ }
    }
}

/**
 * Each lane's work as it would sit on top of the integration branch.
 *
 * THE CORRECTION THAT MATTERS. Comparing two lanes directly makes git pick
 * *their* common ancestor, which is older than the branch either was cut from
 * when they were cut at different times. Every integration-branch commit
 * between that ancestor and each lane then reads as a change the lane made, and
 * two lanes are reported as colliding in files neither has touched.
 *
 * Merging each onto the integration branch first gives two commits that share
 * it as a parent, so the comparison is between the lanes' own work and nothing
 * else.
 */
const ontoBase = (repo, baseSha, snapshot) => {
    const merged = gitIn(repo, ['merge-tree', '--write-tree', baseSha, snapshot])
    if (!merged.ok) return null
    const tree = merged.out.split('\n')[0]
    const commit = gitIn(repo, ['commit-tree', tree, '-p', baseSha, '-m', 'queue base'])
    return commit.ok ? commit.out : null
}

/**
 * Conflicted paths between two lanes, or an empty list.
 *
 * THE EXIT CODE IS THE VERDICT — 0 clean, 1 conflicted. `--quiet` looks like
 * the cheap way to ask and is documented as such, but it has been observed to
 * exit 0 on a conflicted merge, which suppresses the signal along with the
 * output. Ask for the full answer and read the code.
 *
 * The output has three sections: the tree object, then the conflicted paths,
 * then git's own commentary — separated by a blank line. Taking "everything
 * after the first line" swallows the commentary into the file list, which is
 * how "Auto-merging backend/app/config.py" came to be reported as a path.
 */
const collisionBetween = (repo, a, b) => {
    const result = gitIn(repo, ['merge-tree', '--write-tree', '--name-only', a, b])
    if (result.code === 0) return []
    const lines = result.out.split('\n').slice(1)
    const end = lines.indexOf('')
    return (end === -1 ? lines : lines.slice(0, end)).filter(Boolean)
}

/** Undirected components over the collision edges — union-find, no ordering implied. */
const componentsOf = (names, edges) => {
    const parent = new Map(names.map((name) => [name, name]))
    const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
    const union = (x, y) => { const a = find(x), b = find(y); if (a !== b) parent.set(a, b) }
    for (const [a, b] of edges) union(a, b)
    const groups = new Map()
    for (const name of names) {
        const root = find(name)
        if (!groups.has(root)) groups.set(root, [])
        groups.get(root).push(name)
    }
    return [...groups.values()]
}

/**
 * The whole picture: what each lane is, what it collides with, and what to do.
 *
 * THE EXPENSIVE LANE GOES FIRST. The number of collisions is the same in every
 * order — each pair has a second and the second pays — so what the order buys
 * is *which* green survives. Landing the cheap lane first voids the expensive
 * lane's run and buys back a cheap one; the other way round costs less.
 */
export const planQueue = (repo, laneList, config) => {
    const baseSha = gitIn(repo, ['rev-parse', config.integrationBranch]).out

    const entries = []
    for (const lane of laneList) {
        const snapshot = snapshotOf(lane)
        if (!snapshot.ok) {
            entries.push({ ...lane, verdict: 'parked', why: snapshot.why, tier: null, collisions: [] })
            continue
        }

        const files = gitIn(repo, ['diff', '--name-only', `${baseSha}...${snapshot.sha}`])
        const changed = files.ok ? files.out.split('\n').filter(Boolean) : []
        const { tier, seam, why } = tierFor(changed, config)
        const ahead = gitIn(repo, ['rev-list', '--count', `${baseSha}..${snapshot.sha}`])
        const merged = ontoBase(repo, baseSha, snapshot.sha)

        entries.push({
            ...lane,
            snapshot: snapshot.sha,
            dirty: snapshot.dirty,
            files: changed,
            tier, seam, why,
            ahead: ahead.ok ? Number(ahead.out) : 0,
            merged,
            appliesToBase: merged !== null,
            green: greenFor({ branch: lane.branch ?? lane.name, sha: snapshot.sha, tier, worktree: lane.path }, repo),
            collisions: []
        })
    }

    // Pairwise collisions, bounded — the cost is quadratic and the value is not.
    const usable = entries.filter((entry) => entry.merged)
    const edges = []
    let pairs = 0
    for (let i = 0; i < usable.length && pairs < MAX_PAIRS; i++) {
        for (let j = i + 1; j < usable.length && pairs < MAX_PAIRS; j++) {
            pairs++
            const paths = collisionBetween(repo, usable[i].merged, usable[j].merged)
            if (!paths.length) continue
            usable[i].collisions.push({ lane: usable[j].name, paths })
            usable[j].collisions.push({ lane: usable[i].name, paths })
            edges.push([usable[i].name, usable[j].name])
        }
    }

    const groups = componentsOf(usable.map((entry) => entry.name), edges)
    const order = new Map()
    for (const group of groups) {
        const ranked = group
            .map((name) => entries.find((entry) => entry.name === name))
            .sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0) || b.ahead - a.ahead || a.name.localeCompare(b.name))
        ranked.forEach((entry, index) => order.set(entry.name, { position: index, of: ranked.length }))
    }

    for (const entry of entries) {
        if (entry.verdict === 'parked') continue
        const place = order.get(entry.name) ?? { position: 0, of: 1 }
        entry.position = place.position
        entry.independent = place.of === 1

        if (!entry.appliesToBase) { entry.verdict = 'rebase first'; continue }
        if (entry.dirty) { entry.verdict = 'commit first'; continue }
        if (place.position > 0) { entry.verdict = 'hold the gate'; continue }
        entry.verdict = entry.green ? 'land now' : 'gate now'
    }

    return { base: config.integrationBranch, baseSha, entries }
}

/**
 * Why this lane may not be merged right now.
 *
 * The one list `land` acts on, so the refusal a person reads is the refusal the
 * command made. Only `order` is a prediction, so only `order` is overridable —
 * everything else is a fact about this checkout.
 */
export const landBlockers = (plan, name) => {
    const entry = plan.entries.find((candidate) => candidate.name === name)
    if (!entry) return [{ id: 'missing', why: `there is no lane called "${name}"` }]

    const blockers = []
    if (entry.verdict === 'parked') blockers.push({ id: 'parked', why: `it is ${entry.why}` })
    if (entry.dirty) blockers.push({ id: 'dirty', why: 'it has uncommitted changes, and a merge takes the branch — they would be left behind' })
    if (!entry.appliesToBase) blockers.push({ id: 'base', why: `it does not merge onto ${plan.base} — rebase it first` })
    if (!entry.green) {
        blockers.push({
            id: 'green',
            why: entry.tier
                ? `no green tier ${entry.tier} run names ${String(entry.snapshot ?? '').slice(0, 10)} — gate it`
                : 'no gate result names this commit'
        })
    }
    if (entry.position > 0) {
        const ahead = entry.collisions.map((collision) => collision.lane).join(', ')
        blockers.push({
            id: 'order',
            why: `${ahead} should land first — landing out of turn voids its green and it pays for another run`,
            overridable: true
        })
    }
    return blockers
}
