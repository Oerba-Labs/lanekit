/**
 * Moving a lane along main, back and forward, and what happens when it conflicts: `lane rebase --onto` an older commit
 * and a newer one, the printed way back, a rebase that stops because the lane needs what it was moved away from,
 * Abort and Continue, the gate that moves a lane onto main's newest before it tests (and aborts when that conflicts),
 * a pushed lane moved back, a press waiting behind a rebase that stopped, and the page's own words for a drop.
 *
 * Its own scratch repository and origin, so the order of these tests is the only order that matters here.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { createService } from '../lib/service.mjs'
import { repoState } from '../lib/state.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const run = (cwd, script, ...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', script), ...args], { cwd, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const lane = (...args) => run(repo, 'lane.mjs', ...args)
const gate = (dir) => run(dir, 'gate.mjs')
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)
const commit = (cwd, file, text, message) => { write(cwd, file, text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }
const laneDir = (name) => path.join(work, `demo-${name}`)
const read = (name) => repoState(repo).lanes.find((candidate) => candidate.name === name)
/** The commit a lane forks from main at. */
const forkOf = (name) => git(laneDir(name), 'merge-base', 'HEAD', 'main')

let scratch, work, repo, origin
const main = {}   // main's commits by what they did: begin, title, two, notes

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-rebase-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: { portBase: 19801, portCeiling: 19899, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, 'app.txt', 'one\ntwo\nthree\n', 'Begin')
    main.begin = git(repo, 'rev-parse', 'HEAD')
    commit(repo, 'title.txt', 'Demo\n', 'Add a title')
    main.title = git(repo, 'rev-parse', 'HEAD')
    commit(repo, 'app.txt', 'one\nTWO on main\nthree\n', 'Change two on main')
    main.two = git(repo, 'rev-parse', 'HEAD')
    commit(repo, 'notes.txt', 'notes\n', 'Add notes')
    main.notes = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
})

after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

test('moved back, a lane keeps its own commits, leaves main\'s newer ones out, and the command it printed puts it back', () => {
    assert.equal(lane('new', 'drift').code, 0)
    commit(laneDir('drift'), 'feature.txt', 'feature\n', 'Add the feature')
    const before = git(laneDir('drift'), 'rev-parse', 'HEAD')

    const moved = lane('rebase', 'drift', '--onto', main.title)
    assert.equal(moved.code, 0, moved.out)
    assert.equal(forkOf('drift'), main.title, 'it starts from the older commit')
    assert.equal(git(laneDir('drift'), 'rev-list', '--count', `${main.title}..HEAD`), '1', 'its one commit, and nothing of main\'s on top')
    assert.equal(git(laneDir('drift'), 'log', '-1', '--format=%s'), 'Add the feature')
    assert.ok(!fs.existsSync(path.join(laneDir('drift'), 'notes.txt')), 'main\'s newer commits are not under it')
    assert.equal(read('drift').behind, 2, 'and it says how far behind main it is now')
    assert.equal(read('drift').base, main.title)

    const back = /git reset --hard ([0-9a-f]+) puts it back/.exec(moved.out)
    assert.ok(back, `the way back is printed: ${moved.out}`)
    git(laneDir('drift'), 'reset', '-q', '--hard', back[1])
    assert.equal(git(laneDir('drift'), 'rev-parse', 'HEAD'), before, 'and it is the way back')
})

test('moved forward onto a newer commit of main, a lane gains what is between, and nothing of main\'s is replayed', () => {
    assert.equal(lane('rebase', 'drift', '--onto', main.begin).code, 0)
    const forward = lane('rebase', 'drift', '--onto', main.two)
    assert.equal(forward.code, 0, forward.out)
    assert.equal(forkOf('drift'), main.two)
    assert.equal(git(laneDir('drift'), 'rev-list', '--count', `${main.two}..HEAD`), '1')
    assert.ok(fs.existsSync(path.join(laneDir('drift'), 'title.txt')), 'what main added between is under it now')
    const same = lane('rebase', 'drift', '--onto', main.two)
    assert.equal(same.code, 0)
    assert.match(same.out, /on [0-9a-f]{7} already/, 'onto where it starts is nothing to do')
})

