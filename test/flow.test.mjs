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
import { checksOf } from '../lib/github.mjs'

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

test('a failed gate keeps the failing step and its last lines, and the page reads them', async () => {
    const broken = path.join(scratch, 'work2', 'broken')
    fs.mkdirSync(broken, { recursive: true })
    fs.writeFileSync(path.join(broken, 'lane.config.json'), JSON.stringify({
        name: 'Broken', slug: 'broken', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'the tests', steps: [{ what: 'running the tests', command: 'sh', args: ['-c', "echo 'all fine so far'; echo 'src/app.js:12:3: expected 2, got 3' >&2; exit 3"] }] } } },
        lane: { portBase: 19401, portCeiling: 19499, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    fs.writeFileSync(path.join(broken, '.gitignore'), '.env\n.lanekit/\n')
    git(path.dirname(broken), 'init', '-q', '-b', 'main', broken)
    git(broken, 'add', '-A')
    git(broken, 'commit', '-qm', 'Begin')
    assert.equal(lane(broken, 'new', 'bug').code, 0)
    const bug = path.join(scratch, 'work2', 'broken-bug')
    commit(bug, 'app.js', 'let x = 3\n', 'Break it')

    const service = createService({ dirs: [path.join(scratch, 'work2')] })
    await service.state()
    const pressed = await service.press({ repo: 'broken', verb: 'gate', lane: 'bug' })
    assert.equal(pressed.status, 202)
    const done = await new Promise((resolve) => service.events.on('done', (job) => { if (job.id === pressed.body.id) resolve(job) }))
    assert.notEqual(done.code, 0)
    assert.ok(done.step, 'the job knows the step the gate was on')
    const read = (await service.state()).repos[0].lanes.find((candidate) => candidate.name === 'bug')
    assert.equal(read.gate.result, 'failed')
    assert.equal(read.gate.current, true)
    assert.equal(read.gate.failures[0].what, 'running the tests')
    assert.equal(read.gate.failures[0].status, 3)
    assert.match(read.gate.failures[0].tail, /src\/app\.js:12:3: expected 2, got 3/)
    assert.match(read.gate.failures[0].tail, /all fine so far/)
    service.dispose()
})

test('commit takes everything uncommitted with its message; --amend folds into the lane\'s newest, never main\'s', () => {
    assert.equal(lane(repo, 'new', 'writing').code, 0)
    const writing = path.join(scratch, 'work', 'demo-writing')
    const nothing = lane(repo, 'commit', 'writing', '-m', 'Nothing yet')
    assert.equal(nothing.code, 1)
    assert.match(nothing.out, /nothing uncommitted/)
    const own = lane(repo, 'commit', 'writing', '--amend')
    assert.equal(own.code, 1, 'a lane with no commit of its own has main\'s at its head')
    assert.match(own.out, /no commit of its own to amend/)

    fs.writeFileSync(path.join(writing, 'draft.txt'), 'draft\n')
    fs.writeFileSync(path.join(writing, 'app.txt'), 'changed in the lane\n')
    assert.match(lane(repo, 'commit', 'writing').out, /needs a message/)
    const made = lane(repo, 'commit', 'writing', '-m', 'Write the first draft')
    assert.equal(made.code, 0, made.out)
    assert.match(made.out, /COMMITTED/)
    assert.equal(git(writing, 'status', '--porcelain'), '', 'new files and changed ones alike')
    assert.equal(git(writing, 'log', '-1', '--format=%s'), 'Write the first draft')

    fs.writeFileSync(path.join(writing, 'draft.txt'), 'draft, better\n')
    const amended = lane(repo, 'commit', 'writing', '--amend')
    assert.equal(amended.code, 0, amended.out)
    assert.equal(git(writing, 'log', '-1', '--format=%s'), 'Write the first draft', 'the message kept')
    assert.equal(git(writing, 'rev-list', '--count', 'main..HEAD'), '1', 'still one commit of its own')
    assert.equal(git(writing, 'show', 'HEAD:draft.txt'), 'draft, better')
})

test('rebase --onto moves a lane to another commit of main, and never replays main\'s own commits', () => {
    const writing = path.join(scratch, 'work', 'demo-writing')
    const mainLine = git(repo, 'rev-list', '--first-parent', 'main').split('\n')
    const older = mainLine[2]
    const moved = lane(repo, 'rebase', 'writing', '--onto', older)
    assert.equal(moved.code, 0, moved.out)
    assert.equal(git(writing, 'merge-base', 'HEAD', 'main'), older, 'it starts from the commit it was dropped on')
    assert.equal(git(writing, 'rev-list', '--count', `${older}..HEAD`), '1', 'only its own commit on top')
    const back = lane(repo, 'rebase', 'writing')
    assert.equal(back.code, 0, back.out)
    assert.equal(git(writing, 'merge-base', 'HEAD', 'main'), git(repo, 'rev-parse', 'main'))
    const stranger = git(writing, 'rev-parse', 'HEAD')
    const refused = lane(repo, 'rebase', 'writing', '--onto', stranger)
    assert.equal(refused.code, 1)
    assert.match(refused.out, /not on main/)
})

test('the page\'s commit, rebase-onto and new-lane-here presses are held to the same rules', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    const state = await service.state()
    const demo = state.repos.find((candidate) => candidate.id === 'demo')
    assert.ok(demo.lanes.find((candidate) => candidate.name === 'writing').changes, 'each lane carries its uncommitted files')
    // A file changed but not staged has a status column that begins with a space: read whole, first entry too.
    const writing = path.join(scratch, 'work', 'demo-writing')
    fs.writeFileSync(path.join(writing, 'draft.txt'), 'draft, changed again\n')
    fs.writeFileSync(path.join(writing, 'zz-new.txt'), 'new\n')
    const read = (await service.state()).repos.find((candidate) => candidate.id === 'demo').lanes.find((candidate) => candidate.name === 'writing')
    assert.deepEqual(read.changes, [{ status: 'M', path: 'draft.txt' }, { status: '?', path: 'zz-new.txt' }])
    git(writing, 'checkout', '--', 'draft.txt')
    fs.rmSync(path.join(writing, 'zz-new.txt'))
    assert.equal((await service.press({ repo: 'demo', verb: 'commit', lane: 'writing', message: '' })).status, 400)
    assert.equal((await service.press({ repo: 'demo', verb: 'commit', lane: 'writing', message: 'x' })).status, 409, 'nothing uncommitted')
    assert.equal((await service.press({ repo: 'demo', verb: 'rebase', lane: 'writing', onto: 'deadbeef' })).status, 400, 'not one of main\'s commits')
    const tip = demo.spine[1]
    const made = await service.press({ repo: 'demo', verb: 'new', name: 'from-there', base: tip.sha })
    assert.equal(made.status, 202)
    assert.match(made.body.command, new RegExp(`lane\\.mjs new from-there --base ${tip.sha}`))
    await new Promise((resolve) => service.events.on('done', (job) => { if (job.id === made.body.id) resolve() }))
    const fresh = path.join(scratch, 'work', 'demo-from-there')
    assert.equal(git(fresh, 'rev-parse', 'HEAD'), tip.sha, 'the new lane starts from the commit it was made on')
    service.dispose()
})

