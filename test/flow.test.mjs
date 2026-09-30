/**
 * What a lane needs between being made and landing, asked of scratch repositories with a
 * bare "origin" of their own: `lane rebase` (stopping on a conflict, `--continue`, `--abort`),
 * `lane push` (refusing to replace origin's copy unasked), `lane pr`'s refusals, `lane pull`
 * (a fast-forward, or nothing), and the service's quiet fetch.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing. Nothing here reaches GitHub.
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
/** A lane command, as the page presses it: its exit code and everything it printed. */
const lane = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const commit = (cwd, file, text, message) => {
    fs.writeFileSync(path.join(cwd, file), text)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-qm', message)
}

let scratch, origin, repo, other

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-flow-')))
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    repo = path.join(scratch, 'work', 'demo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: {
            portBase: 19501, portCeiling: 19599, copyOnCreate: [], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\ntwo\nthree\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    // Somebody else, with a clone of their own, who pushes to main.
    other = path.join(scratch, 'other')
    git(scratch, 'clone', '-q', origin, other)
})

after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

test('rebase replays a lane onto main as it is now', () => {
    assert.equal(lane(repo, 'new', 'feature').code, 0)
    const feature = path.join(scratch, 'work', 'demo-feature')
    commit(feature, 'feature.txt', 'feature\n', 'Add the feature')
    commit(repo, 'other.txt', 'other\n', 'Something else on main')
    const done = lane(repo, 'rebase', 'feature')
    assert.equal(done.code, 0, done.out)
    assert.match(done.out, /REBASED/)
    assert.equal(git(feature, 'rev-list', '--count', 'HEAD..main'), '0')
    assert.match(lane(repo, 'rebase', 'feature').out, /on top of main already/)
})

test('rebase refuses uncommitted work, and a lane that is not there', () => {
    const feature = path.join(scratch, 'work', 'demo-feature')
    fs.writeFileSync(path.join(feature, 'loose.txt'), 'loose\n')
    commit(repo, 'more.txt', 'more\n', 'More on main')
    const refused = lane(repo, 'rebase', 'feature')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /uncommitted changes/)
    fs.rmSync(path.join(feature, 'loose.txt'))
    assert.match(lane(repo, 'rebase', 'ghost').out, /no lane called "ghost"/)
})

test('a conflict stops the rebase with its files named; --continue waits for them, then carries on', () => {
    assert.equal(lane(repo, 'new', 'clash').code, 0)
    const clash = path.join(scratch, 'work', 'demo-clash')
    commit(clash, 'app.txt', 'one\nTWO in the lane\nthree\n', 'Change two in the lane')
    commit(repo, 'app.txt', 'one\nTWO on main\nthree\n', 'Change two on main')
    const stopped = lane(repo, 'rebase', 'clash')
    assert.equal(stopped.code, 1)
    assert.match(stopped.out, /stopped part-way through the rebase: 1 file conflicts/)
    assert.match(stopped.out, /app\.txt/)
    const lanes = repoState(repo).lanes
    const read = lanes.find((candidate) => candidate.name === 'clash')
    assert.equal(read.operation, 'rebase')
    assert.deepEqual(read.conflicts, ['app.txt'])

    const early = lane(repo, 'rebase', 'clash', '--continue')
    assert.equal(early.code, 1)
    assert.match(early.out, /still has conflict markers/)
    fs.writeFileSync(path.join(clash, 'app.txt'), 'one\nTWO, both\nthree\n')
    const carried = lane(repo, 'rebase', 'clash', '--continue')
    assert.equal(carried.code, 0, carried.out)
    assert.match(carried.out, /staged 1 resolved file/)
    assert.equal(fs.readFileSync(path.join(clash, 'app.txt'), 'utf8'), 'one\nTWO, both\nthree\n')
    assert.equal(repoState(repo).lanes.find((candidate) => candidate.name === 'clash').operation, null)
})

test('--abort puts a lane back as it was before the rebase', () => {
    const clash = path.join(scratch, 'work', 'demo-clash')
    const before = git(clash, 'rev-parse', 'HEAD')
    commit(repo, 'app.txt', 'one\nTWO on main, again\nthree\n', 'Change two on main again')
    assert.equal(lane(repo, 'rebase', 'clash').code, 1)
    const aborted = lane(repo, 'rebase', 'clash', '--abort')
    assert.equal(aborted.code, 0, aborted.out)
    assert.equal(git(clash, 'rev-parse', 'HEAD'), before)
    assert.match(lane(repo, 'rebase', 'clash', '--abort').out, /not part-way through a rebase/)
})