test('a lane moved back past what its commits need stops on the files that conflict; Abort puts it back exactly, and resolving carries it on', () => {
    assert.equal(lane('new', 'tied').code, 0)
    // The lane changes the line main's "Change two on main" changed: moved back past that commit, it cannot apply.
    commit(laneDir('tied'), 'app.txt', 'one\nTWO on main, and the lane\nthree\n', 'Build on main\'s two')
    const before = git(laneDir('tied'), 'rev-parse', 'HEAD')

    const stopped = lane('rebase', 'tied', '--onto', main.title)
    assert.equal(stopped.code, 1)
    assert.match(stopped.out, /stopped part-way through the rebase: 1 file conflicts/)
    assert.match(stopped.out, /app\.txt/)
    assert.equal(read('tied').operation, 'rebase')
    assert.deepEqual(read('tied').conflicts, ['app.txt'])
    assert.equal(lane('commit', 'tied', '-m', 'Not now').code, 1, 'nothing else is done to a lane part-way through a rebase')

    const aborted = lane('rebase', 'tied', '--abort')
    assert.equal(aborted.code, 0, aborted.out)
    assert.equal(git(laneDir('tied'), 'rev-parse', 'HEAD'), before, 'Abort puts it back exactly')
    assert.equal(forkOf('tied'), main.notes)
    assert.equal(read('tied').operation, null)

    assert.equal(lane('rebase', 'tied', '--onto', main.title).code, 1)
    assert.match(lane('resolve', 'tied', '--', 'app.txt').out, /still has a conflict marker/, 'not resolved while a marker is left')
    write(laneDir('tied'), 'app.txt', 'one\ntwo, and the lane\nthree\n')
    assert.equal(lane('resolve', 'tied', '--', 'app.txt').code, 0)
    const carried = lane('rebase', 'tied', '--continue')
    assert.equal(carried.code, 0, carried.out)
    assert.equal(forkOf('tied'), main.title, 'resolved, it starts where it was dropped')
    assert.equal(git(laneDir('tied'), 'log', '-1', '--format=%s'), 'Build on main\'s two', 'its commit kept, with its words')
    assert.equal(git(laneDir('tied'), 'show', 'HEAD:app.txt'), 'one\ntwo, and the lane\nthree')
})

test('the gate moves a lane that was moved back onto main\'s newest before it tests, so it never lands from the old place', () => {
    assert.equal(lane('rebase', 'drift', '--onto', main.title).code, 0)
    assert.equal(forkOf('drift'), main.title)
    const gated = gate(laneDir('drift'))
    assert.equal(gated.code, 0, gated.out)
    assert.match(gated.out, /rebased onto main/)
    assert.match(gated.out, /READY/)
    assert.equal(forkOf('drift'), git(repo, 'rev-parse', 'main'), 'it was tested on top of main as main is')
    assert.equal(read('drift').gate.current, true, 'and the result names the commit it is at now')
})

test('a pushed lane moved back is not pushed over origin\'s copy unasked', () => {
    assert.equal(lane('new', 'shared').code, 0)
    commit(laneDir('shared'), 'shared.txt', 'shared\n', 'Share something')
    assert.equal(lane('push', 'shared').code, 0)
    assert.equal(lane('rebase', 'shared', '--onto', main.title).code, 0)
    const refused = lane('push', 'shared')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /rebased since it was pushed/)
    assert.match(refused.out, /--force-with-lease/)
    const replaced = lane('push', 'shared', '--force-with-lease')
    assert.equal(replaced.code, 0, replaced.out)
    assert.equal(git(laneDir('shared'), 'rev-parse', 'origin/shared'), git(laneDir('shared'), 'rev-parse', 'HEAD'))
})

