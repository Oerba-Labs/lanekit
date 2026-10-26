/**
 * When a project's full test suite runs (`gate.full` in lane.config.json; lib/full.mjs), asked of scratch repositories:
 * the config refusing what it cannot mean; before-land, where verifying runs the full steps after the tier and a land
 * needs them passed on the lane's commit; after-land, where a land starts them on the commit it made, detached, in a
 * scratch copy of main, returns at once (through the MCP server too), and a failure undoes nothing and is said first by
 * `lanes`; `lane nightly`, on main's newest commit in a scratch copy, recorded in the main checkout's runs and skipped
 * once that commit passed; its schedule, a LaunchAgent written to and removed from a scratch folder, or a crontab line
 * printed; what `lanes` says of main's full suite in each state; and a project without `gate.full`, for which nothing
 * reads differently. And the owner's three of 26 Oct: `--install` and `--uninstall` ask "[y/N]" at a terminal (driven
 * through a pseudo-terminal, python3's pty, where there is one) and refuse without one unless `--yes`; a lane's lanekit
 * refused as the one a job names, and a version manager's node said plainly; and lands made while an after-land run is
 * under way given one run more, on main's newest commit, which names them.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing, and installs nothing: LaunchAgents go to a scratch folder, which launchd never
 * reads, and the scratch copies to a scratch cache. The schedule is installed from a copy of this lanekit in a scratch
 * repository of its own (KITS), since the lanekit under test may be a lane's, which --install refuses.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { PassThrough } from 'node:stream'
import { after, before, test } from 'node:test'

import { loadConfig } from '../lib/config.mjs'
import {
    agoSaid, askYes, cronLineFor, fullGreenFor, isYes, jobFor, kitRefusal, laneFullSaid, mainFullLines, mainFullOf, nodeManagerOf,
    plistFor, scratchFor
} from '../lib/full.mjs'
import { lanes as lanesOf } from '../lib/lanes.mjs'
import { planQueue, landBlockers } from '../lib/queue.mjs'
import { slowdownLines, slowdownOf } from '../lib/runs.mjs'
import { repoState } from '../lib/state.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
let scratch
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: '', LANEKIT_FULL_POLL_MS: '200'
}
delete env.LAB_RESULTS
// A platform whose schedule cannot be looked at (cron), unless a test says darwin: what lanes says is then the same here
// and on CI's Linux.
env.LANEKIT_PLATFORM = 'linux'
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '')
const run = (script, cwd, args, extra = {}) => {
    const done = spawnSync(process.execPath, [path.join(KIT, 'dev', script), ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
    return { code: done.status, out: plain(`${done.stdout}${done.stderr}`) }
}
const lane = (cwd, ...args) => run('lane.mjs', cwd, args)
/** `lane` as the copy of this lanekit in `kit` runs it: the schedule's tests, installing from a lanekit that is no lane's. */
const kitLane = (kit, cwd, args, extra = {}) => {
    const done = spawnSync(process.execPath, [path.join(kit, 'dev', 'lane.mjs'), ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' })
    return { code: done.status, out: plain(`${done.stdout}${done.stderr}`) }
}
// Where python3 can give a process a pseudo-terminal, the question is asked and answered as a person would.
const PTY = 'import os, pty, sys\nsys.exit(os.waitstatus_to_exitcode(pty.spawn(sys.argv[1:])))'
const hasPty = spawnSync('python3', ['-c', 'import pty, os; os.waitstatus_to_exitcode'], { encoding: 'utf8' }).status === 0
/** `lane` at a terminal: once it asks `[y/N]`, `answer` is typed and Enter pressed. */
const atTerminal = (kit, cwd, args, answer, extra = {}) => new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PTY, process.execPath, path.join(kit, 'dev', 'lane.mjs'), ...args], { cwd, env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let asked = false
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no end in 20s:\n${out}`)) }, 20000)
    const heard = (chunk) => {
        out += chunk
        if (!asked && out.includes('[y/N] ')) { asked = true; child.stdin.write(`${answer}\r`) }
    }
    child.stdout.on('data', heard)
    child.stderr.on('data', heard)
    child.on('exit', (code) => { clearTimeout(timer); child.stdin.end(); resolve({ code, asked, out: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '') }) })
})
const verify = (cwd) => run('gate.mjs', cwd, [])
const runsOf = (repo) => {
    const dir = path.join(repo, '.lanekit', 'runs')
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')).sort().reverse().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) : []
}
const step = (what, script) => ({ what, command: 'sh', args: ['-c', script] })
const configWith = (slug, full) => ({
    name: slug, slug, integrationBranch: 'main', roots: {},
    gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'the quick tests', steps: [step('running the quick tests', 'true')] } }, ...(full ? { full } : {}) },
    lane: { portBase: 19601, portCeiling: 19699, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
})

/** A repository with lanes and `gate.full` as given (none where null), and its first commit. */
const project = (slug, full) => {
    const repo = path.join(scratch, 'work', slug)
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify(configWith(slug, full), null, 2))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    return repo
}
/** A lane of `repo` with one commit of its own, writing `file`. */
const laneWith = (repo, name, file = `${name}.txt`, text = `${name}\n`) => {
    const made = lane(repo, 'new', name)
    assert.equal(made.code, 0, made.out)
    const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`)
    fs.writeFileSync(path.join(dir, file), text)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', `Add ${file}`)
    return dir
}
/** The run recorded with `id`, once it is no longer running. */
const settled = async (repo, test, seconds = 30) => {
    const until = Date.now() + seconds * 1000
    for (;;) {
        const found = runsOf(repo).find(test)
        if (found && found.result !== 'running') return found
        if (Date.now() > until) assert.fail(`no finished run in ${seconds}s: ${JSON.stringify(runsOf(repo).map((one) => [one.kind, one.result]))}`)
        await new Promise((resolve) => setTimeout(resolve, 200))
    }
}

/** A copy of this lanekit's code in a repository of its own, its main checkout, and a lane of it (a worktree). */
const KITS = {}
before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-full-')))
    env.LANEKIT_CACHE = path.join(scratch, 'cache')
    env.LANEKIT_LAUNCH_AGENTS = path.join(scratch, 'LaunchAgents')
    KITS.main = path.join(scratch, 'kits', 'lanekit')
    for (const part of ['lib', 'dev', 'bin']) fs.cpSync(path.join(KIT, part), path.join(KITS.main, part), { recursive: true })
    git(KITS.main, 'init', '-q', '-b', 'main')
    git(KITS.main, 'add', '-A')
    git(KITS.main, 'commit', '-qm', 'lanekit, copied')
    KITS.lane = path.join(scratch, 'kits', 'lanekit-trying')
    git(KITS.main, 'worktree', 'add', '-q', '-b', 'trying', KITS.lane)
})
after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

// ---------------------------------------------------------------------------
// the config
// ---------------------------------------------------------------------------

