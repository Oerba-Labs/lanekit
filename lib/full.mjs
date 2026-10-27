/**
 * The full suite: when a project's whole test suite runs, and what it said (`gate.full` in lane.config.json; the owner,
 * 26 Oct 2026).
 *
 * WHY. Verifying runs the tier a change earns, and a project may make that tier cheap: homelab's `./check`, from 26 Oct,
 * runs only the selftests a change touches, plus those not already passed with identical inputs. That is a fine gate
 * and a poor guarantee, since whatever the selection misses is never run, so something has to run everything on main,
 * and the project says when. Left out, nothing here runs and nothing anywhere reads differently.
 *
 *   before-land   verifying runs the full steps too, in the lane after its tier, and `land` needs a passing full run
 *                 that names the lane's commit, from its worktree, as it needs a passing tier run (queue.mjs)
 *   after-land    `land` starts the full steps on the commit it made, detached, in a scratch copy of main, and returns
 *   nightly       `lane nightly` runs them on main's newest commit, in a scratch copy; launchd or cron starts it at `at`
 *
 * A RUN IS A RECORD LIKE A TIER'S (runs.mjs), kind `full`: its steps and their seconds, its failures with their last
 * lines, what its JUnit said (results.mjs), a slow-down against the full suite's own recent runs. A run on main is
 * recorded as main's (branch main, worktree the main checkout) in the main checkout's `.lanekit/runs`, written first as
 * `running` with its process, so `lanes` can say one is under way, and one whose process is gone stopped.
 *
 * A SCRATCH COPY, NEVER A WORKTREE, NEVER MAIN'S CHECKOUT. Main's checkout is where a person works and where `land`
 * merges, so a suite that runs for minutes there would race both. A git worktree would be found by `lanes()` and listed
 * as a lane (lanes.mjs lists every worktree whose folder starts with the checkout's name, and one elsewhere is still
 * main's business to prune). So: a `git clone --shared` in a cache folder of this machine's, which borrows main's
 * objects rather than copying them, checked out at the commit and scrubbed (`git clean -ffdx`) before each run, the
 * way a lane is made otherwise: copyOnCreate copied, linkOnCreate linked. One copy for each main checkout, and one run
 * in it at a time (a lock beside it).
 *
 * AFTER-LAND RUNS TEST MAIN'S NEWEST COMMIT ONLY (the owner, 26 Oct). Three lands in a minute used to queue three runs,
 * each waiting its turn, the last testing a main that was by then two lands old in an hour's time. Now a land that
 * finds a run under way leaves it be, and that run, when it ends, looks at main again: moved, and it runs once more on
 * main's newest, saying which lands that run stands for (`coalesced`). So one run is pending at most, and always the
 * newest. It is race-free without a queue of its own: a land merges before it starts its run, so either its run takes
 * the lock, or the run holding it sees the land's commit once it has let go (followMain).
 *
 * A FAILURE UNDOES NOTHING. After a land, main has the merge whatever the suite says; the record says it failed, and
 * `lanes` says so first, before any lane, until a run on main passes.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

import { loadConfig, PACKAGE_ROOT } from './config.mjs'
import { countsSaid, secondsSaid, testsShown } from './results.mjs'
import { listRuns, mintRunId, recordRun, slowdownLines, slowdownOf } from './runs.mjs'
import { runSteps } from './steps.mjs'

const YELLOW = '\x1b[33m'
const OFF = '\x1b[0m'

/** The project's `gate.full`, or null where it has none. */
export const fullOf = (config) => config?.gate?.full ?? null
/** What the full suite is called, in the project's words ("every selftest") or ours. */
export const fullLabelOf = (full) => (typeof full?.label === 'string' && full.label.trim()) || 'the full suite'

const isFull = (run) => run?.kind === 'full'

/** A run's record, kind `full`, from what runSteps said. `extra` (scratch, landed, log, id) is kept with it. */
export const fullRecordOf = ({ why, full, branch, sha, worktree, began, ended, steps, failures, tests, id, ...extra }) => ({
    id: id ?? mintRunId('full'),
    kind: 'full',
    why,
    label: fullLabelOf(full),
    branch,
    sha,
    worktree,
    ...extra,
    result: failures.length ? 'failed' : 'passed',
    startedAt: new Date(began).toISOString(),
    durationSeconds: Math.round((ended - began) / 1000),
    steps,
    failures,
    ...(tests ? { tests } : {})
})

/**
 * The passing full run that lets this lane land at this commit, as greenFor (runs.mjs) is the passing tier run: the same
 * branch, the same commit, from the same worktree. Any tier: the full suite is the full suite.
 */