test('commit takes only the files named, and --amend with a message alone rewords the newest commit', () => {
    assert.equal(lane(repo, 'new', 'parts').code, 0)
    const parts = path.join(scratch, 'work', 'demo-parts')
    fs.writeFileSync(path.join(parts, 'one.txt'), 'one\n')
    fs.writeFileSync(path.join(parts, 'two.txt'), 'two\n')
    fs.writeFileSync(path.join(parts, 'app.txt'), 'changed in parts\n')
    const stray = lane(repo, 'commit', 'parts', '-m', 'Nothing here', '--', 'nowhere.txt')
    assert.equal(stray.code, 1)
    assert.match(stray.out, /not uncommitted in parts: nowhere\.txt/)
    const some = lane(repo, 'commit', 'parts', '-m', 'Add the first file', '--', 'one.txt', 'app.txt')
    assert.equal(some.code, 0, some.out)
    assert.deepEqual(git(parts, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['app.txt', 'one.txt'])
    assert.equal(git(parts, 'status', '--porcelain'), '?? two.txt', 'the file not named is still uncommitted')
    assert.equal(lane(repo, 'commit', 'parts', '-m', 'Add the second', '--', 'two.txt').code, 0)
    const bare = lane(repo, 'commit', 'parts', '--amend')
    assert.equal(bare.code, 1, 'an amend with nothing to fold in and no new words does nothing')
    assert.match(bare.out, /give a new message/)
    const reworded = lane(repo, 'commit', 'parts', '--amend', '-m', 'Add the second file\n\nIt says two.')
    assert.equal(reworded.code, 0, reworded.out)
    assert.equal(git(parts, 'log', '-1', '--format=%s'), 'Add the second file')
    assert.equal(git(parts, 'log', '-1', '--format=%b'), 'It says two.')
    assert.equal(git(parts, 'rev-list', '--count', 'main..HEAD'), '2', 'reworded, not added to')
})

test('uncommit takes the newest commit back into uncommitted work, and never one of main\'s', () => {
    const parts = path.join(scratch, 'work', 'demo-parts')
    const once = lane(repo, 'uncommit', 'parts')
    assert.equal(once.code, 0, once.out)
    assert.match(once.out, /UNCOMMITTED/)
    assert.equal(git(parts, 'rev-list', '--count', 'main..HEAD'), '1')
    assert.equal(git(parts, 'status', '--porcelain'), 'A  two.txt', 'what it changed is uncommitted again')
    assert.equal(lane(repo, 'uncommit', 'parts').code, 0)
    const refused = lane(repo, 'uncommit', 'parts')
    assert.equal(refused.code, 1, 'main\'s commit is not the lane\'s to take back')
    assert.match(refused.out, /no commit of its own/)
})

test('discard throws away only the files named: a changed file goes back, a new one goes', () => {
    const parts = path.join(scratch, 'work', 'demo-parts')
    fs.writeFileSync(path.join(parts, 'three.txt'), 'three\n')
    const none = lane(repo, 'discard', 'parts')
    assert.equal(none.code, 1)
    assert.match(none.out, /needs the files/)
    const stray = lane(repo, 'discard', 'parts', '--', 'nowhere.txt')
    assert.equal(stray.code, 1)
    const thrown = lane(repo, 'discard', 'parts', '--', 'app.txt', 'three.txt', 'one.txt')
    assert.equal(thrown.code, 0, thrown.out)
    assert.equal(fs.readFileSync(path.join(parts, 'app.txt'), 'utf8'), fs.readFileSync(path.join(repo, 'app.txt'), 'utf8'), 'the changed file is as main has it')
    assert.ok(!fs.existsSync(path.join(parts, 'three.txt')), 'the new file is gone')
    assert.ok(!fs.existsSync(path.join(parts, 'one.txt')), 'and the added one')
    assert.equal(git(parts, 'status', '--porcelain'), 'A  two.txt', 'the file not named is untouched')
})

test('the page\'s uncommit, discard, resolve and partial commit are held to the same rules, and a commit\'s details carry its words and files', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    await service.state()
    assert.equal((await service.press({ repo: 'demo', verb: 'discard', lane: 'parts' })).status, 400, 'a discard names its files')
    assert.equal((await service.press({ repo: 'demo', verb: 'discard', lane: 'parts', paths: ['../outside.txt'] })).status, 400)
    assert.equal((await service.press({ repo: 'demo', verb: 'commit', lane: 'parts', message: 'x', paths: ['nowhere.txt'] })).status, 400)
    assert.equal((await service.press({ repo: 'demo', verb: 'resolve', lane: 'parts', paths: ['two.txt'] })).status, 409, 'not part-way through a rebase')
    assert.equal((await service.press({ repo: 'demo', verb: 'uncommit', lane: 'from-there' })).status, 409, 'no commit of its own')
    const partly = await service.press({ repo: 'demo', verb: 'commit', lane: 'parts', message: 'Add the second file', paths: ['two.txt'] })
    assert.equal(partly.status, 202)
    assert.match(partly.body.command, /lane\.mjs commit parts -m Add the second file -- two\.txt$/)
    await new Promise((resolve) => service.events.on('done', (job) => { if (job.id === partly.body.id) resolve() }))
    const demo = (await service.state()).repos.find((candidate) => candidate.id === 'demo')
    assert.equal(demo.main.upstream.sha, git(repo, 'rev-parse', 'origin/main'), 'where origin\'s main is, for its tag')
    const details = await service.commitDetails(demo.path, demo.spine[0].sha)
    assert.equal(details.subject, demo.spine[0].subject)
    assert.equal(details.author, 'Test')
    assert.ok(details.at > 0 && details.files.length > 0)
    assert.equal(await service.commitDetails(demo.path, 'deadbeef'), null)
    service.dispose()
})