test('gate.full is refused, with the key it is about, where it cannot mean anything; left out, the config is as it was', () => {
    const dir = path.join(scratch, 'configs')
    fs.mkdirSync(dir, { recursive: true })
    const read = (full, key = 'gate') => {
        const config = configWith('configs', full)
        if (key === 'verify') { config.verify = config.gate; delete config.gate }
        fs.writeFileSync(path.join(dir, 'lane.config.json'), JSON.stringify(config))
        try { return loadConfig(dir) } catch (error) { return error.message }
    }
    const steps = [step('running everything', 'true')]
    const file = path.join(dir, 'lane.config.json')
    assert.equal(read({ when: 'weekly', steps }), `${file}: gate.full.when is "weekly": it says when the full suite runs, "nightly", "after-land" or "before-land"`)
    assert.match(read({ steps }), /gate\.full\.when is missing/)
    assert.equal(read({ when: 'nightly', steps }), `${file}: gate.full.at is missing: a nightly run needs the local time it starts, as "HH:MM" from "00:00" to "23:59", such as "03:00"`)
    for (const at of ['3:00', '24:00', '03:60', '03:00pm', 300]) assert.match(read({ when: 'nightly', at, steps }), /gate\.full\.at is .*: a nightly run needs the local time/, String(at))
    assert.match(read({ when: 'after-land', at: '03:00', steps }), /gate\.full\.at is for "nightly" only: a full suite run after each land has no time of day/)
    assert.match(read({ when: 'before-land' }), /gate\.full\.steps must list what the full suite runs, at least one step/)
    assert.match(read({ when: 'before-land', steps: [] }), /gate\.full\.steps must list/)
    assert.match(read({ when: 'before-land', steps: [{ command: 'true' }] }), /gate\.full\.steps\[0\]\.what must say what the step does/)
    assert.match(read({ when: 'before-land', steps: [{ what: 'x', args: [] }] }), /gate\.full\.steps\[0\]\.command must name what to run/)
    assert.match(read({ when: 'before-land', steps: [{ what: 'x', command: 'x', args: '--all' }] }), /gate\.full\.steps\[0\]\.args must be a list of strings/)
    assert.match(read({ when: 'before-land', label: '', steps }), /gate\.full\.label must be words/)
    assert.match(read('nightly'), /gate\.full must be an object/)
    assert.match(read({ when: 'weekly', steps }, 'verify'), /: verify\.full\.when is "weekly"/, 'named by the key the file uses')

    assert.equal(read({ when: 'nightly', at: '03:00', label: 'everything', steps }).gate.full.at, '03:00')
    assert.equal(read({ when: 'after-land', steps }, 'verify').gate.full.when, 'after-land')
    const without = read(null)
    assert.equal('full' in without.gate, false)
})

test('a project without gate.full reads as it did: no full run, no word of one in its state, its queue or lane list', () => {
    const repo = project('plain', null)
    const dir = laneWith(repo, 'work')
    const verified = verify(dir)
    assert.equal(verified.code, 0, verified.out)
    assert.doesNotMatch(verified.out, /full suite/i)
    assert.match(verified.out, /VERIFIED {2}·  work {2}·  tier 1 green on/)
    assert.deepEqual(runsOf(repo).map((one) => one.kind), ['tier1'])
    const state = repoState(repo)
    assert.equal('fullSuite' in state, false)
    assert.equal('full' in state.lanes[0], false)
    assert.equal('fullGreen' in state.lanes[0].queue, false)
    const plan = planQueue(repo, lanesOf(repo, 'main'), loadConfig(repo))
    assert.equal('fullLabel' in plan, false)
    assert.deepEqual(landBlockers(plan, 'work'), [])
    assert.doesNotMatch(lane(repo, 'list').out, /full suite/i)
    assert.match(lane(repo, 'nightly').out, /has no gate\.full, so nothing says what the full suite is/)
})

// ---------------------------------------------------------------------------
// before-land
// ---------------------------------------------------------------------------

test('before-land: verifying runs the full steps after the tier, records them as a run of their own, and a land needs it passed', () => {
    // The full suite fails where the lane has a file called break-full: one lane passes, the other does not.
    const repo = project('before', { when: 'before-land', label: 'every selftest', steps: [step('running every selftest', 'echo "every selftest in $(pwd)"; test ! -f break-full')] })
    const good = laneWith(repo, 'good')
    const verified = verify(good)
    assert.equal(verified.code, 0, verified.out)
    assert.match(verified.out, /\[verify +\d+s\] tier 1: the quick tests\n/)
    assert.match(verified.out, /\[verify +\d+s\] full suite: every selftest\n\[verify +\d+s\] running every selftest…\nevery selftest in .*before-good\n/)
    assert.match(verified.out, /VERIFIED {2}·  good {2}·  tier 1 and the full suite \(every selftest\) green on [0-9a-f]{10}/)
    assert.match(verified.out, /full → .*\.lanekit\/runs\/.*-full\.json\n/)
    const sha = git(good, 'rev-parse', 'HEAD')
    const [full, tier] = [runsOf(repo).find((one) => one.kind === 'full'), runsOf(repo).find((one) => one.kind === 'tier1')]
    assert.deepEqual([full.why, full.label, full.branch, full.sha, full.worktree, full.result], ['before-land', 'every selftest', 'good', sha, good, 'passed'])
    assert.deepEqual(full.steps.map((one) => one.what), ['running every selftest'])
    assert.equal(tier.result, 'passed')
    assert.equal('tier' in full, false, 'a full run is no tier\'s green')
    assert.ok(fullGreenFor({ branch: 'good', sha, worktree: good }, repo))

    // Verified again on the same commit: the tier runs, the full suite that passed on it does not.
    const again = verify(good)
    assert.match(again.out, /the full suite \(every selftest\) passed on [0-9a-f]{10} already, .*: not run again/)
    assert.equal(runsOf(repo).filter((one) => one.kind === 'full').length, 1)

    const bad = laneWith(repo, 'bad', 'break-full')
    const failed = verify(bad)
    assert.equal(failed.code, 1, failed.out)
    assert.match(failed.out, /\[verify\] the full suite failed: running every selftest/)
    assert.match(failed.out, /FAILED {2}·  bad {2}·  tier 1 green, the full suite \(every selftest\) failed/)
    const badFull = runsOf(repo).find((one) => one.kind === 'full' && one.branch === 'bad')
    assert.equal(badFull.result, 'failed')
    assert.equal(badFull.failures[0].what, 'running every selftest')
    assert.match(badFull.failures[0].tail, /every selftest in .*before-bad/)
    assert.equal(runsOf(repo).find((one) => one.kind === 'tier1' && one.branch === 'bad').result, 'passed', 'the tier\'s record says what the tier did')

    // The queue and the land: the tier is green, the full suite is not, and that is the blocker said.
    const plan = planQueue(repo, lanesOf(repo, 'main'), loadConfig(repo))
    assert.equal(plan.entries.find((one) => one.name === 'good').verdict, 'land now')
    assert.equal(plan.entries.find((one) => one.name === 'bad').verdict, 'gate now')
    assert.deepEqual(landBlockers(plan, 'bad'), [{ id: 'full', why: `no passing full run (every selftest) names ${git(bad, 'rev-parse', 'HEAD').slice(0, 10)}: this project runs it before a land — verify runs it, after the tier` }])
    const refused = lane(repo, 'land', 'bad')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /bad cannot land yet\.\n\n {2}full {5}no passing full run \(every selftest\) names/)
    assert.match(lane(repo, 'queue', 'bad').out, /full {5}no passing full run/)

    const state = repoState(repo)
    const [goodState, badState] = ['good', 'bad'].map((name) => state.lanes.find((one) => one.name === name))
    assert.deepEqual([goodState.full.result, goodState.full.current, goodState.queue.fullGreen], ['passed', true, true])
    assert.deepEqual([badState.full.result, badState.queue.fullGreen, badState.gate.result], ['failed', false, 'passed'])
    assert.equal(state.fullSuite.main, null, 'before-land runs belong to lanes; main has no line of its own')

    // As the lanes tool says each.
    assert.equal(laneFullSaid(goodState.full, 'every selftest'), 'every selftest passed on this commit')
    assert.equal(laneFullSaid(badState.full, 'every selftest'), 'every selftest FAILED on this commit: "running every selftest"')
    assert.equal(laneFullSaid(null, 'every selftest'), 'no full run (every selftest) on this commit: a land needs one, and verify runs it')
    assert.equal(laneFullSaid({ ...goodState.full, current: false }, 'every selftest'), 'no full run (every selftest) on this commit: a land needs one, and verify runs it')

    const landed = lane(repo, 'land', 'good')
    assert.equal(landed.code, 0, landed.out)
    assert.match(landed.out, /LANDED/)
})