export const fullGreenFor = ({ branch, sha, worktree }, cwd = process.cwd()) =>
    listRuns(cwd).find((run) =>
        isFull(run) &&
        run.result === 'passed' &&
        run.branch === branch &&
        run.sha === sha &&
        (!run.worktree || !worktree || run.worktree === worktree)) ?? null

/** Whether a process this machine started is still there: a run left `running` by one that is gone has stopped. */
const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
/** A run's result as it stands: `running` only while its process is, else `stopped`. */
const resultNow = (run) => (run.result !== 'running' ? run.result
    : run.host && run.host !== os.hostname() ? 'running' : alive(run.pid) ? 'running' : 'stopped')

/** What `lanes` and the page are given of a full run. */
const shownOf = (run, headSha) => ({
    id: run.id,
    result: resultNow(run),
    why: run.why ?? null,
    sha: run.sha ?? null,
    short: String(run.sha ?? '').slice(0, 7),
    current: run.sha === headSha,
    at: Date.parse(run.startedAt) || null,
    seconds: run.durationSeconds ?? null,
    landed: run.landed ?? null,
    coalesced: run.coalesced ?? [],
    log: run.log ?? null,
    failures: (run.failures ?? []).map((failure) => ({
        what: failure.what, status: failure.status,
        tail: String(failure.tail ?? '').split('\n').slice(-12).join('\n')
    })),
    ...(run.tests ? { tests: testsShown(run.tests) } : {})
})

/** A lane's newest full run (before-land), from its worktree, and whether it names the commit there now. */
export const laneFullOf = (runs, branch, worktree, headSha) => {
    const run = runs.find((candidate) => isFull(candidate) && candidate.branch === branch &&
        (!candidate.worktree || candidate.worktree === worktree))
    return run ? shownOf(run, headSha) : null
}

/** A nightly run that has not run for this long is overdue: a night missed, and most of a day more. */
export const OVERDUE_HOURS = 36

/**
 * Main's full suite as `lanes` says it, for a project whose full suite runs on main (nightly, after-land): null for one
 * without, or before-land, where each lane has its own. `{ when, at, label, running, last, stopped, overdue, installed }`:
 * `running` the run under way, `last` the newest that passed or failed, `stopped` one since whose process went, each
 * with `behind`, how many commits main has after the one it ran. `installed` whether this machine has its nightly job
 * (a LaunchAgent; null where that cannot be known, as with cron).
 */
export const mainFullOf = (runs, { config, mainRepo, headSha, behindOf = () => null, now = Date.now(), env = process.env }) => {
    const full = fullOf(config)
    if (!full || full.when === 'before-land') return null
    const mains = runs.filter((run) => isFull(run) && run.branch === config.integrationBranch && (!run.worktree || run.worktree === mainRepo))
    const shown = mains.map((run) => shownOf(run, headSha))
    const running = shown.find((run) => run.result === 'running') ?? null
    // The newest verdict, and a run that stopped since: a stop says nothing of main, so it never hides a failure.
    const last = shown.find((run) => run.result === 'passed' || run.result === 'failed') ?? null
    const stopped = shown.find((run) => run.result === 'stopped' && (!last || run.at > last.at)) ?? null
    for (const run of [running, last, stopped]) if (run) run.behind = run.current ? 0 : behindOf(run.sha)
    const newest = [running, last, stopped].filter(Boolean).sort((a, b) => b.at - a.at)[0] ?? null
    return {
        when: full.when,
        at: full.at ?? null,
        label: fullLabelOf(full),
        running,
        last,
        stopped,
        overdue: full.when === 'nightly' && Boolean(newest?.at) && now - newest.at > OVERDUE_HOURS * 3600 * 1000,
        installed: full.when === 'nightly' ? installedFor(config.slug, env) : null
    }
}

