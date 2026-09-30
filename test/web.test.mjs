/**
 * `lane web`, asked everything it promises on a scratch repository: what it reads, what
 * it refuses, and that each button runs the command it says and nothing else.
 *
 *     node --test test/
 *
 * Needs git and node; leaves nothing (the scratch folder is removed at the end).
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { startServer } from '../dev/web.mjs'

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
let server
let base

const ask = async (route, init) => {
    const response = await fetch(`${base}${route}`, init)
    const type = response.headers.get('content-type') ?? ''
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : await response.text() }
}
const press = (body, headers = { 'content-type': 'application/json', 'x-lanes': '1' }) =>
    ask('api/jobs', { method: 'POST', headers, body: JSON.stringify(body) })

const finished = async (id) => {
    for (let i = 0; i < 200; i++) {
        const { body } = await ask(`api/jobs/${id}`)
        if (body.state === 'done') return body
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`job ${id} did not finish`)
}
const laneIn = async (name) => (await ask('api/state')).body.repos[0].lanes.find((candidate) => candidate.name === name)

before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-web-'))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        // A gate that takes a moment, so a second press can arrive while it runs.
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'a short wait', command: 'sleep', args: ['0.4'] }] } } },
        lane: {
            portBase: 19901, portCeiling: 19999, copyOnCreate: ['.env'], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, '.env'), 'PORT=19900\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'queue\nsearch\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')

    lane(repo, 'new', 'working')
    const working = path.join(work, 'demo-working')
    fs.writeFileSync(path.join(working, 'feature.txt'), 'feature\n')
    git(working, 'add', '-A')
    git(working, 'commit', '-qm', 'Add the feature')

    lane(repo, 'new', 'empty')
    const empty = path.join(work, 'demo-empty')
    fs.writeFileSync(path.join(empty, 'unsaved.txt'), 'not committed\n')

    lane(repo, 'new', 'finished')
    const finishedLane = path.join(work, 'demo-finished')
    fs.writeFileSync(path.join(finishedLane, 'done.txt'), 'done\n')
    git(finishedLane, 'add', '-A')
    git(finishedLane, 'commit', '-qm', 'Finish it')
    git(repo, 'merge', '--no-ff', '--no-edit', 'finished')

    const started = await startServer({ scan: work, port: 0, sshHost: 'demo.coder', browserEditor: '../code/?folder=' })
    server = started.server
    base = `http://127.0.0.1:${started.port}/`
})

after(() => {
    server?.close()
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('the page and its files are served, and ask only for relative addresses', async () => {
    const page = await ask('')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
    assert.doesNotMatch(page.body, /(src|href)="\//, 'an absolute address breaks behind Coder\'s prefix')
    const script = await ask('lanes.js')
    assert.equal(script.status, 200)
    assert.doesNotMatch(script.body, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'a value from the server must go in as text')
    assert.doesNotMatch(script.body, /fetch\(['`"]\//, 'every address asked for is relative')
    assert.equal((await ask('healthz')).body, 'ok\n')
})

test('the routes answer under a proxy prefix too', async () => {
    const response = await fetch(`${base}@owner/demo/apps/lanes/api/state`)
    assert.equal(response.status, 200)
    const page = await fetch(`${base}@owner/demo/apps/lanes/`)
    assert.match(await page.text(), /<title>Lanes<\/title>/)
})

test('each lane is read as what it is: working, empty with work in it, or landed', async () => {
    const { body } = await ask('api/state')
    assert.equal(body.repos.length, 1, 'one repository: the lanes beside it are not repositories')
    const [demo] = body.repos
    assert.equal(demo.integrationBranch, 'main')
    const byName = Object.fromEntries(demo.lanes.map((candidate) => [candidate.name, candidate]))
    assert.equal(byName.working.kind, 'working')
    assert.equal(byName.working.ahead, 1)
    assert.equal(byName.working.stack[0].subject, 'Add the feature')
    assert.equal(byName.working.queue.verdict, 'gate now')
    assert.equal(byName.empty.kind, 'fresh', 'an empty lane is not a landed one, though both are contained in main')
    assert.equal(byName.empty.dirty, 1)
    assert.equal(byName.finished.kind, 'landed')
    assert.ok(Number.isInteger(byName.working.port))
    assert.equal(body.open.sshHost, 'demo.coder')
})

test('a press from anything but the page is refused', async () => {
    const noHeader = await press({ repo: 'demo', verb: 'fetch' }, { 'content-type': 'application/json' })
    assert.equal(noHeader.status, 403)
    const asForm = await press({ repo: 'demo', verb: 'fetch' }, { 'content-type': 'application/x-www-form-urlencoded', 'x-lanes': '1' })
    assert.equal(asForm.status, 403)
})

test('names and refs that are not names are refused before anything runs', async () => {
    for (const name of ['../escape', '-rf', 'Upper', '', 'a b']) {
        const { status } = await press({ repo: 'demo', verb: 'new', name })
        assert.equal(status, 400, `lane name ${JSON.stringify(name)}`)
    }
    for (const baseRef of ['--upload-pack=x', 'no-such-branch', 'main..working']) {
        const { status } = await press({ repo: 'demo', verb: 'new', name: 'ok-name', base: baseRef })
        assert.equal(status, 400, `base ${JSON.stringify(baseRef)}`)
    }
    assert.equal((await press({ repo: 'nope', verb: 'fetch' })).status, 404)
    assert.equal((await press({ repo: 'demo', verb: 'rm' })).status, 400)
    assert.equal((await press({ repo: 'demo', verb: 'gate', lane: 'ghost' })).status, 404)
})

test('sweep refuses a lane that has not landed, and one with uncommitted work', async () => {
    const working = await press({ repo: 'demo', verb: 'sweep', lane: 'working' })
    assert.equal(working.status, 409)
    assert.match(working.body.error, /has not landed/)
    const empty = await press({ repo: 'demo', verb: 'sweep', lane: 'empty' })
    assert.equal(empty.status, 409, 'an empty lane holding unsaved work must never be swept')
    assert.ok(fs.existsSync(path.join(work, 'demo-empty', 'unsaved.txt')))
})

test('land checks first, refuses without a green gate, and lands after one', async () => {
    const check = await press({ repo: 'demo', verb: 'land', lane: 'working', dryRun: true })
    assert.equal(check.status, 202)
    const refused = await finished(check.body.id)
    assert.notEqual(refused.code, 0)
    assert.match(refused.output, /cannot land yet/)
    assert.match(refused.output, /--dry-run/, 'the command shown is the command run')

    const gate = await press({ repo: 'demo', verb: 'gate', lane: 'working' })
    const gated = await finished(gate.body.id)
    assert.equal(gated.code, 0, gated.output)
    assert.match(gated.output, /READY/)
    assert.equal((await laneIn('working')).queue.verdict, 'land now')

    const again = await finished((await press({ repo: 'demo', verb: 'land', lane: 'working', dryRun: true })).body.id)
    assert.equal(again.code, 0, again.output)
    assert.match(again.output, /would merge/)
    assert.ok(fs.existsSync(path.join(work, 'demo-working')), 'a check changes nothing')

    const landed = await finished((await press({ repo: 'demo', verb: 'land', lane: 'working' })).body.id)
    assert.equal(landed.code, 0, landed.output)
    assert.match(landed.output, /LANDED/)
    assert.equal(git(repo, 'merge-base', '--is-ancestor', 'working', 'main'), '')
    assert.ok(!fs.existsSync(path.join(work, 'demo-working')), 'land sweeps the lane it merged')
    assert.equal(await laneIn('working'), undefined)
})

test('sweep of a landed lane checks first, then removes the folder and keeps the branch', async () => {
    const check = await finished((await press({ repo: 'demo', verb: 'sweep', lane: 'finished', dryRun: true })).body.id)
    assert.equal(check.code, 0, check.output)
    assert.match(check.output, /would remove/)
    assert.ok(fs.existsSync(path.join(work, 'demo-finished')))
    const swept = await finished((await press({ repo: 'demo', verb: 'sweep', lane: 'finished' })).body.id)
    assert.equal(swept.code, 0, swept.output)
    assert.ok(!fs.existsSync(path.join(work, 'demo-finished')))
    assert.match(git(repo, 'branch', '--list', 'finished'), /finished/)
})

test('new makes a lane, and one repository runs one command at a time', async () => {
    const made = await finished((await press({ repo: 'demo', verb: 'new', name: 'second' })).body.id)
    assert.equal(made.code, 0, made.output)
    const second = path.join(work, 'demo-second')
    assert.ok(fs.existsSync(second))
    assert.equal((await laneIn('second')).kind, 'fresh')

    fs.writeFileSync(path.join(second, 'more.txt'), 'more\n')
    git(second, 'add', '-A')
    git(second, 'commit', '-qm', 'Add more')
    const gate = await press({ repo: 'demo', verb: 'gate', lane: 'second' })
    assert.equal(gate.status, 202)
    const meanwhile = await press({ repo: 'demo', verb: 'fetch' })
    assert.equal(meanwhile.status, 409, 'a second command while the gate runs')
    assert.match(meanwhile.body.error, /already running/)
    assert.equal((await finished(gate.body.id)).code, 0)
})
