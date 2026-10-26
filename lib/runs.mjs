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
import { grownSaid, secondsSaid, slowestOf, testsGrown } from './results.mjs'

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

/**
 * The run a gate begun at `since` (ms) in `worktree` wrote, or null where it wrote none (it refused before running
 * anything: a dirty tree, a rebase that conflicts). The newest such run, so a gate is never told an older one's result.
 */
export const runSince = (worktree, since, cwd = worktree) =>
    listRuns(cwd).find((run) =>
        (!run.worktree || run.worktree === worktree) && (Date.parse(run.startedAt) || 0) >= since) ?? null

/**
 * A gate that has got much slower, said by the run that finds it.
 *
 * WHY. homelab's gate took about 25s on 11 Oct 2026 and about 1,100s on 25 Oct, and nobody noticed: every run passed,
 * and each record kept its own duration and nothing compared it with the last. A slow-down that creeps in one landing at
 * a time is never anybody's change to look at, so the run that crosses the line says so, while what changed is fresh.
 *
 * THE RULE (asked for 25 Oct 2026). A passing run of a tier that took at least `ratio` times the median of that tier's
 * last `recent` passing runs in this repository (every lane's: runs are pooled), with `least` of them at least to go on,
 * and `seconds` longer at least, since twice a two-second gate is the machine's noise. The median, so that one run slowed
 * by a busy machine moves nothing, and so that the runs after a slow-down are each compared with what was usual until
 * the slow runs are most of the ten, when slow is what is usual and saying it again would be noise. Passing runs only:
 * a failed run may have stopped early, and a failing run is said already.
 *
 * IT NEVER FAILS THE GATE, and is never a reason to. A machine busy with other gates slows one too, and the verdict is
 * the steps' exit codes alone; this is something for a person to look at, written into the record (`slowdown`) so a page
 * can show it too.
 *
 * WHAT GREW. Compared with one usual run, the one of those runs nearest the median (of two as near, the newer), and one
 * whose tests kept their times where this run's did: its steps' seconds beside this run's, where there are several
 * steps, and the tests whose time grew most (results.mjs, testsGrown).
 */
export const SLOWDOWN = { ratio: 2, recent: 10, least: 5, seconds: 5 }
const STEP_GREW_ENOUGH = 1

const medianOf = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * The slow-down `record` shows against `runs` (listRuns, newest first; `record` itself, if among them, is passed over),
 * or null where it shows none: `{ seconds, median, runs, ratio, usual: { id, seconds, startedAt }, tests, steps }`,
 * `tests` [{ name, file?, suite?, seconds, was, since }] and `steps` [{ what, seconds, was }] what grew most.
 */
export const slowdownOf = (record, runs, rules = SLOWDOWN) => {
    if (record?.result !== 'passed' || !Number.isFinite(record.durationSeconds)) return null
    const recent = runs
        .filter((run) => run && run.id !== record.id && run.kind === record.kind && run.result === 'passed' && Number.isFinite(run.durationSeconds))
        .slice(0, rules.recent)
    if (recent.length < rules.least) return null
    const median = medianOf(recent.map((run) => run.durationSeconds))
    const seconds = record.durationSeconds
    if (seconds < rules.ratio * median || seconds - median < rules.seconds) return null

    const timed = (run) => slowestOf(run.tests).length > 0
    const nearest = recent
        .map((run, newness) => ({ run, newness, off: Math.abs(run.durationSeconds - median) }))
        .sort((a, b) => a.off - b.off || a.newness - b.newness)
        .map(({ run }) => run)
    const usual = (timed(record) && nearest.find(timed)) || nearest[0]

    const was = new Map((Array.isArray(usual.steps) ? usual.steps : []).map((step) => [step.what, step.seconds]))
    const steps = (Array.isArray(record.steps) && record.steps.length > 1 ? record.steps : [])
        .filter((step) => Number.isFinite(was.get(step.what)) && step.seconds - was.get(step.what) >= STEP_GREW_ENOUGH)
        .map((step) => ({ what: step.what, seconds: step.seconds, was: was.get(step.what) }))
        .sort((a, b) => (b.seconds - b.was) - (a.seconds - a.was))

    return {
        seconds,
        median,
        runs: recent.length,
        ratio: median > 0 ? Math.round((seconds / median) * 10) / 10 : null,
        usual: { id: usual.id, seconds: usual.durationSeconds, startedAt: usual.startedAt ?? null },
        tests: testsGrown(record.tests, usual.tests),
        steps
    }
}

const daySaid = (iso) => {
    const at = Date.parse(iso)
    return Number.isFinite(at) ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : null
}

/** "2.3 times", "44 times": how many times as long, as a person says it. */
const timesSaid = (ratio) => `${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)} times`

/**
 * The gate's lines for a slow-down: the first a sentence of its own (the gate puts it in its [verify …] style), the rest
 * what grew, and that it is not a failure.
 */
export const slowdownLines = (slowdown, tier) => {
    if (!slowdown) return []
    const { seconds, median, runs, ratio, usual } = slowdown
    const lines = [`slower than usual: this took ${secondsSaid(seconds)}, ${ratio ? `${timesSaid(ratio)} the ${secondsSaid(median)}` : `against ${secondsSaid(median)}`} ` +
        `that tier ${tier}'s last ${runs} passing runs here took at the median`]
    const against = [secondsSaid(usual.seconds), daySaid(usual.startedAt)].filter(Boolean).join(', ')
    let first = true
    const grown = (title, rows) => {
        if (!rows.length) return
        const said = rows.map((row) => row.said)
        const width = Math.max(...said.map((one) => one.length))
        lines.push(`  ${title}${first ? `, against a usual run (${against})` : ''}:`, ...rows.map((row, i) => `    ${said[i].padEnd(width)}  ${row.name}`))
        first = false
    }
    grown('steps that grew most', slowdown.steps.map((step) => ({ said: `${secondsSaid(step.was)} → ${secondsSaid(step.seconds)}`, name: step.what })))
    grown('tests that grew most', slowdown.tests.map((test) => ({ said: grownSaid(test), name: `${test.name}${test.file || test.suite ? `  (${test.file || test.suite})` : ''}` })))
    lines.push('  This does not fail verifying. A busy machine slows it too: if the next run is as slow, it is the project.')
    return lines
}