test('resolve marks a conflicted file once its markers are gone, and refuses while one is left', () => {
    assert.equal(lane(repo, 'new', 'tangle').code, 0)
    const tangle = path.join(scratch, 'work', 'demo-tangle')
    commit(tangle, 'app.txt', 'the lane\'s side\n', 'Change the app in the lane')
    commit(repo, 'app.txt', 'main\'s side\n', 'Change the app on main')
    const stopped = lane(repo, 'rebase', 'tangle')
    assert.equal(stopped.code, 1, stopped.out)
    assert.match(lane(repo, 'resolve', 'tangle').out, /needs the files/)
    assert.match(lane(repo, 'resolve', 'tangle', '--', 'nowhere.txt').out, /not in conflict/)
    const marked = lane(repo, 'resolve', 'tangle', '--', 'app.txt')
    assert.equal(marked.code, 1, 'markers still in it')
    assert.match(marked.out, /still has a conflict marker at line 1/)
    fs.writeFileSync(path.join(tangle, 'app.txt'), 'both sides, resolved\n')
    const resolved = lane(repo, 'resolve', 'tangle', '--', 'app.txt')
    assert.equal(resolved.code, 0, resolved.out)
    assert.match(resolved.out, /every conflict is resolved/)
    const carried = lane(repo, 'rebase', 'tangle', '--continue')
    assert.equal(carried.code, 0, carried.out)
    assert.equal(git(tangle, 'show', 'HEAD:app.txt'), 'both sides, resolved')
})

test('a pull request\'s checks are said in a word', () => {
    assert.equal(checksOf([]), 'none')
    assert.equal(checksOf(null), 'none')
    assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }]), 'passing')
    assert.equal(checksOf([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }]), 'pending')
    assert.equal(checksOf([{ status: 'COMPLETED', conclusion: 'FAILURE' }, { status: 'IN_PROGRESS' }]), 'failing')
    assert.equal(checksOf([{ state: 'ERROR' }]), 'failing')
})
