/**
 * Work begun in the wrong place, and branches that moved on without you, asked of scratch repositories with a bare
 * "origin" and a second clone that pushes to it: `lane new --carry` (the main checkout's uncommitted files, or a lane's
 * files and the commits it made after one, moved into a lane of their own, or nothing moved at all), `lane pull <lane>`
 * (a lane fast-forwarded to what somebody pushed to it), `lane pull` fetching first, `lane push` never replacing
 * somebody else's commits, `lane discard --main`, and the page's presses for each held to the same rules.
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
const gitOk = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status === 0
const laneIn = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const lane = (...args) => laneIn(repo, ...args)
const write = (cwd, file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text) }
const read = (cwd, file) => fs.readFileSync(path.join(cwd, file), 'utf8')
const commit = (cwd, file, text, message) => {
    write(cwd, file, text)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-qm', message)
}
const laneDir = (name) => path.join(work, `demo-${name}`)
// Untrimmed: a status column may begin with a space.
const status = (cwd) => execFileSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8' }).split('\n').filter(Boolean).sort()
const laneOf = (name) => repoState(repo).lanes.find((candidate) => candidate.name === name)

let scratch, work, repo, origin, other

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-carry-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: { portBase: 19701, portCeiling: 19799, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    write(repo, 'app.txt', 'one\ntwo\nthree\n')
    write(repo, 'old-name.txt', 'renamed soon\n')
    write(repo, 'gone.txt', 'deleted soon\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    // Somebody else, with a clone of their own, who pushes to main and to a lane's branch.
    other = path.join(scratch, 'other')
    git(scratch, 'clone', '-q', origin, other)
})

after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

test('the main checkout\'s uncommitted files are read one by one, a rename with the name it had', () => {
    write(repo, 'app.txt', 'one\ntwo, changed in main\nthree\n')
    write(repo, 'notes/new file [draft].txt', 'begun in main\n')
    git(repo, 'mv', 'old-name.txt', 'new-name.txt')
    fs.rmSync(path.join(repo, 'gone.txt'))
    const main = repoState(repo).main
    assert.equal(main.dirty, 4)
    const by = Object.fromEntries(main.changes.map((change) => [change.path, change]))
    assert.equal(by['app.txt'].status, 'M')
    assert.equal(by['gone.txt'].status, 'D')
    assert.equal(by['notes/'].status, '?', 'a new folder, as git status says it')
    assert.deepEqual(by['new-name.txt'], { status: 'R', path: 'new-name.txt', from: 'old-name.txt' })
})

test('lane new --carry -- <file> moves only the files named into a lane started where main is, and leaves the rest', () => {
    const stray = lane('new', 'part', '--carry', '--', 'nope.txt')
    assert.equal(stray.code, 1)
    assert.match(stray.out, /not uncommitted in the main checkout: nope\.txt/)
    assert.ok(!fs.existsSync(laneDir('part')), 'nothing made for a refusal')

    const moved = lane('new', 'part', '--carry', '--', 'app.txt', 'new-name.txt')
    assert.equal(moved.code, 0, moved.out)
    assert.match(moved.out, /lane "part" ready/)
    assert.match(moved.out, /keeps 2 uncommitted files it did not carry/)
    assert.equal(git(laneDir('part'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'main'), 'started on the commit the files were made on')
    assert.deepEqual(status(laneDir('part')), ['M  app.txt', 'R  old-name.txt -> new-name.txt'], 'a rename arrives as a rename')
    assert.equal(read(laneDir('part'), 'app.txt'), 'one\ntwo, changed in main\nthree\n')
    assert.deepEqual(status(repo), [' D gone.txt', '?? notes/'], 'what was not named stays in main, and only that')
    assert.equal(git(repo, 'stash', 'list'), '', 'nothing left in git\'s stash')
})

test('lane new --carry moves everything left, a name git would read as a pattern included, and main is clean after', () => {
    const moved = lane('new', 'rest', '--carry')
    assert.equal(moved.code, 0, moved.out)
    assert.match(moved.out, /which has none of it now/)
    assert.deepEqual(status(repo), [])
    assert.deepEqual(status(laneDir('rest')), ['?? notes/', 'D  gone.txt'], 'what git tracks arrives staged, as git apply --index leaves it')
    assert.equal(read(laneDir('rest'), 'notes/new file [draft].txt'), 'begun in main\n')

    const nothing = lane('new', 'empty', '--carry')
    assert.equal(nothing.code, 1)
    assert.match(nothing.out, /the main checkout has nothing uncommitted to carry/)
    assert.ok(!gitOk(repo, 'rev-parse', '--verify', 'refs/heads/empty'), 'and no branch made for it')
})

test('lane new --carry refuses what it cannot carry truthfully, before anything is made', () => {
    write(repo, 'app.txt', 'dirty again\n')
    assert.match(lane('new', 'x', '--carry', '--base', 'main').out, /give no --base with it/)
    assert.match(lane('new', 'x', '--carry', '--after', git(repo, 'rev-parse', 'HEAD')).out, /give --from <lane> with it/)
    assert.match(lane('new', 'x', '--from', 'part').out, /--from and --after go with --carry/)
    git(repo, 'switch', '-q', '-c', 'elsewhere')
    const off = lane('new', 'x', '--carry')
    assert.equal(off.code, 1)
    assert.match(off.out, /the main checkout is on "elsewhere", not main/)
    git(repo, 'switch', '-q', 'main')
    git(repo, 'branch', '-q', '-D', 'elsewhere')
    git(repo, 'checkout', '-q', '--', 'app.txt')
    assert.ok(!fs.existsSync(laneDir('x')))
})

test('a lane\'s commits after one, and its files, move to a lane from main\'s newest; the old lane is left as it was then', () => {
    // part's first commit is "merged" (squashed into main, as GitHub would); then it carries on: a commit, and files.
    assert.equal(lane('commit', 'part', '-m', 'Change the app').code, 0)
    const merged = git(laneDir('part'), 'rev-parse', 'HEAD')
    git(repo, 'merge', '-q', '--squash', merged)
    git(repo, 'commit', '-qm', 'Change the app (#1)')
    commit(laneDir('part'), 'after.txt', 'made after the merge\n', 'After the merge')
    write(laneDir('part'), 'app.txt', 'one\ntwo, changed in main\nthree\nfour, not committed\n')
    write(laneDir('part'), 'scratch.txt', 'not committed either\n')

    assert.match(lane('new', 'next', '--carry', '--from', 'part', '--after', 'f'.repeat(40)).out, /is not a commit here/)
    const moved = lane('new', 'next', '--carry', '--from', 'part', '--after', merged)
    assert.equal(moved.code, 0, moved.out)
    assert.match(moved.out, /replayed 1 commit on main/)
    assert.equal(git(laneDir('next'), 'log', '--format=%s', 'main..HEAD'), 'After the merge', 'only what came after the merge')
    assert.equal(git(laneDir('next'), 'merge-base', 'main', 'HEAD'), git(repo, 'rev-parse', 'main'), 'from main\'s newest')
    assert.deepEqual(status(laneDir('next')), ['?? scratch.txt', 'M  app.txt'])
    assert.equal(read(laneDir('next'), 'app.txt'), 'one\ntwo, changed in main\nthree\nfour, not committed\n')
    assert.equal(git(laneDir('part'), 'rev-parse', 'HEAD'), merged, 'the old lane back at the commit that was merged')
    assert.deepEqual(status(laneDir('part')), [], 'and with nothing of its own left: it can be dropped')
})

test('what does not apply where it would go moves nothing: no lane is kept, and the work is where it was, as it was', () => {
    // A file main now has as well, begun apart in a lane: carried, it would replace main's.
    commit(repo, 'clash.txt', 'main\'s own\n', 'Main has clash.txt')
    write(laneDir('next'), 'clash.txt', 'the lane\'s own\n')
    const before = status(laneDir('next'))
    const head = git(laneDir('next'), 'rev-parse', 'HEAD')
    const refused = lane('new', 'clash', '--carry', '--from', 'next')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /nothing was carried, and clash was not kept/)
    assert.ok(!fs.existsSync(laneDir('clash')))
    assert.ok(!gitOk(repo, 'rev-parse', '--verify', 'refs/heads/clash'), 'its branch taken away too')
    assert.deepEqual(status(laneDir('next')), before)
    assert.equal(git(laneDir('next'), 'rev-parse', 'HEAD'), head)
    assert.equal(read(laneDir('next'), 'clash.txt'), 'the lane\'s own\n')

    // A change to a file main changed the other way since: three-way, it conflicts, and the same holds.
    commit(repo, 'app.txt', 'one\ntwo, changed in main\nthree, main again\n', 'Main changes the app again')
    const conflicted = lane('new', 'clash', '--carry', '--from', 'next', '--', 'app.txt')
    assert.equal(conflicted.code, 1, conflicted.out)
    assert.match(conflicted.out, /do not apply on main as it is now/)
    assert.ok(!fs.existsSync(laneDir('clash')))
    assert.deepEqual(status(laneDir('next')), before)
    // Cleared for what follows: what was carried arrived staged, so back to the lane's commit, index and all.
    git(laneDir('next'), 'reset', '-q', '--hard')
    git(laneDir('next'), 'clean', '-q', '-f', '-d')
})

test('lane discard --main throws away the main checkout\'s files named, and only those', () => {
    write(repo, 'app.txt', 'changed again\n')
    write(repo, 'stray.txt', 'stray\n')
    write(repo, 'kept.txt', 'kept\n')
    assert.match(lane('discard', 'next', '--main', '--', 'stray.txt').out, /give no lane with it/)
    const gone = lane('discard', '--main', '--', 'app.txt', 'stray.txt')
    assert.equal(gone.code, 0, gone.out)
    assert.match(gone.out, /discarded 2 files in the main checkout/)
    assert.deepEqual(status(repo), ['?? kept.txt'])
    fs.rmSync(path.join(repo, 'kept.txt'))
})

test('a lane that landed, with something begun in it since, hands that on to a lane of its own, and is swept as usual', () => {
    assert.equal(lane('new', 'landed').code, 0)
    commit(laneDir('landed'), 'landed.txt', 'landed\n', 'Land something')
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'landed')
    write(laneDir('landed'), 'later.txt', 'begun after it landed\n')
    assert.equal(laneOf('landed').kind, 'landed')
    const moved = lane('new', 'afterwards', '--carry', '--from', 'landed')
    assert.equal(moved.code, 0, moved.out)
    assert.equal(read(laneDir('afterwards'), 'later.txt'), 'begun after it landed\n')
    const left = laneOf('landed')
    assert.deepEqual([left.kind, left.dirty], ['landed', 0], 'landed, and nothing a sweep would delete')
    assert.equal(lane('sweep', 'landed').code, 0)
    assert.ok(!fs.existsSync(laneDir('landed')))
})

test('lane pull fetches first, so main is brought up to what origin has now, not at the last fetch', () => {
    git(repo, 'push', '-q', 'origin', 'main')
    git(other, 'pull', '-q', 'origin', 'main')
    commit(other, 'theirs.txt', 'theirs\n', 'Somebody else lands')
    git(other, 'push', '-q', 'origin', 'main')
    assert.equal(repoState(repo).main.upstream.behind, 0, 'not fetched yet: as far as main knows, it has everything')
    const pulled = lane('pull')
    assert.equal(pulled.code, 0, pulled.out)
    assert.match(pulled.out, /git fetch origin/)
    assert.match(pulled.out, /PULLED/)
    assert.equal(read(repo, 'theirs.txt'), 'theirs\n')
})

test('lane pull <lane> fast-forwards a lane to what somebody pushed to it, and refuses one that has diverged', () => {
    assert.equal(lane('push', 'next').code, 0)
    assert.match(lane('pull', 'rest').out, /rest is not pushed/)
    git(other, 'fetch', '-q', 'origin')
    git(other, 'switch', '-q', 'next')
    commit(other, 'review.txt', 'a suggestion, committed from a review\n', 'Apply a suggestion')
    git(other, 'push', '-q', 'origin', 'next')

    const pulled = lane('pull', 'next')
    assert.equal(pulled.code, 0, pulled.out)
    assert.match(pulled.out, /PULLED\S*\s+·\s+next/)
    assert.equal(read(laneDir('next'), 'review.txt'), 'a suggestion, committed from a review\n')
    assert.match(lane('pull', 'next').out, /has everything origin\/next has/)

    commit(laneDir('next'), 'mine.txt', 'mine\n', 'Mine')
    commit(other, 'again.txt', 'again\n', 'Theirs again')
    git(other, 'push', '-q', 'origin', 'next')
    const diverged = lane('pull', 'next')
    assert.equal(diverged.code, 1)
    assert.match(diverged.out, /next and origin\/next have diverged: 1 here, 1 there/)
    assert.match(diverged.out, /git pull --rebase, in the lane/)
})

test('what is on origin that is not the lane\'s own is read, and a push never replaces it unasked', () => {
    // Diverged: a commit of its own, and one of somebody else's there.
    const up = laneOf('next').upstream
    assert.deepEqual([up.ahead, up.behind, up.foreign], [1, 1, 1])
    const refused = lane('push', 'next', '--force-with-lease')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /origin\/next has 1 commit that is not this lane's, rebased or not: somebody pushed to it/)
    assert.match(lane('push', 'next').out, /rebased since it was pushed|--force-with-lease/)

    // Brought in, rebased onto main, pushed: then origin's old copy is all this lane's own, and replacing it loses nothing.
    git(laneDir('next'), 'pull', '-q', '--rebase', 'origin', 'next')
    assert.equal(lane('push', 'next').code, 0)
    commit(repo, 'main-moves.txt', 'main moves\n', 'Main moves on')
    assert.equal(lane('rebase', 'next').code, 0)
    const rebased = laneOf('next').upstream
    assert.ok(rebased.ahead > 0 && rebased.behind > 0, JSON.stringify(rebased))
    assert.equal(rebased.foreign, 0, 'its old commits are each the same change as one of its new ones')
    const replaced = lane('push', 'next', '--force-with-lease')
    assert.equal(replaced.code, 0, replaced.out)

    // Behind and nothing new: there is nothing to push, and pull is what it needs.
    commit(other, 'more.txt', 'more\n', 'More of theirs')
    git(other, 'pull', '-q', '--rebase', 'origin', 'next')
    git(other, 'push', '-q', '--force', 'origin', 'HEAD:next')
    git(laneDir('next'), 'fetch', '-q', 'origin')
    const behind = laneOf('next').upstream
    assert.equal(behind.ahead, 0)
    assert.equal(behind.foreign, behind.behind)
    const nothing = lane('push', 'next')
    assert.equal(nothing.code, 1)
    assert.match(nothing.out, /lane pull next brings/)
    assert.equal(lane('pull', 'next').code, 0)
})

test('the page\'s carry, pull, push and discard presses are held to the same rules, before anything runs', async () => {
    const service = createService({ dirs: [work] })
    try {
        write(repo, 'begun.txt', 'begun in main\n')
        const refused = async (body, pattern, status = 409) => {
            const answer = await service.press(body)
            assert.equal(answer.status, status, JSON.stringify(answer.body))
            assert.match(answer.body.error, pattern)
        }
        await refused({ repo: 'demo', verb: 'new', name: 'next', carry: true }, /there is a lane called next already/)
        await refused({ repo: 'demo', verb: 'new', name: 'fresh', carry: true, paths: ['nope.txt'] }, /not among the lane's files: nope\.txt/, 400)
        await refused({ repo: 'demo', verb: 'new', name: 'fresh', carry: true, from: 'nowhere' }, /there is no lane "nowhere"/, 404)
        await refused({ repo: 'demo', verb: 'new', name: 'fresh', carry: true, after: 'abc1234' }, /not a commit of a lane to carry from/, 400)
        await refused({ repo: 'demo', verb: 'new', name: 'fresh', carry: true, from: 'part' }, /part has nothing uncommitted to carry/)
        await refused({ repo: 'demo', verb: 'pull', lane: 'rest' }, /rest is not pushed/)
        await refused({ repo: 'demo', verb: 'discard', main: true }, /a discard names the files/, 400)
        await refused({ repo: 'demo', verb: 'discard', main: true, paths: ['app.txt'] }, /not among the lane's files: app\.txt/, 400)

        const carried = await service.press({ repo: 'demo', verb: 'new', name: 'begun', carry: true, paths: ['begun.txt'] })
        assert.equal(carried.status, 202, JSON.stringify(carried.body))
        assert.match(carried.body.command, /lane\.mjs new begun --carry -- begun\.txt/)
        for (let i = 0; i < 300 && service.job(carried.body.id)?.state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(service.job(carried.body.id).code, 0, service.job(carried.body.id).output)
        assert.deepEqual(status(repo), [])
        assert.equal(read(laneDir('begun'), 'begun.txt'), 'begun in main\n')

        const fromLane = await service.press({ repo: 'demo', verb: 'new', name: 'later', carry: true, from: 'next', after: git(laneDir('next'), 'rev-parse', 'HEAD~1') })
        assert.equal(fromLane.status, 202, JSON.stringify(fromLane.body))
        assert.match(fromLane.body.command, /new later --carry --from next --after [0-9a-f]{40}$/)
        await service.cancel(fromLane.body.id)

        const pull = await service.press({ repo: 'demo', verb: 'pull', lane: 'next' })
        assert.equal(pull.status, 202, JSON.stringify(pull.body))
        assert.match(pull.body.command, /lane\.mjs pull next$/)
    } finally {
        service.dispose()
    }
})

test('a push that would replace somebody else\'s commits is refused by the page before anything runs', async () => {
    commit(other, 'yet.txt', 'yet more\n', 'Yet more of theirs')
    git(other, 'push', '-q', 'origin', 'HEAD:next')
    commit(laneDir('next'), 'own.txt', 'own\n', 'Own')
    git(laneDir('next'), 'fetch', '-q', 'origin')
    const service = createService({ dirs: [work] })
    try {
        const answer = await service.press({ repo: 'demo', verb: 'push', lane: 'next', force: true })
        assert.equal(answer.status, 409, JSON.stringify(answer.body))
        assert.match(answer.body.error, /origin\/next has \d+ commits? that (is|are) not next's: somebody pushed to it/)
    } finally {
        service.dispose()
    }
})
