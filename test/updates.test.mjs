/**
 * The editor's own copy of lanekit (vscode/updates.js): cloned where there is none, following `stable` where the
 * repository has it, and kept current only ever by a fast-forward, never a copy with changes or commits of its own,
 * never one somebody else owns, and never by guessing. Against a bare repository standing in for GitHub.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing. Nothing here reaches GitHub.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(import.meta.url)
const { install, check, update, isLanekit, STABLE, newerLoader, offeredLoader } = require(path.join(KIT, 'vscode', 'updates.js'))

const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid'
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (cwd, file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text) }
const commit = (cwd, file, text, message) => { write(cwd, file, text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }

let scratch, origin, author

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-updates-')))
    // lanekit, as far as these tests need it: its two files the loader and the shims look for.
    origin = path.join(scratch, 'lanekit.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    author = path.join(scratch, 'author')
    git(scratch, 'clone', '-q', origin, author)
    git(author, 'switch', '-q', '-c', 'main')
    write(author, 'vscode/host.mjs', 'export const activate = () => ({ dispose() {} })\n')
    commit(author, 'dev/lane.mjs', '// lane\n', 'Begin lanekit')
    git(author, 'push', '-q', '-u', 'origin', 'main')
})

after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

test('a copy is cloned where there is none, on the default branch while the repository has no stable', async () => {
    const to = path.join(scratch, 'home-one', '.lanekit')
    const made = await install(to, { url: origin })
    assert.equal(made.ok, true, made.why)
    assert.equal(made.branch, 'main')
    assert.ok(isLanekit(to))
    assert.deepEqual(await check(to), { state: 'current', branch: 'main', upstream: 'origin/main' })
})

test('once the repository has stable, a new copy follows it: only commits CI passed reach it', async () => {
    commit(author, 'untested.txt', 'on main, not yet passed\n', 'Not passed yet')
    git(author, 'push', '-q', 'origin', `HEAD~1:refs/heads/${STABLE}`, 'HEAD:main')
    const to = path.join(scratch, 'home', '.lanekit')
    const made = await install(to, { url: origin })
    assert.equal(made.ok, true, made.why)
    assert.equal(made.branch, STABLE)
    assert.equal(git(to, 'rev-parse', '--abbrev-ref', '@{upstream}'), `origin/${STABLE}`)
    assert.ok(!fs.existsSync(path.join(to, 'untested.txt')), 'main\'s newest, not passed, is not there')
    assert.equal((await check(to)).state, 'current')
})

test('a folder already there is taken if it is lanekit, and refused, untouched, if it is anything else', async () => {
    const again = await install(path.join(scratch, 'home', '.lanekit'), { url: origin })
    assert.deepEqual([again.ok, again.already], [true, true])
    const other = path.join(scratch, 'home-other', '.lanekit')
    write(other, 'notes.txt', 'mine\n')
    const refused = await install(other, { url: origin })
    assert.equal(refused.ok, false)
    assert.match(refused.why, /is there already and is not lanekit/)
    assert.deepEqual(fs.readdirSync(other), ['notes.txt'])
    const nowhere = await install(path.join(scratch, 'home-nowhere', '.lanekit'), { url: path.join(scratch, 'no-such.git') })
    assert.equal(nowhere.ok, false)
    assert.match(nowhere.why, /git clone .* did not finish/)
})

test('a copy behind what it follows is fast-forwarded to it, and says what it took', async () => {
    const to = path.join(scratch, 'home', '.lanekit')
    git(author, 'push', '-q', 'origin', `HEAD:refs/heads/${STABLE}`)
    const seen = await check(to)
    assert.deepEqual([seen.state, seen.count, seen.upstream], ['behind', 1, `origin/${STABLE}`])
    const done = await update(to)
    assert.equal(done.state, 'updated')
    assert.equal(done.count, 1)
    assert.match(done.to, /^[0-9a-f]+ Not passed yet$/)
    assert.equal(git(to, 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'))
    assert.equal((await update(to)).state, 'current', 'and nothing more to do')
})

test('a copy with changes, commits of its own, no branch, or a branch that follows none is left as it is, and why said', async () => {
    const to = path.join(scratch, 'home', '.lanekit')
    commit(author, 'next.txt', 'next\n', 'Next')
    git(author, 'push', '-q', 'origin', `HEAD:refs/heads/${STABLE}`)
    const head = git(to, 'rev-parse', 'HEAD')

    write(to, 'dev/lane.mjs', '// changed here\n')
    assert.deepEqual(await update(to), { state: 'left', why: 'it has uncommitted changes' })
    git(to, 'checkout', '-q', '--', 'dev/lane.mjs')
    write(to, 'scratch-notes.txt', 'untracked, in nobody\'s way\n')
    assert.equal((await check(to)).state, 'behind', 'a file git does not track stops nothing')
    fs.rmSync(path.join(to, 'scratch-notes.txt'))

    commit(to, 'mine.txt', 'mine\n', 'A commit of its own')
    assert.deepEqual(await update(to), { state: 'left', why: 'it has 1 commit of its own' })
    git(to, 'reset', '-q', '--hard', head)

    git(to, 'switch', '-q', '--detach')
    assert.deepEqual(await update(to), { state: 'left', why: 'it is not on a branch' })
    git(to, 'switch', '-q', '-c', 'trying')
    assert.deepEqual(await update(to), { state: 'left', why: 'its branch trying follows none' })
    git(to, 'switch', '-q', STABLE)
    git(to, 'branch', '-q', '-D', 'trying')
    assert.equal(git(to, 'rev-parse', 'HEAD'), head, 'nothing was moved by any of it')
})

test('a copy that cannot be fetched, or is not its owner\'s to change, or is not lanekit, is left as it is', async () => {
    const to = path.join(scratch, 'home', '.lanekit')
    const url = git(to, 'remote', 'get-url', 'origin')
    git(to, 'remote', 'set-url', 'origin', path.join(scratch, 'gone.git'))
    const unreachable = await update(to)
    assert.equal(unreachable.state, 'left')
    assert.match(unreachable.why, /^it could not be fetched: /)
    git(to, 'remote', 'set-url', 'origin', url)

    if (process.getuid?.() !== 0) {
        fs.chmodSync(path.join(to, '.git'), 0o555)
        try {
            assert.deepEqual(await update(to), { state: 'left', why: 'it is not yours to change' })
        } finally {
            fs.chmodSync(path.join(to, '.git'), 0o755)
        }
    }
    assert.match((await update(path.join(scratch, 'home-other', '.lanekit'))).why, /is not lanekit/)
    assert.equal((await update(to)).state, 'updated', 'and once it can be, it is')
})

test('the extension is updated from the copy only to a newer build of itself that this editor can run', () => {
    const running = { publisher: 'lanekit', name: 'lanekit', version: '0.26.0', engines: { vscode: '^1.90.0' } }
    const offered = (extra) => ({ ...running, ...extra })
    assert.deepEqual(newerLoader({ running, offered: offered({ version: '0.27.0' }), editor: '1.105.1' }), { newer: true, version: '0.27.0' })
    assert.deepEqual(newerLoader({ running, offered: offered({ version: '0.26.10' }), editor: '1.105.1' }), { newer: true, version: '0.26.10' }, 'by number, not by letter')
    assert.match(newerLoader({ running, offered: offered({}), editor: '1.105.1' }).why, /the copy's is 0\.26\.0, and this is 0\.26\.0/)
    assert.equal(newerLoader({ running, offered: offered({ version: '0.25.9' }), editor: '1.105.1' }).newer, false, 'never an older one')
    assert.match(newerLoader({ running, offered: offered({ version: '0.27.0', publisher: 'someone' }), editor: '1.105.1' }).why, /the copy's extension is someone\.lanekit, not lanekit\.lanekit/)
    assert.match(newerLoader({ running, offered: offered({ version: '0.27.0', engines: { vscode: '^1.200.0' } }), editor: '1.105.1' }).why, /needs the editor at 1\.200\.0 or later, and this is 1\.105\.1/)
    assert.equal(newerLoader({ running, offered: offered({ version: 'next' }), editor: '1.105.1' }).newer, false)
    assert.match(newerLoader({ running, offered: null, editor: '1.105.1' }).why, /holds no extension/)
    assert.equal(newerLoader({ running, offered: offered({ version: '0.27.0', engines: {} }), editor: undefined }).newer, true, 'an editor that does not say its version is not held to one')
    assert.equal(offeredLoader(path.join(KIT)).name, 'lanekit', 'read from the copy\'s vscode/package.json')
    assert.equal(offeredLoader(path.join(scratch, 'nowhere')), null)
})
