/**
 * The service the page and the editor both carry (lib/service.mjs), asked what the editor
 * needs of it beyond the page: repositories found from wherever the editor was opened, a
 * reading off the editor's thread, and the files a commit, a lane or a checkout changed,
 * each refused outside what was found.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { createService, parseNameStatus } from '../lib/service.mjs'
import { findRepos } from '../lib/state.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const sh = (cwd, command, ...args) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (cwd, ...args) => sh(cwd, 'git', ...args)
const lane = (cwd, ...args) => sh(cwd, process.execPath, path.join(KIT, 'dev', 'lane.mjs'), ...args)

let scratch
let work
let repo
let working
let first
let inline
let threaded

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-service-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: {
            portBase: 19801, portCeiling: 19899, copyOnCreate: ['.env'], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, '.env'), 'PORT=19800\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n')
    fs.writeFileSync(path.join(repo, 'src', 'deep', 'keep.txt'), 'keep\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    first = git(repo, 'rev-parse', 'HEAD').trim()

    lane(repo, 'new', 'working')
    working = path.join(work, 'demo-working')
    fs.writeFileSync(path.join(working, 'feature.txt'), 'feature\n')
    git(working, 'add', '-A')
    git(working, 'commit', '-qm', 'Add the feature')
    // Work in progress: one file changed and not committed, one new and not added.
    fs.writeFileSync(path.join(working, 'app.txt'), 'one\ntwo\n')
    fs.writeFileSync(path.join(working, 'scratch.txt'), 'new\n')

    inline = createService({ dirs: [work] })
    threaded = createService({ dirs: [work], reader: 'worker' })
})

after(() => {
    inline?.dispose()
    threaded?.dispose()
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('a repository is found from its folder, the folder above it, one of its lanes, or deep inside', () => {
    for (const from of [repo, work, working, path.join(repo, 'src', 'deep')]) {
        assert.deepEqual(findRepos(from), [repo], `from ${from}`)
    }
    assert.deepEqual(findRepos(scratch), [], 'two levels up is not looked into')
    assert.deepEqual(findRepos(path.join(scratch, 'nowhere')), [])
})

test('the worker reads what the inline reader reads', async () => {
    const [a, b] = await Promise.all([inline.state(), threaded.state()])
    const shape = (state) => state.repos.map((r) => [r.id, r.lanes.map((l) => [l.name, l.kind, l.ahead, l.dirty])])
    assert.deepEqual(shape(b), shape(a))
    assert.deepEqual(shape(a), [['demo', [['working', 'working', 1, 2]]]])
})

test('asks that arrive together share one reading', async () => {
    const [a, b] = await Promise.all([threaded.state(), threaded.state()])
    // Each answer carries the fetch's news in a copy of its own; what was read underneath is one reading.
    assert.equal(a.repos[0].lanes, b.repos[0].lanes)
})

test('a commit\'s files, against its parent, and every file of a first commit', async () => {
    await inline.state()
    const head = git(working, 'rev-parse', 'HEAD').trim()
    const changed = await inline.commitChanges(repo, head)
    assert.equal(changed.parent, first)
    assert.deepEqual(changed.files, [{ status: 'A', path: 'feature.txt' }])
    const root = await inline.commitChanges(repo, first)
    assert.equal(root.parent, null)
    assert.deepEqual(root.files.map((f) => f.path).sort(), ['.gitignore', 'app.txt', 'lane.config.json', 'src/deep/keep.txt'])
    assert.equal(await inline.commitChanges(repo, 'not-a-sha'), null)
    assert.equal(await inline.commitChanges(path.join(scratch, 'elsewhere'), head), null)
})

test('a lane\'s changes are everything it holds that main does not, committed or not', async () => {
    const changes = await inline.laneChanges(repo, 'working')
    assert.equal(changes.base, first)
    assert.equal(changes.checkout, working)
    assert.deepEqual(changes.files.map((f) => `${f.status} ${f.path}`).sort(), ['A feature.txt', 'A scratch.txt', 'M app.txt'])
    assert.equal(await inline.laneChanges(repo, 'ghost'), null)
})

test('what is uncommitted in a checkout, and only a checkout that was found', async () => {
    const left = await inline.uncommitted(repo, working)
    assert.equal(left.head, git(working, 'rev-parse', 'HEAD').trim())
    assert.deepEqual(left.files.map((f) => `${f.status} ${f.path}`).sort(), ['A scratch.txt', 'M app.txt'])
    assert.equal(await inline.uncommitted(repo, scratch), null)
})

test('a file as it was at a commit, and nothing outside the repository', async () => {
    assert.equal((await inline.show(repo, first, 'app.txt')).toString(), 'one\n')
    assert.equal((await inline.show(repo, first, 'src/deep/keep.txt')).toString(), 'keep\n')
    assert.equal((await inline.show(repo, first, 'feature.txt')).length, 0, 'a file the commit does not have is empty')
    for (const rel of ['../demo-working/feature.txt', '/etc/passwd', 'src/../../x']) {
        assert.equal(await inline.show(repo, first, rel), null, rel)
    }
    assert.equal(await inline.show(repo, 'HEAD', 'app.txt'), null, 'a commit is named by its hash')
})

test('a file is placed in its lane, or in the main checkout', async () => {
    await inline.state()
    assert.equal(inline.laneAt(path.join(working, 'feature.txt')).lane.name, 'working')
    const inMain = inline.laneAt(path.join(repo, 'app.txt'))
    assert.equal(inMain.repo.id, 'demo')
    assert.equal(inMain.lane, null)
    assert.equal(inline.laneAt(path.join(scratch, 'x.txt')), null)
})

test('a job says it started, what it printed and that it finished', async () => {
    const seen = []
    const done = new Promise((resolve) => inline.events.once('done', resolve))
    inline.events.on('output', (job, text) => seen.push(text))
    const pressed = await inline.press({ repo: 'demo', verb: 'gate', lane: 'working' })
    assert.equal(pressed.status, 202)
    const finished = await done
    assert.equal(finished.id, pressed.body.id)
    assert.match(seen.join(''), /\$ node dev\/gate\.mjs/)
    assert.equal(inline.job(pressed.body.id).state, 'done')
})

test('git\'s name-status list is read whole, renames included', () => {
    assert.deepEqual(parseNameStatus('M\0a.txt\0R087\0old.txt\0new.txt\0D\0gone.txt\0'), [
        { status: 'M', path: 'a.txt' },
        { status: 'R', path: 'new.txt', from: 'old.txt' },
        { status: 'D', path: 'gone.txt' }
    ])
    assert.deepEqual(parseNameStatus(''), [])
})

test('a repository without lanes is offered them: adopt\'s check first, then adopt and a commit of what it wrote', async () => {
    const other = path.join(scratch, 'other')
    const plain = path.join(other, 'plain')
    fs.mkdirSync(plain, { recursive: true })
    fs.writeFileSync(path.join(plain, 'app.txt'), 'one\n')
    git(plain, 'init', '-q', '-b', 'main')
    git(plain, 'add', '-A')
    git(plain, 'commit', '-qm', 'Begin')
    fs.mkdirSync(path.join(other, '.hidden'))
    git(path.join(other, '.hidden'), 'init', '-q')
    fs.mkdirSync(path.join(other, 'notes'))
    // The commit adopt makes is git's, under whoever runs the service.
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' })
    const service = createService({ dirs: [other] })
    const run = async (request) => {
        const done = new Promise((resolve) => { const on = (job) => { if (job.id === pressed.body.id) { service.events.off('done', on); resolve(job) } }; service.events.on('done', on) })
        const pressed = await service.press(request)
        assert.equal(pressed.status, 202, JSON.stringify(pressed.body))
        await done
        return service.job(pressed.body.id, 0)
    }
    try {
        const before = await service.state()
        assert.deepEqual(before.withoutLanes, [{ id: 'plain', path: plain }], 'hidden folders and folders outside git are not offered')
        assert.deepEqual(before.repos, [])

        const checked = await run({ repo: 'plain', verb: 'adopt', dryRun: true })
        assert.equal(checked.code, 0)
        assert.match(checked.output, /would write {2}lane\.config\.json/)
        assert.ok(!fs.existsSync(path.join(plain, 'lane.config.json')), 'a check writes nothing')

        const adopted = await run({ repo: 'plain', verb: 'adopt' })
        assert.equal(adopted.code, 0, adopted.output)
        assert.match(git(plain, 'log', '-1', '--format=%s'), /^Give plain lanes$/m)
        const after = await service.state()
        assert.deepEqual(after.withoutLanes, [])
        assert.deepEqual(after.repos.map((repo) => repo.id), ['plain'])

        assert.equal((await service.press({ repo: 'plain', verb: 'adopt' })).status, 404, 'it has lanes now')
        assert.equal((await service.press({ repo: 'notes', verb: 'adopt' })).status, 404, 'not a repository')
    } finally {
        service.dispose()
    }
})

/**
 * A repository of its own beside the others, with main `count` commits long: the first holds the files a lane needs,
 * the rest are empty, made by one fast-import rather than a git process each.
 */