/** "just now", "12 minutes ago", "5 hours ago", "3 days ago". */
export const agoSaid = (at, now = Date.now()) => {
    const minutes = Math.round((now - at) / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
    const hours = Math.round(minutes / 60)
    if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`
    const days = Math.round(hours / 24)
    return `${days} day${days === 1 ? '' : 's'} ago`
}

const commitsSaid = (n) => `${n} commit${n === 1 ? '' : 's'}`
const onSaid = (run, base) => (run.current || run.behind === 0 ? `on ${base} at ${run.short}`
    : run.behind ? `on ${run.short}, ${commitsSaid(run.behind)} before ${base}'s newest` : `on ${run.short}`)
/** "b", "b and c", "a, b and c": the lands a run stands for, its own last. */
const namesSaid = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)
const landedSaid = (run) => (run.landed ? `${namesSaid([...(run.coalesced ?? []), run.landed])} landed` : run.coalesced?.length ? `${namesSaid(run.coalesced)} landed` : null)
const whySaid = (run) => (run.why === 'after-land' ? `after ${landedSaid(run) ?? 'a land'}` : run.why === 'nightly' ? 'nightly' : run.why ? run.why : null)

/**
 * Main's full suite in the words `lanes` gives an agent and `lane list` a person, a line or a few; [] where there is
 * nothing to say (no `gate.full`, or before-land). A failure is said first and in capitals, with the step, how long ago,
 * the commit and the step's last lines, since agents read `lanes` first in every session and must not miss it.
 */
export const mainFullLines = (shown, base, now = Date.now()) => {
    if (!shown) return []
    const name = `${shown.label}, ${shown.when === 'nightly' ? `nightly at ${shown.at}` : 'after each land'}`
    const again = '`lane nightly` runs it again on main now'
    const notInstalled = shown.installed === false ? '; no nightly job is installed on this machine (`lane nightly --install` shows what it writes)' : ''
    const lines = []
    const { last, running, stopped } = shown
    if (last?.result === 'failed') {
        const first = last.failures[0]
        const steps = last.failures.map((failure) => `"${failure.what}"${Number.isInteger(failure.status) && failure.status >= 0 ? ` exited ${failure.status}` : ' could not run'}`).join(', ')
        lines.push(`FULL SUITE FAILED ${onSaid(last, base)} (${[whySaid(last), last.at ? agoSaid(last.at, now) : null].filter(Boolean).join(', ')}): ${steps}.` +
            `${last.tests?.said ? ` Tests: ${last.tests.said}${last.tests.failing.length ? `; ${last.tests.failing.map((test) => `${test.outcome} ${test.name}`).join(', ')}` : ''}.` : ''}` +
            ` ${base} is not known to pass ${shown.label}: fix it in a lane; ${again}.${last.log ? ` Its output: ${last.log}` : ''}`)
        const tail = String(first?.tail ?? '').split('\n').filter((line) => line.trim()).slice(-5)
        for (const line of tail) lines.push(`    ${line}`)
    } else if (last?.result === 'passed') {
        lines.push(`Full suite (${name}): passed ${onSaid(last, base)}, ${agoSaid(last.at, now)}${Number.isFinite(last.seconds) ? `, in ${secondsSaid(last.seconds)}` : ''}${last.tests?.said ? ` (${last.tests.said})` : ''}.`)
    }
    if (stopped) lines.push(`Full suite (${name}): the run ${onSaid(stopped, base)} begun ${agoSaid(stopped.at, now)} stopped before it finished (its process is gone); ${again}.`)
    // Main moved on while it ran, by lands whose own runs it stands in for: said as the run to come, so those lands'
    // commits read as covered, not missing; nothing is recorded for it until it begins, so it never hides a failure.
    const next = shown.when === 'after-land' && running?.behind ? `; ${base}'s newest commit runs when it ends` : ''
    if (running) lines.push(`Full suite (${name}): running ${onSaid(running, base)} since ${agoSaid(running.at, now)}${running.why === 'after-land' && landedSaid(running) ? `, after ${landedSaid(running)}` : ''}${next}.`)
    if (!last && !running && !stopped) lines.push(`Full suite (${name}): no run on ${base} yet; \`lane nightly\` runs one now${notInstalled}.`)
    else if (shown.overdue) lines.push(`FULL SUITE OVERDUE: it runs nightly at ${shown.at}, and the newest run began ${agoSaid([running, last, stopped].filter(Boolean).sort((a, b) => b.at - a.at)[0].at, now)}${notInstalled || '; is this machine asleep at that hour, or its job gone?'} ${again}.`)
    else if (shown.when === 'after-land' && last && !running && last.behind) lines.push(`  ${base}'s newest commit has no full run of its own: it did not come by \`lane land\`; ${again}.`)
    return lines
}

/** A lane's full suite (before-land) as a fact of `lanes`: whether a passing one names its commit, which a land needs. */
export const laneFullSaid = (full, label) => {
    if (!full?.current) return `no full run (${label}) on this commit: a land needs one, and verify runs it`
    if (full.result === 'passed') return `${label} passed on this commit`
    if (full.result === 'failed') return `${label} FAILED on this commit: ${full.failures.map((failure) => `"${failure.what}"`).join(', ')}${full.tests?.said ? ` (${full.tests.said})` : ''}`
    return `${label} ${full.result} on this commit`
}

// ---------------------------------------------------------------------------
// the scratch copy, and a run on main
// ---------------------------------------------------------------------------

/** What platform a schedule is written for: this machine's, or LANEKIT_PLATFORM's (tests write a LaunchAgent on Linux). */
export const platformOf = (env = process.env) => env.LANEKIT_PLATFORM || process.platform

/** This machine's cache folder for lanekit: LANEKIT_CACHE, else the platform's own. Nothing in it is anybody's work. */
export const cacheRoot = (env = process.env) => env.LANEKIT_CACHE ||
    (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches', 'lanekit')
        : path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'lanekit'))