test('a press waiting behind a rebase that stops on a conflict is refused when its turn comes, and Abort can still be pressed', async () => {
    assert.equal(lane('new', 'waits').code, 0)
    commit(laneDir('waits'), 'app.txt', 'one\nTWO in waits\nthree\n', 'Change two in waits')
    const before = git(laneDir('waits'), 'rev-parse', 'HEAD')
    commit(repo, 'app.txt', 'one\nTWO on main, later\nthree\n', 'Change two on main again')

    const service = createService({ dirs: [work] })
    const finished = (id) => new Promise((resolve) => {
        const kept = service.job(id)
        if (kept?.state === 'done') return resolve(kept)
        service.events.on('done', (job) => { if (job.id === id) resolve(service.job(id)) })
    })
    // A gate that takes a moment holds the repository, so both presses below wait their turn behind it: the push is
    // planned as possible, and only when its turn comes is the lane found part-way through the rebase before it.
    assert.equal(lane('new', 'slow').code, 0)
    const slowConfig = JSON.parse(fs.readFileSync(path.join(laneDir('slow'), 'lane.config.json'), 'utf8'))
    slowConfig.gate.tiers[1].steps = [{ what: 'waiting a moment', command: 'sh', args: ['-c', 'sleep 2'] }]
    commit(laneDir('slow'), 'lane.config.json', JSON.stringify(slowConfig), 'Take a moment to gate')
    await service.state()
    const slow = await service.press({ repo: 'demo', verb: 'gate', lane: 'slow' })
    assert.equal(slow.body.state, 'running')
    const rebase = await service.press({ repo: 'demo', verb: 'rebase', lane: 'waits' })
    assert.equal(rebase.status, 202)
    assert.equal(rebase.body.state, 'queued')
    const push = await service.press({ repo: 'demo', verb: 'push', lane: 'waits' })
    assert.equal(push.status, 202, push.body?.error)
    assert.equal(push.body.state, 'queued', 'pressed while the repository is busy, the push waits its turn')
    assert.equal((await finished(slow.body.id)).code, 0)

    assert.equal((await finished(rebase.body.id)).code, 1, 'the rebase stops on the conflict')
    const pushed = await finished(push.body.id)
    assert.equal(pushed.code, -1)
    assert.match(pushed.output, /Not run: when its turn came, waits is part-way through a rebase/)
    assert.equal(git(laneDir('waits'), 'rev-parse', 'origin/main'), git(repo, 'rev-parse', 'origin/main'), 'and nothing was pushed')

    assert.equal((await service.press({ repo: 'demo', verb: 'commit', lane: 'waits', message: 'Not now' })).status, 409)
    const abort = await service.press({ repo: 'demo', verb: 'rebase', lane: 'waits', abort: true })
    assert.equal(abort.status, 202)
    assert.equal((await finished(abort.body.id)).code, 0)
    assert.equal(git(laneDir('waits'), 'rev-parse', 'HEAD'), before, 'Abort puts it back as it was')
    service.dispose()
})

test('a gate whose rebase onto main conflicts fails, and leaves the lane exactly as it was', () => {
    const before = git(laneDir('waits'), 'rev-parse', 'HEAD')
    const fork = forkOf('waits')
    const gated = gate(laneDir('waits'))
    assert.equal(gated.code, 1)
    assert.match(gated.out, /does not apply to main any more/)
    assert.match(gated.out, /Nothing was changed/)
    assert.equal(git(laneDir('waits'), 'rev-parse', 'HEAD'), before)
    assert.equal(forkOf('waits'), fork)
    assert.equal(read('waits').operation, null, 'not left part-way through a rebase')
})

test('the page says which way a drop moves a lane, and past which of main\'s commits', () => {
    // ontoOf, read from the page as it is written there and run here: plain data in and out.
    const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
    const start = page.indexOf('const ontoOf = ')
    assert.notEqual(start, -1, 'the page has ontoOf')
    const source = page.slice(start, page.indexOf('\n}\n', start) + 2)
    const ontoOf = new Function(`${source}; return ontoOf`)()
    const spine = ['s0', 's1', 's2', 's3', 's4'].map((sha) => ({ sha, subject: sha }))
    const back = ontoOf(spine, 's1', 's3')
    assert.equal(back.way, 'back')
    assert.equal(back.count, 2)
    assert.deepEqual(back.commits.map((commit) => commit.sha), ['s1', 's2'], 'the commits it would no longer have under it')
    const forward = ontoOf(spine, 's3', 's0')
    assert.equal(forward.way, 'forward')
    assert.deepEqual(forward.commits.map((commit) => commit.sha), ['s0', 's1', 's2'], 'the commits it would gain')
    assert.equal(ontoOf(spine, 's2', 's2').way, 'here')
    assert.deepEqual(ontoOf(spine, 'further-back', 's4'), { way: 'forward', count: null, commits: [] }, 'a fork older than the log: any drop moves it forward')
    assert.equal(ontoOf(spine, 's1', 'elsewhere').way, 'unknown')
})