test('before-land: a narrowed verification or a failing tier runs no full suite, and says why', () => {
    const repo = project('narrow', { when: 'before-land', steps: [step('running everything', 'echo ran-everything')] })
    // A change to app/ earns tier 2, so --fast (tier 1) is a narrowed run.
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'lane.config.json'), 'utf8'))
    config.gate.sides.app = ['app/']
    config.gate.tiers[2] = { label: 'the slow tests', steps: [step('running the slow tests', 'true')] }
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify(config))
    git(repo, 'commit', '-qam', 'Give it a tier 2')
    const dir = laneWith(repo, 'quick')
    fs.mkdirSync(path.join(dir, 'app'))
    fs.writeFileSync(path.join(dir, 'app', 'x.txt'), 'x\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Change the app')
    const fast = run('gate.mjs', dir, ['--fast'])
    assert.doesNotMatch(fast.out, /ran-everything/)
    assert.match(fast.out, /the full suite \(the full suite\) is not run: a narrowed run certifies nothing/)
    assert.match(fast.out, /INCOMPLETE/)
    config.gate.tiers[2].steps = [step('running the slow tests', 'exit 4')]
    fs.writeFileSync(path.join(dir, 'lane.config.json'), JSON.stringify(config))
    git(dir, 'commit', '-qam', 'Break the quick tests')
    const failed = verify(dir)
    assert.equal(failed.code, 1)
    assert.match(failed.out, /the full suite \(the full suite\) is not run: tier 2 failed first/)
    assert.doesNotMatch(failed.out, /ran-everything/)
    assert.equal(runsOf(repo).some((one) => one.kind === 'full'), false)
})

// ---------------------------------------------------------------------------
// after-land
// ---------------------------------------------------------------------------

test('after-land: a land returns at once, the full suite runs on its merge in a scratch copy, and a failure undoes nothing and is said first', async () => {
    const repo = project('afterward', { when: 'after-land', label: 'every selftest', steps: [step('running every selftest', 'sleep 5; echo "ran in $(pwd)"; touch made-by-the-suite; echo "selftest backup: broken" >&2; exit 3')] })
    const dir = laneWith(repo, 'change')
    assert.equal(verify(dir).code, 0)
    const dry = lane(repo, 'land', 'change', '--dry-run')
    assert.match(dry.out, /then would start every selftest on the merge, in the background/)
    assert.deepEqual(runsOf(repo).filter((one) => one.kind === 'full'), [], 'a dry run starts nothing')

    const landed = lane(repo, 'land', 'change')
    assert.equal(landed.code, 0, landed.out)
    // Returned while the suite, five seconds at least, had not ended: it is under way, or not yet written down as begun.
    assert.deepEqual(runsOf(repo).filter((one) => one.kind === 'full' && one.result !== 'running'), [], 'the land waited for the suite')
    assert.match(landed.out, /started every selftest on main at [0-9a-f]+, in a scratch copy, in the background: lanes says how it went/)
    assert.match(landed.out, /its output: .*after-land-.*\.log/)
    const merge = git(repo, 'rev-parse', 'HEAD')

    const record = await settled(repo, (one) => one.kind === 'full')
    assert.deepEqual([record.why, record.landed, record.branch, record.sha, record.worktree, record.result], ['after-land', 'change', 'main', merge, repo, 'failed'])
    const copy = scratchFor(repo, 'afterward', env)
    assert.equal(record.scratch, copy)
    assert.ok(copy.startsWith(path.join(scratch, 'cache')), copy)
    assert.match(record.failures[0].tail, new RegExp(`ran in ${copy.replaceAll('.', '\\.')}\\n`))
    assert.match(record.failures[0].tail, /selftest backup: broken/)
    assert.equal(record.failures[0].status, 3)
    assert.match(fs.readFileSync(record.log, 'utf8'), /FULL SUITE FAILED/)

    // Nothing undone, nothing left in main's checkout, and the copy is no lane.
    assert.equal(git(repo, 'rev-parse', 'HEAD'), merge)
    assert.equal(git(repo, 'show', 'main:change.txt'), 'change')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(fs.existsSync(path.join(repo, 'made-by-the-suite')), false)
    assert.ok(fs.existsSync(path.join(copy, 'made-by-the-suite')))
    assert.ok(!git(repo, 'worktree', 'list').includes(copy))
    assert.deepEqual(lanesOf(repo, 'main').map((one) => one.name), [])
    assert.equal(fs.existsSync(path.join(copy, '.lanekit', 'runs')), false, 'recorded in the main checkout, not in the copy')

    const lines = mainFullLines(repoState(repo).fullSuite.main, 'main')
    assert.match(lines[0], new RegExp(`^FULL SUITE FAILED on main at ${merge.slice(0, 7)} \\(after change landed, (just now|1 minute ago)\\): "running every selftest" exited 3\\. main is not known to pass every selftest: fix it in a lane; \`lane nightly\` runs it again on main now\\. Its output: .*\\.log$`))
    assert.match(lines.join('\n'), /\n {4}selftest backup: broken/)
    const listed = lane(repo, 'list')
    assert.match(listed.out, /FULL SUITE FAILED on main at/)
})