/** The scratch copy of one main checkout: named for its project and, so two clones of one never share, its path. */
export const scratchFor = (mainRepo, slug, env = process.env) =>
    path.join(cacheRoot(env), 'full', `${slug}-${crypto.createHash('sha256').update(mainRepo).digest('hex').slice(0, 8)}`)

const gitIn = (cwd, args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

/**
 * The scratch copy at `sha`, as clean as a fresh clone: made the first time (`git clone --shared --no-checkout`, which
 * borrows main's objects, so main's newest commit is there without a fetch), then checked out and scrubbed every time,
 * and given what a lane would be: copyOnCreate copied, linkOnCreate linked, from the main checkout. Throws with git's
 * words where it cannot.
 */
export const readyScratch = ({ mainRepo, dir, sha, config }) => {
    if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(path.dirname(dir), { recursive: true })
        const cloned = gitIn(path.dirname(dir), ['clone', '--quiet', '--shared', '--no-checkout', mainRepo, dir])
        if (!cloned.ok) throw new Error(`git clone --shared of ${mainRepo} into ${dir} failed: ${cloned.err}`)
    }
    const checked = gitIn(dir, ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--force', '--detach', sha])
    if (!checked.ok) throw new Error(`could not check out ${sha.slice(0, 10)} in ${dir}: ${checked.err}`)
    const cleaned = gitIn(dir, ['clean', '-ffdxq'])
    if (!cleaned.ok) throw new Error(`could not scrub ${dir}: ${cleaned.err}`)
    if (gitIn(dir, ['rev-parse', 'HEAD']).out !== sha) throw new Error(`${dir} is not at ${sha.slice(0, 10)} after checking it out`)
    for (const rel of config.lane?.copyOnCreate ?? []) {
        const from = path.join(mainRepo, rel)
        if (!fs.existsSync(from)) continue
        const to = path.join(dir, rel)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        if (fs.statSync(from).isDirectory()) fs.cpSync(from, to, { recursive: true }); else fs.copyFileSync(from, to)
    }
    for (const rel of config.lane?.linkOnCreate ?? []) {
        const from = path.join(mainRepo, rel)
        const to = path.join(dir, rel)
        if (!fs.existsSync(from) || fs.existsSync(to)) continue
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.symlinkSync(from, to)
    }
}

/** The lock beside a scratch copy: taken, or `{ held }` by a run whose process is still there. A dead one's is taken over. */
const lock = (file, about) => {
    for (let tries = 0; tries < 5; tries++) {
        try {
            fs.writeFileSync(file, JSON.stringify(about), { flag: 'wx' })
            return { taken: true }
        } catch (error) {
            if (error.code !== 'EEXIST') throw error
        }
        let held = null
        try { held = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* half written, or gone: looked at again */ }
        if (held && alive(held.pid)) return { taken: false, held }
        fs.rmSync(file, { force: true })
    }
    return { taken: false, held: null }
}

const POLL_MS = Number(process.env.LANEKIT_FULL_POLL_MS) || 5000

/**
 * Run the full suite on main at `sha` (main's newest commit where none is given) in its scratch copy, and record it in
 * the main checkout's runs. `why` is nightly or after-land; `landed` the lane an after-land run follows, `coalesced` the
 * lands before it whose own runs this one stands for. Resolves to `{ record }`, or `{ skipped }` (main's commit passed
 * already, unless `force`; with `settled`, failed already too: followMain runs a commit once), `{ busy }` (another run
 * holds the copy and `wait` was not asked), or `{ refused }` (no `gate.full`). Whether it was run already is asked again
 * once the lock is taken: the run that held it may have been of this very commit.
 *
 * THE RECORD GOES TO THE MAIN CHECKOUT, by its path: runs.mjs finds the runs folder from the folder it is asked about,
 * and asked about the scratch copy, a clone of its own, it would write into the copy and the next scrub would take it.
 */
export const runFullOnMain = async ({ mainRepo, config, sha, why = 'nightly', landed = null, coalesced = [], force = false, settled = false, wait = false, logFile = null, log, env = process.env }) => {
    const full = fullOf(config)
    const base = config.integrationBranch
    if (!full) return { refused: `${config.file ?? 'lane.config.json'} has no gate.full: nothing says what the full suite is` }
    const at = sha ?? gitIn(mainRepo, ['rev-parse', base]).out
    if (!/^[0-9a-f]{40,64}$/.test(at)) return { refused: `${base} does not name a commit in ${mainRepo}` }
    const passedAlready = () => (force ? null : listRuns(mainRepo).find((run) => isFull(run) && run.sha === at &&
        (run.result === 'passed' || (settled && run.result === 'failed'))) ?? null)

    let passed = passedAlready()
    if (passed) return { skipped: passed }

    const dir = scratchFor(mainRepo, config.slug, env)
    fs.mkdirSync(path.dirname(dir), { recursive: true })
    const lockFile = `${dir}.lock`
    let taken = lock(lockFile, { pid: process.pid, sha: at, why, at: new Date().toISOString() })
    if (!taken.taken && !wait) return { busy: taken.held }
    if (!taken.taken) {
        log(`waiting for the full run under way in ${dir}${taken.held ? ` (process ${taken.held.pid}, on ${String(taken.held.sha).slice(0, 7)})` : ''} to end`)
        while (!taken.taken) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS))
            taken = lock(lockFile, { pid: process.pid, sha: at, why, at: new Date().toISOString() })
        }
    }
    passed = passedAlready()
    if (passed) { fs.rmSync(lockFile, { force: true }); return { skipped: passed } }

    const began = Date.now()
    const id = mintRunId('full')
    const kept = { scratch: dir, ...(landed ? { landed } : {}), ...(coalesced.length ? { coalesced } : {}), ...(logFile ? { log: logFile } : {}) }
    const shared = { id, why, full, branch: base, sha: at, worktree: mainRepo, ...kept }
    try {
        // Under way, written down first: `lanes` says so, and says it stopped if this process goes before it ends.
        recordRun({ id, kind: 'full', why, label: fullLabelOf(full), branch: base, sha: at, worktree: mainRepo, ...kept,
            result: 'running', pid: process.pid, host: os.hostname(), startedAt: new Date(began).toISOString() }, mainRepo)
        let ran
        let steps = full.steps
        let stepsConfig = config
        try {
            log(`a scratch copy of ${base} at ${at.slice(0, 10)}, in ${dir}`)
            try {
                readyScratch({ mainRepo, dir, sha: at, config })
            } catch (error) {
                // A copy that git can no longer use (a run killed part-way through a checkout, a folder tidied by hand)
                // is the cache's, not anybody's work: made again once, from nothing, before it is called a failure.
                log(`${YELLOW}the scratch copy could not be readied (${error.message.split('\n')[0]}): making it again${OFF}`)
                fs.rmSync(dir, { recursive: true, force: true })
                readyScratch({ mainRepo, dir, sha: at, config })
            }
            // The commit's own steps, as a lane's verifying reads the lane's config: what main says the full suite is.
            try {
                const own = loadConfig(dir)
                if (fullOf(own)) { stepsConfig = own; steps = fullOf(own).steps }
            } catch (error) {
                log(`${YELLOW}the commit's own lane.config.json could not be read (${error.message.split('\n')[0]}): the main checkout's steps are run${OFF}`)
            }
            log(`full suite: ${fullLabelOf(fullOf(stepsConfig) ?? full)}`)
            ran = await runSteps(steps, { repo: dir, config: stepsConfig, log })
        } catch (error) {
            ran = { steps: [], failures: [{ what: 'making a scratch copy of main to run it in', status: -1, tail: error.message }], tests: null }
        }
        const record = fullRecordOf({ ...shared, began, ended: Date.now(), ...ran })
        try {
            const slowdown = slowdownOf(record, listRuns(mainRepo))
            if (slowdown) {
                record.slowdown = slowdown
                const [first, ...rest] = slowdownLines(slowdown, 'the full suite')
                log(`${YELLOW}${first}${OFF}`)
                for (const line of rest) console.log(line)
            }
        } catch (error) {
            log(`${YELLOW}could not compare this run's time with the runs before it: ${error.message}${OFF}`)
        }
        log('recording the result…')
        recordRun(record, mainRepo)
        return { record }
    } finally {
        fs.rmSync(lockFile, { force: true })
    }
}

