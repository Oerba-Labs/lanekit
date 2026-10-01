/**
 * `adopt` (bin/adopt.mjs), asked what it promises an existing repository: the mechanical
 * files written where missing and never over anything, the integration branch and the
 * environment file read from the repository rather than assumed, /lane and /land for both
 * agents, a refusal anywhere but the top of a main checkout — and a shim that works.
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

import { adopt } from '../bin/adopt.mjs'
import { writeAgentCommands } from '../bin/claude-commands.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: '', LANEKIT: KIT
}
const sh = (cwd, command, ...args) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (cwd, ...args) => sh(cwd, 'git', ...args)
const read = (file) => fs.readFileSync(file, 'utf8')

let scratch

/** A repository somebody already works in: code, a package.json, an ignored .env, one commit. */
const existing = (name, { branch = 'main', trackedEnv = false } = {}) => {
    const dir = path.join(scratch, name)
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `@acme/${name}` }))
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log(process.env.PORT)\n')
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3000\n')
    fs.writeFileSync(path.join(dir, '.gitignore'), trackedEnv ? 'node_modules/\n' : 'node_modules/\n.env\n')
    git(dir, 'init', '-q', '-b', branch)
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Begin')
    return dir
}

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-adopt-')))
})
after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('--check says what it would write, and writes nothing', () => {
    const dir = existing('checked')
    const said = adopt({ dir, check: true })
    assert.ok(said.wrote.includes('lane.config.json'))
    assert.equal(git(dir, 'status', '--porcelain'), '', 'nothing written')
})

test('it writes the mechanical files, reading the branch and the environment file from the repository', () => {
    const dir = existing('piano-sheets')
    const said = adopt({ dir, portBase: 8300 })
    const config = JSON.parse(read(path.join(dir, 'lane.config.json')))
    assert.equal(config.name, 'piano-sheets', 'the package name, without its scope')
    assert.equal(config.slug, 'piano-sheets')
    assert.equal(config.integrationBranch, 'main')
    assert.equal(config.lane.env.file, '.env')
    assert.deepEqual(config.lane.copyOnCreate, ['.env'])
    assert.deepEqual([config.lane.portBase, config.lane.portCeiling], [8301, 8399])
    assert.ok(fs.statSync(path.join(dir, 'piano-sheets')).mode & 0o100, 'the shim runs')
    assert.ok(fs.statSync(path.join(dir, 'check')).mode & 0o100, './check runs')
    const ignore = read(path.join(dir, '.gitignore'))
    assert.match(ignore, /^\.lanekit\/$/m)
    assert.equal(ignore.match(/^\.env$/gm).length, 1, 'an .env already ignored is not added twice')
    for (const rel of ['.claude/commands/lane.md', '.claude/commands/land.md', '.opencode/commands/lane.md', '.opencode/commands/land.md']) {
        assert.ok(said.wrote.includes(rel), rel)
    }
    assert.equal(git(dir, 'log', '--oneline').trim().split('\n').length, 1, 'nothing is committed')
})

test('each agent\'s commands carry the header that agent reads', () => {
    const dir = path.join(scratch, 'piano-sheets')
    const claude = read(path.join(dir, '.claude/commands/lane.md'))
    assert.match(claude, /^allowed-tools: .*Bash\(\.\/piano-sheets lane:\*\)/m)
    const opencode = read(path.join(dir, '.opencode/commands/lane.md'))
    const header = /^---\n([\s\S]*?)\n---\n/.exec(opencode)[1]
    assert.deepEqual(header.split('\n').map((line) => line.split(':')[0]), ['description'])
    assert.match(opencode, /\$ARGUMENTS/, 'the body is the same procedure')
    assert.match(opencode, /\.\/piano-sheets lane new <name>/)
})

test('a second run keeps everything and writes nothing', () => {
    const dir = path.join(scratch, 'piano-sheets')
    fs.writeFileSync(path.join(dir, 'check'), '#!/bin/sh\necho "the tests ran"\n')
    const before = read(path.join(dir, '.gitignore'))
    const said = adopt({ dir })
    assert.deepEqual(said.wrote, [])
    assert.equal(read(path.join(dir, 'check')), '#!/bin/sh\necho "the tests ran"\n', 'the project\'s own ./check is kept')
    assert.equal(read(path.join(dir, '.gitignore')), before)
})

test('the shim finds lanekit and makes a lane with a port of its own', () => {
    const dir = path.join(scratch, 'piano-sheets')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'Give the repository lanes')
    const out = sh(dir, path.join(dir, 'piano-sheets'), 'lane', 'new', 'lanekit-trial')
    assert.match(out, /lane "lanekit-trial" ready/)
    const lane = path.join(scratch, 'piano-sheets-lanekit-trial')
    const port = Number(/^PORT=(\d+)$/m.exec(read(path.join(lane, '.env')))[1])
    assert.ok(port >= 8301 && port <= 8399, `port ${port} in the window`)
    assert.match(sh(dir, path.join(dir, 'piano-sheets'), 'lane', 'list'), /lanekit-trial/)
    assert.match(sh(lane, path.join(lane, 'piano-sheets'), 'gate'), /READY/)
    sh(dir, path.join(dir, 'piano-sheets'), 'lane', 'sweep', 'lanekit-trial')
    assert.ok(!fs.existsSync(lane))
})