test('after-land, through the MCP server: land returns before the suite ends, and lanes says it runs, then that it failed, before any lane', async () => {
    const repo = project('agentic', { when: 'after-land', steps: [step('running everything', 'sleep 5; exit 1')] })
    laneWith(repo, 'one')
    const server = spawn(process.execPath, [path.join(KIT, 'bin', 'mcp.mjs')], { cwd: os.tmpdir(), env: { ...env, LANEKIT_PROJECT: repo }, stdio: ['pipe', 'pipe', 'inherit'] })
    const waiting = new Map()
    let next = 0
    readline.createInterface({ input: server.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
    })
    const tool = (name, args = {}) => new Promise((resolve) => {
        const id = ++next
        waiting.set(id, (answer) => resolve({ text: answer.result.content.map((part) => part.text).join('\n'), isError: answer.result.isError }))
        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`)
    })
    try {
        // The agents may run the suite's land and see its result, but scheduling it is the person's (the owner, 26 Oct).
        const listed = await new Promise((resolve) => {
            const id = ++next
            waiting.set(id, (answer) => resolve(answer.result.tools.map((one) => one.name)))
            server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/list' })}\n`)
        })
        assert.ok(listed.includes('land'), listed.join(' '))
        assert.deepEqual(listed.filter((name) => /nightly|install|schedul/i.test(name)), [], 'no tool installs a nightly job')
        assert.equal((await tool('verify', { lane: 'one' })).isError, false)
        const before = await tool('lanes')
        assert.match(before.text, /Full suite \(the full suite, after each land\): no run on main yet; `lane nightly` runs one now\.\n/)
        const landed = await tool('land', { lane: 'one' })
        assert.equal(landed.isError, false, landed.text)
        assert.deepEqual(runsOf(repo).filter((one) => one.kind === 'full' && one.result !== 'running'), [], 'the land tool waited for the suite')
        // Once its process has written down that it began (a moment after the land), lanes says it runs.
        const until = Date.now() + 4000
        while (!runsOf(repo).some((one) => one.kind === 'full') && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 100))
        assert.match((await tool('lanes')).text, /Full suite \(the full suite, after each land\): running on main at [0-9a-f]{7} since just now, after one landed\./)
        await settled(repo, (one) => one.kind === 'full')
        const after = (await tool('lanes')).text
        const [head, ...rest] = after.split('\n')
        assert.match(head, /^agentic at .*: main at [0-9a-f]+ "Merge branch 'one'"/)
        assert.match(rest[0], /^FULL SUITE FAILED on main at [0-9a-f]{7} \(after one landed, (just now|1 minute ago)\): "running everything" exited 1\./, 'the line after main\'s own')
    } finally {
        server.stdin.end()
    }
})