/**
 * What a finished run on main says, for a terminal and the log: a line, and the failures' steps where it failed.
 */
export const fullResultLines = (record, base) => {
    const counts = record.tests ? countsSaid(record.tests) : null
    const said = `${record.label} ${record.result} on ${base} at ${record.sha.slice(0, 10)}, in ${secondsSaid(record.durationSeconds)}${counts ? ` (${counts})` : ''}`
    return record.result === 'passed' ? [said] : [said, ...record.failures.map((failure) => `  failed: ${failure.what}`)]
}

/** The lane a land merged, from the merge's subject (`lane land` merges as "Merge branch 'name'"), or null. */
const landedBy = (subject) => /^Merge branch '([^']+)'/.exec(subject ?? '')?.[1] ?? null

/**
 * Main's newest commit run, and run again while main moves on (after-land; the owner, 26 Oct): what a land's own process
 * does, and `lane nightly` after its run, in a project whose full suite runs after each land. Each turn runs main's
 * newest commit if no run of it has a verdict yet; a run under way leaves this process with nothing to do (`busy`),
 * since that run looks at main again once it has let the lock go, and this land's commit is on main by then. Stops when
 * main's newest has a verdict. `landed` names the lane of `landedSha`; any other commit's lane is read from its merge,
 * and the lands since the newest run on main before it are the ones its run stands for (`coalesced`), so a land that
 * got no run of its own is named in the one that covered it. `ended(record)` as each run ends.
 * Resolves to `{ records, busy, refused }`.
 */