test('a repository on master, with its .env tracked, gets a port file git ignores', () => {
    const dir = existing('old-shop', { branch: 'master', trackedEnv: true })
    const said = adopt({ dir })
    const config = JSON.parse(read(path.join(dir, 'lane.config.json')))
    assert.equal(config.integrationBranch, 'master')
    assert.equal(config.lane.env.file, '.env.local', 'not the tracked .env')
    assert.match(read(path.join(dir, '.gitignore')), /^\.env\.local$/m)
    assert.ok(said.warnings.some((warning) => /no environment file is here yet/.test(warning)))
})

test('it refuses a lane, a folder inside a repository, and a folder outside git', () => {
    const dir = path.join(scratch, 'piano-sheets')
    sh(dir, path.join(dir, 'piano-sheets'), 'lane', 'new', 'inside')
    assert.throws(() => adopt({ dir: path.join(scratch, 'piano-sheets-inside') }), /worktree/)
    assert.throws(() => adopt({ dir: path.join(dir, 'src') }), /not the top of its repository/)
    const loose = path.join(scratch, 'loose')
    fs.mkdirSync(loose)
    assert.throws(() => adopt({ dir: loose }), /not inside a git repository/)
})

test('a file already named like the shim is kept, and said', () => {
    const dir = existing('tool')
    fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\necho mine\n')
    const said = adopt({ dir })
    assert.equal(read(path.join(dir, 'tool')), '#!/bin/sh\necho mine\n')
    assert.ok(said.warnings.some((warning) => /not lanekit's shim/.test(warning)))
})

test('the command writer refuses an agent it does not know', () => {
    assert.throws(() => writeAgentCommands(scratch, 'X', 'x', { agents: ['cursor'] }), /no agent called "cursor"/)
})

const adoptCli = (dir, ...args) => {
    try {
        return { code: 0, out: sh(dir, process.execPath, path.join(KIT, 'bin', 'adopt.mjs'), ...args) }
    } catch (error) {
        return { code: error.status, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
}

test('--commit commits what it wrote and nothing else, staged or not', () => {
    const dir = existing('committed-shop')
    fs.writeFileSync(path.join(dir, 'src', 'app.js'), 'console.log("staged, and not adopt\'s")\n')
    git(dir, 'add', 'src/app.js')
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'untracked, and not adopt\'s\n')
    const ran = adoptCli(dir, '--commit')
    assert.equal(ran.code, 0, ran.out)
    assert.match(ran.out, /committed what it wrote, as [0-9a-f]+ on main/)
    assert.match(git(dir, 'log', '-1', '--format=%s'), /^Give committed-shop lanes$/m)
    const files = git(dir, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n').sort()
    assert.deepEqual(files, ['.claude/commands/land.md', '.claude/commands/lane.md', '.gitignore', '.opencode/commands/land.md',
        '.opencode/commands/lane.md', 'check', 'committed-shop', 'lane.config.json'])
    assert.equal(git(dir, 'diff', '--cached', '--name-only').trim(), 'src/app.js', 'what was staged stays staged')
    assert.match(git(dir, 'status', '--porcelain'), /^\?\? notes\.txt$/m)
})

test('a repository just made by git init gets lanes from its first commit, on the branch it is on', () => {
    const dir = path.join(scratch, 'brand-new')
    fs.mkdirSync(dir)
    git(dir, 'init', '-q', '-b', 'trunk')
    const ran = adoptCli(dir, '--commit')
    assert.equal(ran.code, 0, ran.out)
    assert.equal(JSON.parse(read(path.join(dir, 'lane.config.json'))).integrationBranch, 'trunk', 'the unborn branch HEAD names')
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').trim(), '1')
    sh(dir, path.join(dir, 'brand-new'), 'lane', 'new', 'first-idea')
    assert.ok(fs.existsSync(path.join(scratch, 'brand-new-first-idea', 'lane.config.json')), 'the lane has the config, since it was committed')
})

test('--commit writes and leaves the commit to a person where .gitignore holds their changes, or main is elsewhere', () => {
    const dir = existing('busy-shop')
    fs.appendFileSync(path.join(dir, '.gitignore'), 'dist/\n')
    const ran = adoptCli(dir, '--commit')
    assert.equal(ran.code, 1)
    assert.match(ran.out, /not committed.*\.gitignore already held changes of yours/)
    assert.ok(fs.existsSync(path.join(dir, 'lane.config.json')), 'written all the same')
    assert.equal(git(dir, 'log', '-1', '--format=%s').trim(), 'Begin')

    const elsewhere = existing('branch-shop')
    git(elsewhere, 'checkout', '-q', '-b', 'feature')
    const off = adoptCli(elsewhere, '--commit')
    assert.equal(off.code, 1)
    assert.match(off.out, /on feature, not main/)
    assert.equal(git(elsewhere, 'log', '-1', '--format=%s').trim(), 'Begin')
})