test('push sends a lane to origin, and will not replace origin\'s copy unasked', () => {
    const feature = path.join(scratch, 'work', 'demo-feature')
    const first = lane(repo, 'push', 'feature')
    assert.equal(first.code, 0, first.out)
    assert.match(first.out, /PUSHED/)
    assert.equal(git(origin, 'rev-parse', 'feature'), git(feature, 'rev-parse', 'HEAD'))
    assert.match(lane(repo, 'push', 'feature').out, /pushed already/)

    // Rebased after it was pushed: origin's copy is no longer an ancestor.
    assert.equal(lane(repo, 'rebase', 'feature').code, 0)
    const refused = lane(repo, 'push', 'feature')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /rebased since it was pushed/)
    assert.match(refused.out, /--force-with-lease/)
    const replaced = lane(repo, 'push', 'feature', '--force-with-lease')
    assert.equal(replaced.code, 0, replaced.out)
    assert.equal(git(origin, 'rev-parse', 'feature'), git(feature, 'rev-parse', 'HEAD'))
})

test('pr says what it needs first', () => {
    const noGh = lane(repo, 'pr', 'clash')
    // With gh on this machine the lane is not pushed yet; without it, gh's absence is said.
    assert.equal(noGh.code, 1)
    assert.match(noGh.out, /not pushed yet|gh is not installed/)
    const bare = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'pr', 'feature'], {
        cwd: repo, encoding: 'utf8', env: { ...env, PATH: path.dirname(execFileSync('which', ['git'], { encoding: 'utf8' }).trim()) }
    })
    assert.match(`${bare.stdout}${bare.stderr}`, /gh is not installed/)
})

test('pull fast-forwards main to origin, and refuses a main that has diverged', () => {
    git(repo, 'push', '-q', 'origin', 'main')
    git(other, 'pull', '-q', 'origin', 'main')
    commit(other, 'theirs.txt', 'theirs\n', 'Somebody else lands')
    git(other, 'push', '-q', 'origin', 'main')
    git(repo, 'fetch', '-q', 'origin')
    const pulled = lane(repo, 'pull')
    assert.equal(pulled.code, 0, pulled.out)
    assert.match(pulled.out, /PULLED/)
    assert.ok(fs.existsSync(path.join(repo, 'theirs.txt')))
    assert.match(lane(repo, 'pull').out, /has everything/)

    commit(repo, 'mine.txt', 'mine\n', 'Mine, not pushed')
    commit(other, 'again.txt', 'again\n', 'Theirs again')
    git(other, 'push', '-q', 'origin', 'main')
    git(repo, 'fetch', '-q', 'origin')
    const diverged = lane(repo, 'pull')
    assert.equal(diverged.code, 1)
    assert.match(diverged.out, /diverged/)
})

test('the service fetches by itself, says when, and says why a fetch failed', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    await service.state()
    commit(other, 'late.txt', 'late\n', 'A late push')
    git(other, 'push', '-q', 'origin', 'main')
    assert.equal(await service.fetchQuietly({ every: 0 }), true)
    const state = await service.state()
    const demo = state.repos[0]
    assert.equal(demo.fetchError, null)
    assert.ok(demo.main.fetchedAt && Date.now() - demo.main.fetchedAt < 60_000)
    assert.equal(git(repo, 'rev-parse', 'origin/main'), git(other, 'rev-parse', 'HEAD'))
    assert.equal(await service.fetchQuietly(), false, 'not again within five minutes')

    git(repo, 'remote', 'set-url', 'origin', path.join(scratch, 'nowhere.git'))
    await service.fetchQuietly({ every: 0 })
    assert.ok((await service.state()).repos[0].fetchError, 'a failed fetch is kept and said')
    git(repo, 'remote', 'set-url', 'origin', origin)
    service.dispose()
})

test('the page\'s presses refuse what the commands would, before anything runs', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    await service.state()
    const feature = path.join(scratch, 'work', 'demo-feature')
    fs.writeFileSync(path.join(feature, 'loose.txt'), 'loose\n')
    const dirty = await service.press({ repo: 'demo', verb: 'rebase', lane: 'feature' })
    assert.equal(dirty.status, 409)
    assert.match(dirty.body.error, /uncommitted/)
    fs.rmSync(path.join(feature, 'loose.txt'))
    const notMid = await service.press({ repo: 'demo', verb: 'rebase', lane: 'feature', continue: true })
    assert.equal(notMid.status, 409)
    assert.match(notMid.body.error, /not part-way/)
    const pressed = await service.press({ repo: 'demo', verb: 'push', lane: 'feature', force: true })
    assert.equal(pressed.status, 202)
    assert.match(pressed.body.command, /lane\.mjs push feature --force-with-lease/)
    await new Promise((resolve) => service.events.once('done', resolve))
    service.dispose()
})