export const followMain = async ({ mainRepo, config, landed = null, landedSha = null, logFile = null, log, ended = () => {}, env = process.env }) => {
    const base = config.integrationBranch
    const records = []
    for (let turn = 0; turn < 100; turn++) {
        const newest = gitIn(mainRepo, ['rev-parse', base]).out
        const mains = listRuns(mainRepo).filter((run) => isFull(run) && run.branch === base && (!run.worktree || run.worktree === mainRepo))
        if (mains.some((run) => run.sha === newest && (run.result === 'passed' || run.result === 'failed'))) break
        // The lands since the newest run before this commit: every first-parent merge after it, up to this one.
        const before = mains.find((run) => run.sha !== newest && gitIn(mainRepo, ['merge-base', '--is-ancestor', run.sha, newest]).ok)
        const merges = before ? gitIn(mainRepo, ['log', '--first-parent', '--format=%H %s', `${before.sha}..${newest}`]).out.split('\n').filter(Boolean)
            .map((line) => ({ sha: line.slice(0, line.indexOf(' ')), lane: landedBy(line.slice(line.indexOf(' ') + 1)) })) : []
        const own = newest === landedSha ? landed : landedBy(gitIn(mainRepo, ['log', '-1', '--format=%s', newest]).out)
        const coalesced = merges.filter((merge) => merge.sha !== newest && merge.lane).map((merge) => merge.lane).reverse()
        const done = await runFullOnMain({ mainRepo, config, sha: newest, why: 'after-land', landed: own, coalesced, settled: true, logFile, log, env })
        if (done.refused) return { records, refused: done.refused }
        if (done.busy) return { records, busy: done.busy }
        if (done.skipped) break
        records.push(done.record)
        ended(done.record)
        if (newest !== gitIn(mainRepo, ['rev-parse', base]).out) log(`${base} moved on while it ran: once more, on its newest commit`)
    }
    return { records }
}

/**
 * After a land (after-land): the full suite started on main by itself, and left running. `land` returns at once, which
 * matters most where it is called with a deadline (the MCP land tool, the page): the run goes on in a process of its
 * own (detached, its own process group, so stopping the land's job stops nothing of it), writing to a log file and never
 * to the land's own output, whose end a caller is waiting for. That process follows main (followMain): it runs main's
 * newest commit, or leaves a run under way to. `{ pid, log }`.
 */
export const LOGS_KEPT = 20
export const startAfterLand = ({ mainRepo, config, sha, landed, node = process.execPath, kit = PACKAGE_ROOT, env = process.env }) => {
    const logs = `${scratchFor(mainRepo, config.slug, env)}-logs`
    fs.mkdirSync(logs, { recursive: true })
    const old = fs.readdirSync(logs).filter((name) => name.startsWith('after-land-')).sort()
    for (const name of old.slice(0, Math.max(0, old.length - (LOGS_KEPT - 1)))) fs.rmSync(path.join(logs, name), { force: true })
    const logFile = path.join(logs, `after-land-${new Date().toISOString().replace(/[:.]/g, '-')}-${sha.slice(0, 10)}.log`)
    const out = fs.openSync(logFile, 'a')
    try {
        const child = spawn(node, [path.join(kit, 'dev', 'full.mjs'), '--why', 'after-land', '--sha', sha, '--landed', landed, '--log', logFile], {
            cwd: mainRepo, detached: true, stdio: ['ignore', out, out], env
        })
        child.unref()
        return { pid: child.pid, log: logFile }
    } finally {
        fs.closeSync(out)
    }
}

