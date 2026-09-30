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