const longHistory = (dir, count, portBase) => {
    fs.mkdirSync(dir, { recursive: true })
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'lane.config.json'), 'utf8'))
    config.slug = path.basename(dir)
    Object.assign(config.lane, { portBase, portCeiling: portBase + 98 })
    fs.writeFileSync(path.join(dir, 'lane.config.json'), JSON.stringify(config))
    fs.writeFileSync(path.join(dir, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(dir, '.env'), `PORT=${portBase - 1}\n`)
    git(dir, 'init', '-q', '-b', 'main')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Commit 1')
    let stream = ''
    for (let n = 2; n <= count; n++) {
        const message = `Commit ${n}\n`
        stream += `commit refs/heads/main\ncommitter Test <test@example.invalid> ${1700000000 + n} +0000\ndata ${message.length}\n${message}`
        if (n === 2) stream += 'from refs/heads/main^0\n'
        stream += '\n'
    }
    execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, env, input: stream })
    // Commit n of main, oldest first.
    return ['', ...git(dir, 'rev-list', '--first-parent', 'main').trim().split('\n').reverse()]
}

const finishedIn = async (service, id) => {
    for (let i = 0; i < 300 && service.job(id)?.state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    return service.job(id, 0)
}

test('main\'s line is read further back a page at a time when a page asks, kept for every page, and the newest alone again', async () => {
    const other = path.join(scratch, 'history')
    const commit = longHistory(path.join(other, 'long'), 40, 19901)
    lane(path.join(other, 'long'), 'new', 'old', '--base', commit[3])
    // The worker reads at the depth asked too: it is the reader the editor uses.
    const service = createService({ dirs: [other], reader: 'worker' })
    try {
        const at = (state) => state.repos.find((candidate) => candidate.id === 'long')
        const first = at(await service.state())
        assert.equal(first.spine.length, 12)
        assert.equal(first.spine[0].subject, 'Commit 40')
        assert.deepEqual([first.spineMore, first.spineDeeper, first.spineAtMost], [true, false, false])
        assert.deepEqual([first.spineTotal, first.spineNext], [40, 25], 'main\'s line is forty long, and the next ask reads twenty-five more')
        const old = first.lanes.find((candidate) => candidate.name === 'old')
        assert.equal(old.base, commit[3])
        assert.ok(!first.spine.some((shown) => shown.sha === old.base), 'the lane forked further back than the log reads')
        const tooFar = await service.press({ repo: 'long', verb: 'rebase', lane: 'old', onto: commit[2] })
        assert.equal(tooFar.status, 400)
        assert.match(tooFar.body.error, /not one of main's commits shown/)

        const once = await service.history('long', 'older')
        assert.equal(once.status, 200, JSON.stringify(once.body))
        assert.equal(at(once.body).spine.length, 37)
        assert.equal(at(once.body).spine.at(-1).subject, 'Commit 4')
        assert.deepEqual([at(once.body).spineMore, at(once.body).spineDeeper], [true, true])
        assert.equal(at(once.body).spineNext, 3, 'only as many as are left')
        assert.equal(at(await service.state()).spine.length, 37, 'kept for the next reading, whoever asks it')

        const twice = at((await service.history('long', 'older')).body)
        assert.equal(twice.spine.length, 40, 'as far as there is')
        assert.equal(twice.spine.at(-1).subject, 'Commit 1')
        assert.deepEqual([twice.spineMore, twice.spineNext, twice.spineTotal], [false, 0, 40])
        assert.ok(twice.spine.some((shown) => shown.sha === old.base), 'the lane is on main\'s line now')
        const nothing = await service.history('long', 'older')
        assert.equal(nothing.status, 409)
        assert.match(nothing.body.error, /no commits older/)

        // A drop onto a commit only a page further back shows is held to the same rule, and passes it now.
        const back = await service.press({ repo: 'long', verb: 'rebase', lane: 'old', onto: commit[2] })
        assert.equal(back.status, 202, JSON.stringify(back.body))
        assert.equal((await finishedIn(service, back.body.id)).code, 0)

        const newest = at((await service.history('long', 'newest')).body)
        assert.deepEqual([newest.spine.length, newest.spineMore, newest.spineDeeper], [12, true, false])
        assert.equal(at(await service.state()).spine.length, 12)

        // A lane listed as forked further back is read down to in one ask: its fork, now commit 2, the log's last row.
        const fork = at((await service.history('long', 'fork', 'old')).body)
        assert.equal(fork.spine.length, 39)
        assert.equal(fork.spine.at(-1).sha, commit[2])
        assert.equal((await service.history('long', 'fork', 'old')).status, 200, 'asked again, it is shown already')
        assert.equal(at(await service.state()).spine.length, 39)
        assert.equal((await service.history('long', 'fork', 'ghost')).status, 404)

        assert.equal((await service.history('long', 'sideways')).status, 400)
        assert.equal((await service.history('ghost', 'older')).status, 404)
    } finally {
        service.dispose()
    }
})

test('main\'s line is read no further back than five hundred commits, and the page is told it stops there', async () => {
    const other = path.join(scratch, 'longest')
    const commit = longHistory(path.join(other, 'longest'), 501, 20001)
    lane(path.join(other, 'longest'), 'new', 'first', '--base', commit[1])
    const service = createService({ dirs: [other] })
    try {
        let read = (await service.state()).repos[0]
        let asks = 0
        while (!read.spineAtMost && asks++ < 30) read = (await service.history('longest', 'older')).body.repos[0]
        assert.equal(read.spine.length, 500)
        assert.deepEqual([read.spineMore, read.spineDeeper, read.spineAtMost], [true, true, true])
        assert.deepEqual([read.spineTotal, read.spineNext], [501, 0])
        assert.equal(read.spine.at(-1).subject, 'Commit 2')
        const refused = await service.history('longest', 'older')
        assert.equal(refused.status, 409)
        assert.match(refused.body.error, /at most 500/)
        const tooDeep = await service.history('longest', 'fork', 'first')
        assert.equal(tooDeep.status, 409)
        assert.match(tooDeep.body.error, /first forked 500 commits back; LaneKit reads at most 500/)
    } finally {
        service.dispose()
    }
})

test('a reading is dated when it began, so an ask that shares it is never told of what happened after that', async () => {
    // A press's work is drawn until a reading taken after its job ended: one begun before and shared since, dated when it
    // ended, would have it dropped there, and its result drawn only a reading later.
    const reading = threaded.state()
    await new Promise((resolve) => setTimeout(resolve, 2))
    const asked = Date.now()
    const [first, second] = await Promise.all([reading, threaded.state()])
    assert.equal(first.at, second.at, 'one reading')
    assert.ok(second.at < asked, `dated ${second.at}, when it began, not after the later ask at ${asked}`)
    assert.ok(second.at <= threaded.known().at, 'and no later than when it ended')
})