// ---------------------------------------------------------------------------
// the nightly schedule: a LaunchAgent on a Mac, a crontab line elsewhere
// ---------------------------------------------------------------------------

/** Where LaunchAgents are: the person's own, unless LANEKIT_LAUNCH_AGENTS names another (the tests' scratch folder). */
export const launchAgentsDir = (env = process.env) => env.LANEKIT_LAUNCH_AGENTS || path.join(os.homedir(), 'Library', 'LaunchAgents')
/** Whether a LaunchAgent written there is one launchd reads: only the person's own folder is. */
export const isRealLaunchAgents = (env = process.env) => !env.LANEKIT_LAUNCH_AGENTS
export const labelFor = (slug) => `dev.lanekit.nightly.${slug}`
export const plistPathFor = (slug, env = process.env) => path.join(launchAgentsDir(env), `${labelFor(slug)}.plist`)
const installedFor = (slug, env) => (platformOf(env) === 'darwin' ? fs.existsSync(plistPathFor(slug, env)) : null)

/** The first `name` on `PATH` that can be run, as the shell finds it: the link, not what it points at. */
const onPath = (name, pathVar) => {
    for (const dir of String(pathVar ?? '').split(path.delimiter).filter(Boolean)) {
        const file = path.join(dir, name)
        try { fs.accessSync(file, fs.constants.X_OK); return file } catch { /* not here */ }
    }
    return null
}

/**
 * The node a job would run, when it belongs to a version manager: `{ manager, version }` (version null for a shim, which
 * runs whichever node the manager picks then), or null. The job runs that file every night, by its path, so it breaks
 * when the manager switches that version out or removes it (nvm uninstall), or its shell's link goes (fnm's
 * multishells), and nothing says so until `lanes` finds the runs overdue. Said, not mended (the owner, 26 Oct): picking
 * another node quietly would run the suite on one lanekit was never tested on (this Mac's Homebrew node is 26).
 */
