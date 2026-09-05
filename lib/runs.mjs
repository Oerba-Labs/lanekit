/**
 * What a gate run was, written down so something else can ask later.
 *
 * A GATE RESULT NAMES A SHA. That is the whole reason this exists rather than
 * the gate simply printing and exiting: `land` has to answer "is there a green
 * run for exactly this commit", and a person's memory of having run it is not
 * an answer. The moment anything else lands, a green run against the old sha is
 * void, and only a record can say so.
 *
 * POOLED IN THE MAIN CHECKOUT, not per lane. Runs are resolved through git's
 * *common* directory, so every lane's runs land in one history. A lane writing
 * into its own directory loses the history when the lane is swept, which is
 * exactly when you want to know what it ran.
 */

import fs from 'node:fs'
import path from 'node:path'

import { mainRepoFrom } from './lanes.mjs'

export const runsDirFor = (cwd = process.cwd()) =>
    path.join(mainRepoFrom(cwd), '.lanekit', 'runs')

/**
 * An id that sorts chronologically and cannot collide.
 *
 * Seconds are not enough on their own — two runs started in the same second
 * overwrite each other, and the one that survives is not the one you read the
 * banner for. The pid disambiguates.
 */
export const mintRunId = (kind) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z')
    return `${stamp}-${process.pid}-${kind}`
}

export const recordRun = (record, cwd = process.cwd()) => {
    const dir = runsDirFor(cwd)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${record.id}.json`)
    fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n')
    return file
}

export const listRuns = (cwd = process.cwd()) => {
    const dir = runsDirFor(cwd)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
        .filter((name) => name.endsWith('.json'))
        .sort()
        .reverse()
        .map((name) => {
            try {
                return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
            } catch {
                return null
            }
        })
        .filter(Boolean)
}

/**
 * The run that licenses merging this branch at this commit, if there is one.
 *
 * FIVE CONDITIONS, and every one of them has a way of being quietly wrong:
 * a failed run is not a green; a narrowed run vouches only for what it ran; a
 * run at a lower tier than the diff earns did not cover the diff; a run against
 * a different commit is about different code; and a run from another worktree
 * tested another tree. The last two are the ones people argue with, and they
 * are the ones that matter — a rebase changes the sha, and a sha is the only
 * thing tying a result to a tree.
 */
export const greenFor = ({ branch, sha, tier, worktree }, cwd = process.cwd()) =>
    listRuns(cwd).find((run) =>
        run.result === 'passed' &&
        !run.narrowed &&
        run.branch === branch &&
        run.sha === sha &&
        run.tier >= tier &&
        (!run.worktree || !worktree || run.worktree === worktree)) ?? null