test('after-land: lands made while a run is under way get one run more, on main\'s newest commit, which names them; an older failure stays said first', async () => {
    // The run on a's merge fails, slowly; any other passes, less slowly. Each says which commit it ran.
    const repo = project('coalesce', { when: 'after-land', steps: [step('running everything',
        'echo "ran $(git rev-parse HEAD)"; if [ "$(git log -1 --format=%s)" = "Merge branch \'a\'" ]; then sleep 4; exit 5; fi; sleep 3')] })
    for (const name of ['a', 'b', 'c']) assert.equal(verify(laneWith(repo, name)).code, 0)
    const fulls = () => runsOf(repo).filter((one) => one.kind === 'full')
    const until = async (what, test, seconds = 20) => {
        const end = Date.now() + seconds * 1000
        while (!test()) {
            if (Date.now() > end) assert.fail(`${what} in ${seconds}s: ${JSON.stringify(fulls().map((one) => [one.landed, one.result]))}`)
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }

    assert.equal(lane(repo, 'land', 'a').code, 0)
    const shaA = git(repo, 'rev-parse', 'HEAD')
    await until('a\'s run under way', () => fulls().some((one) => one.sha === shaA && one.result === 'running'))
    const landedB = lane(repo, 'land', 'b')
    assert.equal(landedB.code, 0, landedB.out)
    const landedC = lane(repo, 'land', 'c')
    assert.equal(landedC.code, 0, landedC.out)
    const shaC = git(repo, 'rev-parse', 'HEAD')
    assert.equal(fulls().length, 1, 'b and c queued no run of their own')

    // While a's still runs: one line about main, the run to come said with it.
    const during = mainFullLines(repoState(repo).fullSuite.main, 'main')
    assert.deepEqual(during.length, 1, during.join('\n'))
    assert.match(during[0], /^Full suite \(the full suite, after each land\): running on [0-9a-f]{7}, \d+ commits before main's newest since just now, after a landed; main's newest commit runs when it ends\.$/)

    // a's fails, and the run of c's merge, standing for b's too, begins: the failure is still said first.
    await until('c\'s run under way', () => fulls().some((one) => one.sha === shaC && one.result === 'running'))
    const failedFirst = mainFullLines(repoState(repo).fullSuite.main, 'main')
    assert.match(failedFirst[0], new RegExp(`^FULL SUITE FAILED on ${shaA.slice(0, 7)}, \\d+ commits before main's newest \\(after a landed, just now\\): "running everything" exited 5\\.`))
    assert.equal(failedFirst.at(-1), `Full suite (the full suite, after each land): running on main at ${shaC.slice(0, 7)} since just now, after b and c landed.`)

    const last = await settled(repo, (one) => one.kind === 'full' && one.sha === shaC)
    await new Promise((resolve) => setTimeout(resolve, 500))
    const all = fulls()
    assert.equal(all.length, 2, JSON.stringify(all.map((one) => [one.landed, one.sha])))
    assert.deepEqual(all.map((one) => [one.sha, one.landed, one.coalesced ?? [], one.result]).reverse(), [[shaA, 'a', [], 'failed'], [shaC, 'c', ['b'], 'passed']])
    assert.equal(last.why, 'after-land')
    const logs = path.dirname(last.log)
    const logged = fs.readdirSync(logs).map((name) => fs.readFileSync(path.join(logs, name), 'utf8')).join('\n')
    assert.match(logged, /a full run is under way already \(process \d+, on [0-9a-f]{10}, after-land\): it runs main's newest commit when it ends, and this land's with it/, 'a land that found a run under way said so, and left it')
    assert.match(fs.readFileSync(all.at(-1).log, 'utf8'), /main moved on while it ran: once more, on its newest commit/)
    const settledLines = mainFullLines(repoState(repo).fullSuite.main, 'main')
    assert.equal(settledLines.length, 1, settledLines.join('\n'))
    assert.match(settledLines[0], new RegExp(`^Full suite \\(the full suite, after each land\\): passed on main at ${shaC.slice(0, 7)}, just now, in [\\d.]+s\\.$`))
})

// ---------------------------------------------------------------------------
// nightly
// ---------------------------------------------------------------------------

test('lane nightly runs the full suite on main\'s newest commit in a scratch copy, records it in main, and skips a commit that passed', () => {
    const repo = project('nights', { when: 'nightly', at: '03:00', label: 'every selftest', steps: [step('running every selftest', 'echo "ran at $(git rev-parse --short HEAD) in $(pwd)"; touch made-by-the-suite; mkdir -p "$LAB_RESULTS"; printf \'<testsuites><testsuite name="s"><testcase name="a"/><testcase name="b"/></testsuite></testsuites>\' > "$LAB_RESULTS/s.xml"')] })
    const sha = git(repo, 'rev-parse', 'HEAD')
    const listedBefore = lane(repo, 'list').out
    assert.match(listedBefore, /Full suite \(every selftest, nightly at 03:00\): no run on main yet; `lane nightly` runs one now\./)

    // From a lane: it is main's commit that is run, and main's runs it is written to.
    const dir = laneWith(repo, 'elsewhere')
    const ran = lane(dir, 'nightly')
    assert.equal(ran.code, 0, ran.out)
    assert.match(ran.out, new RegExp(`\\[full +\\d+s\\] a scratch copy of main at ${sha.slice(0, 10)}, in .*cache/full/nights-[0-9a-f]{8}\\n`))
    assert.match(ran.out, new RegExp(`ran at ${sha.slice(0, 7)} in .*cache/full/nights-`))
    assert.match(ran.out, /\[full +\d+s\] tests: 2 passed\n/)
    assert.match(ran.out, /FULL SUITE PASSED {2}·  every selftest passed on main at [0-9a-f]{10}, in [\d.]+s \(2 passed\)/)
    const [record] = runsOf(repo)
    assert.deepEqual([record.kind, record.why, record.branch, record.sha, record.worktree, record.result, record.tests.passed], ['full', 'nightly', 'main', sha, repo, 'passed', 2])
    assert.equal(fs.existsSync(path.join(repo, 'made-by-the-suite')), false, 'main\'s checkout is not where it runs')
    assert.equal(git(repo, 'status', '--porcelain'), '')
    assert.equal(fs.existsSync(path.join(dir, '.lanekit', 'runs')), false, 'one history, the main checkout\'s')

    const skipped = lane(repo, 'nightly')
    assert.equal(skipped.code, 0)
    assert.match(skipped.out, new RegExp(`main at ${sha.slice(0, 10)} passed every selftest already \\(.*\\): not run again; --force runs it anyway`))
    assert.equal(runsOf(repo).length, 1)
    const forced = lane(repo, 'nightly', '--force')
    assert.equal(forced.code, 0, forced.out)
    assert.equal(runsOf(repo).length, 2)
    assert.match(lane(repo, 'list').out, /Full suite \(every selftest, nightly at 03:00\): passed on main at [0-9a-f]{7}, just now, in [\d.]+s \(2 passed\)\./)

    // Main moves on: the newest commit has had no run, and the next one is of it, in a copy scrubbed of the last run's files.
    fs.writeFileSync(path.join(repo, 'later.txt'), 'later\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Later')
    const later = lane(repo, 'nightly')
    assert.equal(later.code, 0, later.out)
    assert.equal(runsOf(repo)[0].sha, git(repo, 'rev-parse', 'HEAD'))
})

test('lane nightly does not start a second run while one holds the scratch copy, and a run whose process is gone is said to have stopped', () => {
    const repo = project('busy', { when: 'nightly', at: '23:30', steps: [step('running everything', 'true')] })
    const copy = scratchFor(repo, 'busy', env)
    fs.mkdirSync(path.dirname(copy), { recursive: true })
    fs.writeFileSync(`${copy}.lock`, JSON.stringify({ pid: process.pid, sha: 'abcdef1234', why: 'after-land' }))
    const busy = lane(repo, 'nightly')
    assert.equal(busy.code, 0)
    assert.match(busy.out, /a full run is under way already \(process \d+, on abcdef1234, after-land\): not starting another/)
    fs.rmSync(`${copy}.lock`)

    // A run written down as under way by a process that is no longer there.
    const runs = path.join(repo, '.lanekit', 'runs')
    fs.mkdirSync(runs, { recursive: true })
    const sha = git(repo, 'rev-parse', 'HEAD')
    const startedAt = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    fs.writeFileSync(path.join(runs, '2000-01-01T00-00-00Z-1-full.json'), JSON.stringify({ id: '2000-01-01T00-00-00Z-1-full', kind: 'full', why: 'nightly', branch: 'main', sha, worktree: repo, result: 'running', pid: 2 ** 22 + 12345, host: os.hostname(), startedAt }))
    const shown = repoState(repo).fullSuite.main
    assert.equal(shown.stopped.result, 'stopped')
    assert.equal(shown.running, null)
    assert.match(mainFullLines(shown, 'main').join('\n'), /the run on main at [0-9a-f]{7} begun 2 hours ago stopped before it finished \(its process is gone\); `lane nightly` runs it again on main now\./)
    const ran = lane(repo, 'nightly')
    assert.equal(ran.code, 0, ran.out)
    assert.match(ran.out, /FULL SUITE PASSED/, 'a stopped run is no pass: it runs')
})

// ---------------------------------------------------------------------------
// what lanes says of main's full suite
// ---------------------------------------------------------------------------

test('what lanes says of main\'s full suite: none yet, passed, running, failed with the step and its last lines, overdue, not installed', () => {
    const now = Date.parse('2026-10-26T12:00:00Z')
    const config = { slug: 'said', integrationBranch: 'main', gate: { full: { when: 'nightly', at: '03:00', label: 'every selftest', steps: [] } } }
    const head = 'a'.repeat(40)
    const older = 'b'.repeat(40)
    const record = (over) => ({ kind: 'full', why: 'nightly', branch: 'main', sha: head, worktree: '/work/said', durationSeconds: 840, steps: [], failures: [], ...over })
    const shown = (runs, extra = {}) => mainFullOf(runs, { config, mainRepo: '/work/said', headSha: head, behindOf: () => 3, now, env: { LANEKIT_PLATFORM: 'linux' }, ...extra })
    const say = (runs, extra) => mainFullLines(shown(runs, extra), 'main', now)

    assert.deepEqual(say([]), ['Full suite (every selftest, nightly at 03:00): no run on main yet; `lane nightly` runs one now.'])
    assert.deepEqual(say([record({ id: 'p', result: 'passed', startedAt: '2026-10-26T03:00:00Z', tests: { files: 1, total: 412, passed: 412 } })]),
        ['Full suite (every selftest, nightly at 03:00): passed on main at aaaaaaa, 9 hours ago, in 840s (412 passed).'])
    assert.deepEqual(say([record({ id: 'p', result: 'passed', sha: older, startedAt: '2026-10-26T03:00:00Z' })]),
        ['Full suite (every selftest, nightly at 03:00): passed on bbbbbbb, 3 commits before main\'s newest, 9 hours ago, in 840s.'])
    const failed = record({
        id: 'f', result: 'failed', startedAt: '2026-10-26T03:00:00Z', log: '/cache/nightly.log',
        failures: [{ what: 'running ./check --all --tier 2', status: 1, tail: 'one\ntwo\nthree\nfour\nfive\nsix\n  selftest backup: FAILED' }],
        tests: { files: 1, total: 412, passed: 410, failed: 2, failing: [{ name: 'selftest::backup', outcome: 'failed' }] }
    })
    assert.deepEqual(say([failed]), [
        'FULL SUITE FAILED on main at aaaaaaa (nightly, 9 hours ago): "running ./check --all --tier 2" exited 1. Tests: 410 passed, 2 failed; failed selftest::backup. main is not known to pass every selftest: fix it in a lane; `lane nightly` runs it again on main now. Its output: /cache/nightly.log',
        '    three', '    four', '    five', '    six', '      selftest backup: FAILED'
    ])
    // A run under way since does not hide the failure, nor does one that stopped.
    const running = record({ id: 'r', result: 'running', pid: process.pid, host: os.hostname(), startedAt: '2026-10-26T11:55:00Z' })
    const both = say([running, failed])
    assert.match(both[0], /^FULL SUITE FAILED/)
    assert.equal(both.at(-1), 'Full suite (every selftest, nightly at 03:00): running on main at aaaaaaa since 5 minutes ago.')
    const stopped = record({ id: 's', result: 'running', pid: 2 ** 22 + 54321, host: os.hostname(), startedAt: '2026-10-26T11:00:00Z' })
    assert.match(say([stopped, failed])[0], /^FULL SUITE FAILED/)

    const old = record({ id: 'o', result: 'passed', startedAt: '2026-10-24T03:00:00Z' })
    assert.deepEqual(say([old]), [
        'Full suite (every selftest, nightly at 03:00): passed on main at aaaaaaa, 2 days ago, in 840s.',
        'FULL SUITE OVERDUE: it runs nightly at 03:00, and the newest run began 2 days ago; is this machine asleep at that hour, or its job gone? `lane nightly` runs it again on main now.'
    ])
    const agents = path.join(scratch, 'said-agents')
    assert.match(say([old], { env: { LANEKIT_PLATFORM: 'darwin', LANEKIT_LAUNCH_AGENTS: agents } })[1], /began 2 days ago; no nightly job is installed on this machine \(`lane nightly --install` shows what it writes\) `lane nightly`/)
    assert.match(say([], { env: { LANEKIT_PLATFORM: 'darwin', LANEKIT_LAUNCH_AGENTS: agents } })[0], /no run on main yet; `lane nightly` runs one now; no nightly job is installed on this machine/)

    // A land's run, and main moved on since by something other than a land.
    const afterLand = { ...config, gate: { full: { when: 'after-land', steps: [] } } }
    assert.deepEqual(mainFullLines(mainFullOf([record({ id: 'a', why: 'after-land', landed: 'tidy', sha: older, result: 'passed', startedAt: '2026-10-26T11:00:00Z' })], { config: afterLand, mainRepo: '/work/said', headSha: head, behindOf: () => 1, now }), 'main', now), [
        'Full suite (the full suite, after each land): passed on bbbbbbb, 1 commit before main\'s newest, 1 hour ago, in 840s.',
        '  main\'s newest commit has no full run of its own: it did not come by `lane land`; `lane nightly` runs it again on main now.'
    ])
    assert.equal(mainFullOf([], { config: { ...config, gate: { full: { when: 'before-land', steps: [] } } }, mainRepo: '/', headSha: head }), null)
    assert.equal(mainFullOf([], { config: { ...config, gate: {} }, mainRepo: '/', headSha: head }), null)
    assert.deepEqual(['just now', '1 minute ago', '2 hours ago', '2 days ago'], [now - 10e3, now - 60e3, now - 2 * 3600e3, now - 48 * 3600e3].map((at) => agoSaid(at, now)))
})

test('a slow-down is reckoned for the full suite against its own runs, and said as the full suite\'s', () => {
    const passing = (id, kind, durationSeconds) => ({ id, kind, result: 'passed', durationSeconds, startedAt: '2026-10-20T03:00:00Z' })
    const runs = [1, 2, 3, 4, 5].map((n) => passing(`f${n}`, 'full', 100)).concat([1, 2, 3, 4, 5].map((n) => passing(`t${n}`, 'tier1', 5)))
    assert.equal(slowdownOf(passing('now', 'full', 150), runs), null, 'against the full suite\'s 100s, not the tier\'s 5s')
    const slow = slowdownOf(passing('now', 'full', 400), runs)
    assert.deepEqual([slow.median, slow.runs], [100, 5])
    assert.match(slowdownLines(slow, 'the full suite')[0], /^slower than usual: this took 400s, 4\.0 times the 100s that the full suite's last 5 passing runs here took at the median$/)
    assert.match(slowdownLines(slowdownOf(passing('t', 'tier1', 50), runs), 1)[0], /that tier 1's last 5 passing runs/)
})

// ---------------------------------------------------------------------------
// the schedule
// ---------------------------------------------------------------------------

test('lane nightly --install shows the LaunchAgent, refuses without a terminal, writes it with --yes to the folder named, loads nothing from a scratch folder, and --uninstall asks too', () => {
    const repo = project('scheduled', { when: 'nightly', at: '03:15', steps: [step('running everything', 'true')] })
    const agents = env.LANEKIT_LAUNCH_AGENTS
    const file = path.join(agents, 'dev.lanekit.nightly.scheduled.plist')
    const mac = { LANEKIT_PLATFORM: 'darwin' }
    const install = (...args) => kitLane(KITS.main, repo, ['nightly', ...args], mac)

    const dry = install('--install', '--dry-run')
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, new RegExp(`would write ${file.replaceAll('.', '\\.')}:\\n`))
    assert.match(dry.out, /<key>Hour<\/key>\n\s+<integer>3<\/integer>\n\s+<key>Minute<\/key>\n\s+<integer>15<\/integer>/)
    assert.doesNotMatch(dry.out, /\[y\/N\]|--yes/, 'a dry run asks nothing')
    assert.equal(fs.existsSync(file), false, 'a dry run writes nothing')

    // An agent, a script: shown, and refused, saying why and what a person would do.
    const unasked = install('--install')
    assert.equal(unasked.code, 1, unasked.out)
    assert.match(unasked.out, /writes .*dev\.lanekit\.nightly\.scheduled\.plist:\n/)
    assert.match(unasked.out, /nothing was written: there is no terminal here to ask "Install it\? \[y\/N\]" at, and it is asked first\.\n\n {2}Run it yourself at a terminal; or, if the person it runs for has seen the above and said yes, add --yes\./)
    assert.equal(fs.existsSync(file), false)

    const installed = install('--install', '--yes')
    assert.equal(installed.code, 0, installed.out)
    assert.match(installed.out, /writes .*dev\.lanekit\.nightly\.scheduled\.plist:\n/)
    assert.match(installed.out, /It runs the full suite on main at 03:15 each night, in a scratch copy, as lane nightly does/)
    assert.match(installed.out, /not loaded: .*LaunchAgents is not ~\/Library\/LaunchAgents \(LANEKIT_LAUNCH_AGENTS names it\)/)
    assert.doesNotMatch(installed.out, /launchctl bootstrap|\[y\/N\]/)
    const plist = fs.readFileSync(file, 'utf8')
    assert.ok(installed.out.includes(plist.split('\n').map((line) => `    ${line}`).join('\n')), 'what it writes is what it showed')
    assert.match(plist, /<key>Label<\/key>\n\s+<string>dev\.lanekit\.nightly\.scheduled<\/string>/)
    assert.match(plist, new RegExp(`<key>WorkingDirectory</key>\\n\\s+<string>${repo.replaceAll('.', '\\.')}</string>`))
    assert.ok(plist.includes(`<string>${path.join(KITS.main, 'dev', 'full.mjs')}</string>\n        <string>--why</string>\n        <string>nightly</string>`), plist)
    const pathVar = /<key>PATH<\/key>\n\s+<string>([^<]*)<\/string>/.exec(plist)[1].split(':')
    const node = /<key>ProgramArguments<\/key>\n\s+<array>\n\s+<string>([^<]*)<\/string>/.exec(plist)[1]
    assert.equal(path.basename(node), 'node')
    assert.ok(pathVar.includes(path.dirname(node)), 'the PATH finds the node it names')
    assert.ok(pathVar.some((dir) => fs.existsSync(path.join(dir, 'git'))), 'and git')
    const log = /<key>StandardOutPath<\/key>\n\s+<string>([^<]*)<\/string>/.exec(plist)[1]
    assert.ok(fs.existsSync(path.dirname(log)), 'its log folder is there for launchd to write in')
    if (process.platform === 'darwin') {
        const lint = spawnSync('plutil', ['-lint', file], { encoding: 'utf8' })
        assert.equal(lint.status, 0, lint.stdout + lint.stderr)
    }
    assert.doesNotMatch(mainFullLines(mainFullOf([], { config: loadConfig(repo), mainRepo: repo, headSha: null, env: { ...env, ...mac } }), 'main').join('\n'), /no nightly job is installed/)

    const kept = install('--uninstall')
    assert.equal(kept.code, 1, kept.out)
    assert.match(kept.out, /removes .*scheduled\.plist: no nightly run of scheduled's full suite on this Mac after that\.\n/)
    assert.match(kept.out, /there is no terminal here to ask "Uninstall it\? \[y\/N\]" at/)
    assert.ok(fs.existsSync(file), 'refused, so kept')
    const removed = install('--uninstall', '--yes')
    assert.equal(removed.code, 0, removed.out)
    assert.match(removed.out, /removed .*dev\.lanekit\.nightly\.scheduled\.plist\n/)
    assert.doesNotMatch(removed.out, /unloaded/)
    assert.equal(fs.existsSync(file), false)
    assert.match(install('--uninstall').out, /nothing to remove: there is no .*scheduled\.plist/)
})

test('at a terminal, --install shows the LaunchAgent and asks "Install it? [y/N]": only y or yes writes it; --uninstall asks the same', { skip: !hasPty && 'no python3 pty here to be a terminal' }, async () => {
    const repo = project('asked', { when: 'nightly', at: '02:00', steps: [step('running everything', 'true')] })
    const file = path.join(env.LANEKIT_LAUNCH_AGENTS, 'dev.lanekit.nightly.asked.plist')
    const mac = { LANEKIT_PLATFORM: 'darwin' }
    for (const answer of ['n', '', 'yep', 'no']) {
        const said = await atTerminal(KITS.main, repo, ['nightly', '--install'], answer, mac)
        assert.ok(said.asked, said.out)
        assert.equal(said.code, 1, `${JSON.stringify(answer)}: ${said.out}`)
        assert.match(said.out, /writes .*asked\.plist:\n[\s\S]*<\/plist>[\s\S]*\n {2}Install it\? \[y\/N\] /, `the question after what it writes: ${said.out.slice(-600)}`)
        assert.match(said.out, /Not done: nothing was written\./)
        assert.equal(fs.existsSync(file), false, `${JSON.stringify(answer)} is no`)
    }
    const yes = await atTerminal(KITS.main, repo, ['nightly', '--install'], 'Yes', mac)
    assert.equal(yes.code, 0, yes.out)
    assert.match(yes.out, /Install it\? \[y\/N\] Yes\n[\s\S]*wrote .*asked\.plist/)
    assert.ok(fs.existsSync(file))
    const no = await atTerminal(KITS.main, repo, ['nightly', '--uninstall'], 'N', mac)
    assert.match(no.out, /Uninstall it\? \[y\/N\] N\n\n {2}Not done: nothing was written\./)
    assert.ok(fs.existsSync(file))
    const gone = await atTerminal(KITS.main, repo, ['nightly', '--uninstall'], 'y', mac)
    assert.equal(gone.code, 0, gone.out)
    assert.match(gone.out, /removed .*asked\.plist/)
    assert.equal(fs.existsSync(file), false)
})

test('the question, answered: y or yes in any case is yes; anything else, and no answer at all, is no', async () => {
    assert.deepEqual(['y', 'Y', 'yes', 'YES', ' yes ', 'n', 'N', '', 'no', 'yep', 'ye', 'y es', undefined].map(isYes),
        [true, true, true, true, true, false, false, false, false, false, false, false, false])
    const ask = async (typed, end = true) => {
        const input = new PassThrough()
        const output = new PassThrough()
        let shown = ''
        output.on('data', (chunk) => { shown += chunk })
        const answer = askYes('Install it? [y/N] ', { input, output })
        if (typed !== null) input.write(typed)
        if (end) input.end()
        return [await answer, shown]
    }
    assert.deepEqual(await ask('y\n'), [true, 'Install it? [y/N] '])
    assert.equal((await ask('yes\n'))[0], true)
    assert.equal((await ask('\n'))[0], false)
    assert.equal((await ask('nope\n'))[0], false)
    assert.equal((await ask(null))[0], false, 'input that ends unanswered')
})

test('a lane\'s lanekit is refused as the one a job names, and the main checkout\'s named instead; a version manager\'s node is said plainly', () => {
    const repo = project('wrongkit', { when: 'nightly', at: '03:00', steps: [step('running everything', 'true')] })
    const file = path.join(env.LANEKIT_LAUNCH_AGENTS, 'dev.lanekit.nightly.wrongkit.plist')
    const mac = { LANEKIT_PLATFORM: 'darwin' }
    const refused = kitLane(KITS.lane, repo, ['nightly', '--install', '--yes'], mac)
    assert.equal(refused.code, 1, refused.out)
    assert.match(refused.out, new RegExp(`refused: ${KITS.lane} is a worktree of ${KITS.main}, not its main checkout: a lane's, which sweep removes once it lands, and the job would run ${path.join(KITS.lane, 'dev', 'full.mjs')} each night\\.`))
    assert.ok(refused.out.includes(`Install it from the main checkout's lanekit: node ${path.join(KITS.main, 'dev', 'lane.mjs')} nightly --install`), refused.out)
    assert.equal(fs.existsSync(file), false)
    assert.doesNotMatch(refused.out, /<plist/, 'refused before anything is shown as to be written')
    // A dry run still shows it, and says it would be refused; a crontab line is refused the same.
    const dry = kitLane(KITS.lane, repo, ['nightly', '--install', '--dry-run'], mac)
    assert.equal(dry.code, 0, dry.out)
    assert.match(dry.out, /would write .*wrongkit\.plist:/)
    assert.match(dry.out, /Without --dry-run this is refused: .* is a worktree of /)
    const cron = kitLane(KITS.lane, repo, ['nightly', '--install'], { LANEKIT_PLATFORM: 'linux' })
    assert.equal(cron.code, 1, cron.out)
    assert.match(cron.out, /refused: .* is a worktree of /)
    assert.doesNotMatch(cron.out, /^3 0 \* \* \*/m)

    assert.equal(kitRefusal(KITS.main), null, 'the main checkout is the one to install from')
    assert.equal(kitRefusal(path.join(KITS.lane, 'lib')).instead, path.join(KITS.main, 'lib'), 'a folder in a lane: the same folder in main')
    assert.equal(kitRefusal(scratch), null, 'a lanekit in no repository at all (a copy) is its own')
    assert.match(kitRefusal(path.join(env.LANEKIT_CACHE, 'full', 'lanekit-1234abcd'), env).why, /is in lanekit's cache, a scratch copy that each full run checks out afresh/)

    // nvm's node first on the PATH: named as it is, and said to break on a switch, with what then says so.
    const nvm = path.join(scratch, 'home', '.nvm', 'versions', 'node', 'v22.23.2', 'bin')
    fs.mkdirSync(nvm, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(nvm, 'node'))
    const warned = kitLane(KITS.main, repo, ['nightly', '--install', '--yes'], { ...mac, PATH: `${nvm}${path.delimiter}${env.PATH}` })
    assert.equal(warned.code, 0, warned.out)
    assert.ok(warned.out.includes(`NOTE: the job runs ${path.join(nvm, 'node')}, nvm's node v22.23.2.\n  It breaks when nvm switches that version out or removes it: no night's run starts after that,\n  and lanes says FULL SUITE OVERDUE a day and a half later. lanekit picks no other node for you;`), warned.out)
    assert.ok(fs.readFileSync(file, 'utf8').includes(`<string>${path.join(nvm, 'node')}</string>`), 'the node it found, not another chosen quietly')
    const plainNode = path.join(scratch, 'usr-local', 'bin')
    fs.mkdirSync(plainNode, { recursive: true })
    fs.symlinkSync(process.execPath, path.join(plainNode, 'node'))
    assert.doesNotMatch(kitLane(KITS.main, repo, ['nightly', '--install', '--dry-run'], { ...mac, PATH: `${plainNode}${path.delimiter}${env.PATH}` }).out, /NOTE: the job runs/, 'a node of no manager\'s is not remarked on')
    assert.match(kitLane(KITS.main, repo, ['nightly', '--install'], { LANEKIT_PLATFORM: 'linux', PATH: `${nvm}${path.delimiter}${env.PATH}` }).out, /NOTE: the job runs .*nvm's node v22\.23\.2/, 'and beside a crontab line')
    assert.deepEqual([
        '/Users/a/.nvm/versions/node/v22.23.2/bin/node', '/Users/a/.local/share/fnm/node-versions/v20.1.0/installation/bin/node',
        '/Users/a/.local/state/fnm_multishells/123_456/bin/node', '/Users/a/.volta/bin/node', '/Users/a/.asdf/installs/nodejs/22.1.0/bin/node',
        '/Users/a/.asdf/shims/node', '/Users/a/.local/share/mise/installs/node/22/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node'
    ].map(nodeManagerOf), [
        { manager: 'nvm', version: 'v22.23.2' }, { manager: 'fnm', version: 'v20.1.0' }, { manager: 'fnm', version: null },
        { manager: 'volta', version: null }, { manager: 'asdf', version: '22.1.0' }, { manager: 'asdf', version: null },
        { manager: 'mise', version: '22' }, null, null
    ])
})

test('elsewhere --install prints a crontab line and edits nothing; a project whose full suite is not nightly has nothing to schedule', () => {
    const repo = project('cron', { when: 'nightly', at: '04:05', steps: [step('running everything', 'true')] })
    const linux = { LANEKIT_PLATFORM: 'linux' }
    const said = kitLane(KITS.main, repo, ['nightly', '--install'], linux)
    assert.equal(said.code, 0, said.out)
    assert.match(said.out, /lanekit does not edit your crontab/)
    assert.doesNotMatch(said.out, /\[y\/N\]/, 'nothing is written, so nothing is asked')
    const line = said.out.split('\n').find((one) => /^5 4 \* \* \* /.test(one))
    assert.ok(line, said.out)
    assert.equal(line, cronLineFor(jobFor({ mainRepo: repo, config: loadConfig(repo), env, kit: KITS.main })))
    assert.match(line, new RegExp(`cd '${repo}' && mkdir -p '.*' && PATH='[^']*' '[^']*node' '${path.join(KITS.main, 'dev', 'full.mjs')}' '--why' 'nightly' '--log' '.*nightly\\.log' >> '.*nightly\\.log' 2>&1$`))
    assert.equal(fs.existsSync(path.join(env.LANEKIT_LAUNCH_AGENTS, 'dev.lanekit.nightly.cron.plist')), false)
    assert.match(kitLane(KITS.main, repo, ['nightly', '--uninstall'], linux).out, /lanekit wrote no crontab line: remove the one/)

    const after = project('nocron', { when: 'after-land', steps: [step('running everything', 'true')] })
    const refused = kitLane(KITS.main, after, ['nightly', '--install'], { LANEKIT_PLATFORM: 'darwin' })
    assert.equal(refused.code, 1)
    assert.match(refused.out, /gate\.full\.when is "after-land", so the full suite runs after each land: there is nothing to run at night/)
    // A plist names its paths escaped.
    assert.match(plistFor({ label: 'l', hour: 3, minute: 0, pathVar: '/a&b', log: '/l', mainRepo: '/w/<x>', args: ['n'] }), /<string>\/w\/&lt;x&gt;<\/string>[\s\S]*<string>\/a&amp;b<\/string>/)
})