export const nodeManagerOf = (file) => {
    const at = String(file ?? '')
    for (const [manager, pattern] of [
        ['nvm', /\/\.nvm\/versions\/node\/([^/]+)\//],
        ['fnm', /\/fnm\/node-versions\/([^/]+)\//],
        ['fnm', /\/fnm_multishells\/()/],
        ['volta', /\/\.volta\/(?:tools\/image\/node\/([^/]+)\/|bin\/)/],
        ['asdf', /\/\.asdf\/(?:installs\/nodejs\/([^/]+)\/|shims\/)/],
        ['mise', /\/mise\/(?:installs\/node\/([^/]+)\/|shims\/)/],
        ['nodenv', /\/\.nodenv\/(?:versions\/([^/]+)\/|shims\/)/]
    ]) {
        const found = pattern.exec(at)
        if (found) return { manager, version: found[1] || null }
    }
    return null
}

/** What --install says of a node of a version manager's: plainly, that the job breaks with it, and what then says so. */
export const nodeWarningLines = (file) => {
    const of = nodeManagerOf(file)
    if (!of) return []
    return [
        `NOTE: the job runs ${file}, ${of.version ? `${of.manager}'s node ${of.version}` : `a shim of ${of.manager}'s`}.`,
        `It breaks when ${of.manager} switches that ${of.version ? 'version' : 'node'} out or removes it: no night's run starts after that,`,
        `and lanes says FULL SUITE OVERDUE a day and a half later. lanekit picks no other node for you; to name`,
        `one that stays put, put its folder first on the PATH and run --install again.`
    ]
}

/**
 * Why `kit` cannot be the lanekit a schedule names, or null: `{ why, instead }`. The plist (or crontab line) runs
 * <kit>/dev/full.mjs every night by its path, so a kit that goes away takes the job with it, silently, until `lanes`
 * finds the runs overdue (the owner, 26 Oct). A lane's checkout is such a kit: a lanekit worktree that is not its main
 * checkout (`node ../lanekit-<lane>/dev/lane.mjs nightly --install`, trying a lane's commands by hand) is removed by
 * sweep once the lane lands, and a lanekit inside some lane of a project's goes with that lane. `instead` is the main
 * checkout's lanekit, the one the shim finds (../lanekit before ~/.lanekit; beside a lane of lanekit, its main checkout:
 * lane.config.json's note). A scratch copy of main's, in the cache, is checked out afresh by every full run.
 */
export const kitRefusal = (kit, env = process.env) => {
    const at = path.resolve(kit)
    const cache = path.resolve(cacheRoot(env))
    if (at === cache || at.startsWith(`${cache}${path.sep}`)) {
        return { why: `${at} is in lanekit's cache, a scratch copy that each full run checks out afresh`, instead: null }
    }
    const dirs = gitIn(at, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-prefix'])
    if (!dirs.ok) return null
    const [gitDir, common, prefix = ''] = dirs.out.split('\n')
    if (path.resolve(gitDir) === path.resolve(common)) return null
    const listed = gitIn(at, ['worktree', 'list', '--porcelain']).out.split('\n').find((line) => line.startsWith('worktree '))
    const main = listed ? listed.slice('worktree '.length) : path.dirname(common)
    const top = gitIn(at, ['rev-parse', '--show-toplevel']).out
    return {
        why: `${at === top ? at : `${at} is in ${top}, which`} is a worktree of ${main}, not its main checkout: a lane's, which sweep removes once it lands`,
        instead: path.resolve(main, prefix)
    }
}

/** Whether an answer is yes: y or yes, in any case. Anything else, an empty line and no answer at all included, is no. */
export const isYes = (answer) => /^\s*y(es)?\s*$/i.test(String(answer ?? ''))

/**
 * Ask a yes-or-no question at a terminal and wait for the answer: true only for yes. Streams may be given (the tests'),
 * so the question is asked of something that can answer it; input that ends unanswered is a no.
 */
export const askYes = (question, { input = process.stdin, output = process.stdout } = {}) => new Promise((resolve) => {
    const asking = readline.createInterface({ input, output, terminal: Boolean(output.isTTY) })
    let answered = false
    asking.on('close', () => { if (!answered) { output.write('\n'); resolve(false) } })
    asking.question(question, (answer) => {
        answered = true
        asking.close()
        resolve(isYes(answer))
    })
})

/**
 * What the job runs, and with what PATH: as the project's shim runs lanekit, `node` from the PATH, and here the PATH of
 * whoever installs it. launchd starts a job with /usr/bin:/bin:/usr/sbin:/sbin and nothing else, where Homebrew's node
 * is not, nor whatever a project's steps call (docker, python3); so the job carries the PATH it was installed from,
 * and node by the link the shell finds (/opt/homebrew/bin/node), which outlives an upgrade, rather than the binary it
 * points at today.
 *
 * IN THE INSTALLER'S ORDER, node's and git's folders after it only where it lacks them. Put first, they moved
 * /usr/bin (git's, on a Mac) ahead of Homebrew, and the job's python3 was Apple's 3.9 where the shell's was 3.14:
 * homelab's first night failed six selftests that pass (27 Oct). The job asks for every program as the shell would.
 */
export const jobFor = ({ mainRepo, config, kit = PACKAGE_ROOT, env = process.env, node = process.execPath }) => {
    const full = fullOf(config)
    const [hour, minute] = String(full?.at ?? '03:00').split(':').map(Number)
    const nodeFile = onPath('node', env.PATH) ?? node
    const gitFile = onPath('git', env.PATH)
    const dirs = [...String(env.PATH ?? '').split(path.delimiter), path.dirname(nodeFile), gitFile ? path.dirname(gitFile) : null, '/usr/bin', '/bin', '/usr/sbin', '/sbin']
        .filter((dir) => dir && path.isAbsolute(dir) && fs.existsSync(dir))
    const pathVar = [...new Set(dirs)].join(path.delimiter)
    const log = path.join(`${scratchFor(mainRepo, config.slug, env)}-logs`, 'nightly.log')
    return {
        label: labelFor(config.slug), hour, minute, pathVar, log, mainRepo, kit, node: nodeFile,
        args: [nodeFile, path.join(kit, 'dev', 'full.mjs'), '--why', 'nightly', '--log', log]
    }
}

const xml = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** The LaunchAgent for a job: run at its hour and minute, local time, in the main checkout, writing to its log. */
export const plistFor = (job) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${xml(job.label)}</string>
    <key>ProgramArguments</key>
    <array>
${job.args.map((arg) => `        <string>${xml(arg)}</string>`).join('\n')}
    </array>
    <key>WorkingDirectory</key>
    <string>${xml(job.mainRepo)}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${xml(job.pathVar)}</string>
    </dict>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>${job.hour}</integer>
        <key>Minute</key>
        <integer>${job.minute}</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(job.log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(job.log)}</string>
</dict>
</plist>
`

const shellQuoted = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`
/** The same job as a crontab line, for a person to add: lanekit never edits a crontab. */
export const cronLineFor = (job) => `${job.minute} ${job.hour} * * * cd ${shellQuoted(job.mainRepo)} && mkdir -p ${shellQuoted(path.dirname(job.log))} && ` +
    `PATH=${shellQuoted(job.pathVar)} ${job.args.map(shellQuoted).join(' ')} >> ${shellQuoted(job.log)} 2>&1`
