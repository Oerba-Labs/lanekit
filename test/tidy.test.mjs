/**
 * Lanes not being worked on: set aside (nothing removed, out of the landing order, back on a word), quiet (nothing done
 * in it for longer than staleAfterDays), and dropped (its folder removed, its branch kept, brought back with
 * `lane new <name> --existing`), with what drop refuses; a lane with nothing in it left out of the landing order; and
 * the page's landing order in groups.
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
const gitOk = (cwd, ...args) => spawnSync('git', args, { cwd, env, encoding: 'utf8' }).status === 0
const laneIn = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const lane = (...args) => laneIn(repo, ...args)
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)
const commit = (cwd, file, text, message, extra = {}) => {
    write(cwd, file, text)
    execFileSync('git', ['add', '-A'], { cwd, env: { ...env, ...extra } })
    execFileSync('git', ['commit', '-qm', message], { cwd, env: { ...env, ...extra } })
}
const laneDir = (name) => path.join(work, `demo-${name}`)
const read = (name) => repoState(repo).lanes.find((candidate) => candidate.name === name)

let scratch, work, repo, origin
const CONFIG = {
    name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
    gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
    lane: { portBase: 19901, portCeiling: 19999, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
}

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-tidy-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', JSON.stringify(CONFIG))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    git(repo, 'init', '-q', '-b', 'main')
    commit(repo, 'app.txt', 'one\ntwo\nthree\n', 'Begin')
    git(repo, 'remote', 'add', 'origin', origin)
    git(repo, 'push', '-q', '-u', 'origin', 'main')
})

after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true }) })

test('set aside takes a lane out of the landing order and removes nothing; resume brings it back', () => {
    assert.equal(lane('new', 'side').code, 0)
    commit(laneDir('side'), 'side.txt', 'side\n', 'Start something on the side')
    assert.ok(read('side').queue, 'in the landing order to begin with')

    const set = lane('aside', 'side')
    assert.equal(set.code, 0, set.out)
    const now = read('side')
    assert.ok(now.aside && !Number.isNaN(Date.parse(now.aside)), 'set aside, and when')
    assert.equal(now.queue, null, 'out of the landing order')
    assert.ok(fs.existsSync(path.join(laneDir('side'), 'side.txt')), 'its folder and its work untouched')
    assert.ok(gitOk(repo, 'config', '--get', 'branch.side.lanekitAside'), 'kept in the clone\'s git settings')
    assert.match(lane('aside', 'side').out, /set aside already/)

    const back = lane('resume', 'side')
    assert.equal(back.code, 0, back.out)
    assert.equal(read('side').aside, null)
    assert.ok(read('side').queue, 'back in the landing order')
    const again = lane('resume', 'side')
    assert.equal(again.code, 1)
    assert.match(again.out, /not set aside/)
})

test('a lane with nothing committed and nothing changed is left out of the landing order, until it has a change', () => {
    assert.equal(lane('new', 'blank').code, 0)
    assert.equal(read('blank').kind, 'fresh')
    assert.equal(read('blank').queue, null, 'nothing to land, so nothing to order')
    write(laneDir('blank'), 'draft.txt', 'a draft\n')
    assert.equal(read('blank').queue?.verdict, 'commit first', 'a change is something to order')
    fs.rmSync(path.join(laneDir('blank'), 'draft.txt'))
})

test('a lane with nothing done in it for longer than staleAfterDays is quiet, and a fresh change wakes it', () => {
    assert.equal(lane('new', 'idle').code, 0)
    const month = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    commit(laneDir('idle'), 'idea.txt', 'an idea\n', 'Try an idea', { GIT_AUTHOR_DATE: month, GIT_COMMITTER_DATE: month })
    const quiet = read('idle')
    assert.ok(quiet.quietDays >= 29 && quiet.quietDays <= 31, `quiet for a month: ${quiet.quietDays}`)
    assert.equal(quiet.quiet, true)
    assert.equal(read('side').quiet, false, 'a lane worked on today is not')

    write(laneDir('idle'), 'idea.txt', 'an idea, better\n')
    assert.equal(read('idle').quietDays, 0, 'a change not yet committed is something done')
    assert.equal(read('idle').quiet, false)
    git(laneDir('idle'), 'checkout', '--', 'idea.txt')

    write(repo, 'lane.config.json', JSON.stringify({ ...CONFIG, lane: { ...CONFIG.lane, staleAfterDays: 60 } }))
    assert.equal(read('idle').quiet, false, 'quiet only after the days the config says')
    write(repo, 'lane.config.json', JSON.stringify({ ...CONFIG, lane: { ...CONFIG.lane, staleAfterDays: 0 } }))
    const refused = lane('list')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /staleAfterDays must be a whole number/)
    write(repo, 'lane.config.json', JSON.stringify(CONFIG))
})

test('drop refuses a lane with uncommitted work, one part-way through a rebase, and the one you are standing in', () => {
    assert.equal(lane('new', 'busy').code, 0)
    commit(laneDir('busy'), 'app.txt', 'one\nTWO in busy\nthree\n', 'Change two in busy')
    write(laneDir('busy'), 'loose.txt', 'not committed\n')
    const dirty = lane('drop', 'busy')
    assert.equal(dirty.code, 1)
    assert.match(dirty.out, /1 uncommitted change, which would go with its folder/)
    assert.match(dirty.out, /loose\.txt/)
    fs.rmSync(path.join(laneDir('busy'), 'loose.txt'))

    const inside = laneIn(laneDir('busy'), 'drop', 'busy')
    assert.equal(inside.code, 1)
    assert.match(inside.out, /the lane you are standing in/)

    commit(repo, 'app.txt', 'one\nTWO on main\nthree\n', 'Change two on main')
    assert.equal(lane('rebase', 'busy').code, 1, 'the rebase stops on the conflict')
    const midway = lane('drop', 'busy')
    assert.equal(midway.code, 1)
    assert.match(midway.out, /part-way through a rebase/)
    assert.equal(lane('rebase', 'busy', '--abort').code, 0)
    assert.ok(fs.existsSync(laneDir('busy')), 'and nothing was removed')
})

test('drop --dry-run changes nothing; drop removes the folder, keeps the branch, says it was never pushed, and new --existing brings it back', () => {
    assert.equal(lane('new', 'gone').code, 0)
    commit(laneDir('gone'), 'gone.txt', 'gone\n', 'Something not wanted now')
    const tip = git(laneDir('gone'), 'rev-parse', 'HEAD')
    assert.equal(lane('aside', 'gone').code, 0)

    const looked = lane('drop', 'gone', '--dry-run')
    assert.equal(looked.code, 0, looked.out)
    assert.match(looked.out, /would remove .*demo-gone, and keep its branch gone/)
    assert.ok(fs.existsSync(laneDir('gone')), 'a check removes nothing')

    const dropped = lane('drop', 'gone')
    assert.equal(dropped.code, 0, dropped.out)
    assert.match(dropped.out, /DROPPED/)
    assert.match(dropped.out, /never pushed/)
    assert.match(dropped.out, /lane new gone --existing brings it back/)
    assert.ok(!fs.existsSync(laneDir('gone')), 'its folder is gone')
    assert.equal(git(repo, 'rev-parse', 'refs/heads/gone'), tip, 'its branch is kept, at its last commit')
    assert.ok(!gitOk(repo, 'config', '--get', 'branch.gone.lanekitAside'), 'and it is no longer set aside')
    assert.equal(read('gone'), undefined, 'and no longer a lane')

    const plain = lane('new', 'gone')
    assert.equal(plain.code, 1, 'a name whose branch exists is not quietly reused')
    assert.match(plain.out, /lane new gone --existing/)
    const back = lane('new', 'gone', '--existing')
    assert.equal(back.code, 0, back.out)
    assert.equal(git(laneDir('gone'), 'rev-parse', 'HEAD'), tip, 'brought back with its work')
    assert.match(lane('new', 'nothing-here', '--existing').out, /no branch called "nothing-here"/)
})

test('a pushed lane dropped says that origin has its work', () => {
    assert.equal(lane('new', 'shared').code, 0)
    commit(laneDir('shared'), 'shared.txt', 'shared\n', 'Share something')
    assert.equal(lane('push', 'shared').code, 0)
    const dropped = lane('drop', 'shared')
    assert.equal(dropped.code, 0, dropped.out)
    assert.match(dropped.out, /origin\/shared has all of it as well/)
})

test('the page\'s set aside, bring back and drop are held to the same rules', async () => {
    const service = createService({ dirs: [work] })
    const finished = (id) => new Promise((resolve) => {
        const kept = service.job(id)
        if (kept?.state === 'done') return resolve(kept)
        service.events.on('done', (job) => { if (job.id === id) resolve(service.job(id)) })
    })
    await service.state()
    assert.equal((await service.press({ repo: 'demo', verb: 'resume', lane: 'side' })).status, 409, 'not set aside')
    write(laneDir('side'), 'loose.txt', 'loose\n')
    await service.state()
    assert.equal((await service.press({ repo: 'demo', verb: 'drop', lane: 'side' })).status, 409, 'uncommitted work would go with it')
    fs.rmSync(path.join(laneDir('side'), 'loose.txt'))
    await service.state()
    const check = await service.press({ repo: 'demo', verb: 'drop', lane: 'side', dryRun: true })
    assert.equal(check.status, 202)
    assert.match(check.body.command, /lane\.mjs drop side --dry-run$/)
    assert.equal((await finished(check.body.id)).code, 0)
    const set = await service.press({ repo: 'demo', verb: 'aside', lane: 'side' })
    assert.equal(set.status, 202)
    assert.equal((await finished(set.body.id)).code, 0)
    const now = (await service.state()).repos[0].lanes.find((candidate) => candidate.name === 'side')
    assert.ok(now.aside, 'set aside from the page')
    assert.equal((await service.press({ repo: 'demo', verb: 'aside', lane: 'side' })).status, 409, 'set aside already')
    service.dispose()
})

test('the page groups the landing order by what each lane needs, with an order only where lanes collide', () => {
    // landingGroupsOf, read from the page as it is written there and run here: plain data in and out.
    const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
    const start = page.indexOf('const LANDING_GROUPS = [')
    const fn = page.indexOf('const landingGroupsOf = ', start)
    assert.ok(start !== -1 && fn !== -1, 'the page has the grouping')
    const source = page.slice(start, page.indexOf('\n}\n', fn) + 2)
    const landingGroupsOf = new Function(`${source}; return landingGroupsOf`)()
    const at = (name, verdict, position = 0, extra = {}) => ({ name, queue: { verdict, position, collisions: extra.collisions ?? [] }, quiet: false, aside: null, ...extra })
    const groups = landingGroupsOf([
        at('b', 'land now'), at('a', 'land now'),
        at('h', 'land now', 0, { quiet: true, quietDays: 40 }),
        at('c', 'gate now'),
        at('d', 'commit first'),
        at('e', 'hold the gate', 1, { collisions: [{ lane: 'b' }] }),
        at('f', 'hold the gate', 2, { collisions: [{ lane: 'b' }, { lane: 'e' }, { lane: 'z' }] }),
        at('k', 'parked', null),
        at('g', 'gate now', 0, { quiet: true, quietDays: 30 }),
        at('i', 'gate now', 0, { aside: '2026-09-01T00:00:00.000Z' }),
        { name: 'j', queue: null }
    ])
    assert.deepEqual(groups.map((group) => group.label), ['Ready', 'Needs a gate', 'Commit first', 'Waiting', 'Part-way', 'Quiet'])
    assert.deepEqual(groups[0].lanes.map((item) => item.name), ['a', 'b', 'h'], 'a ready lane stays ready, quiet or not')
    assert.deepEqual(groups[3].lanes, [{ name: 'e', after: ['b'] }, { name: 'f', after: ['b', 'e'] }], 'each waits for the lanes it collides with that land first')
    assert.deepEqual(groups[5].lanes, [{ name: 'g', after: [], days: 30 }], 'quiet and not ready, last')
    assert.ok(!groups.flatMap((group) => group.lanes).some((item) => item.name === 'i' || item.name === 'j'), 'set aside, and nothing to land, left out')
})

test('home says each repository at a glance: its lanes, its landing order, its agents with those waiting on you first, and what runs', () => {
    // glanceOf, with the landing groups it reads, from the page as it is written there and run here: plain data in and out.
    const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
    const groupsAt = page.indexOf('const LANDING_GROUPS = [')
    const groupsEnd = page.indexOf('\n}\n', page.indexOf('const landingGroupsOf = ', groupsAt)) + 2
    const glanceAt = page.indexOf('const AGENT_ORDER = ')
    const glanceEnd = page.indexOf('\n}\n', page.indexOf('const glanceOf = ', glanceAt)) + 2
    assert.ok(groupsAt !== -1 && glanceAt !== -1, 'the page has the grouping and the glance')
    const glanceOf = new Function(`${page.slice(groupsAt, groupsEnd)}; ${page.slice(glanceAt, glanceEnd)}; return glanceOf`)()
    const lane = (name, kind, verdict, extra = {}) => ({ name, kind, dirty: 0, aside: null, quiet: false, queue: verdict ? { verdict, position: 0, collisions: [] } : null, ...extra })
    const repo = {
        id: 'demo',
        lanes: [
            lane('ready', 'working', 'land now'), lane('gate-me', 'working', 'gate now'), lane('also', 'working', 'gate now'),
            lane('empty', 'fresh', null), lane('parked', 'working', 'gate now', { aside: '2026-09-01T00:00:00.000Z' }),
            lane('done', 'landed', null), lane('gone', 'missing', null)
        ]
    }
    const agents = [
        { repo: 'demo', lane: 'gate-me', agent: 'opencode', state: 'running', since: 2 },
        { repo: 'demo', lane: 'ready', agent: 'claude', state: 'done', since: 3 },
        { repo: 'demo', lane: 'also', agent: 'claude', state: 'needs-you', since: 1 },
        { repo: 'other', lane: 'x', agent: 'claude', state: 'needs-you', since: 4 }
    ]
    const jobs = [
        { repo: 'demo', verb: 'gate', lane: 'gate-me', state: 'running', startedAt: 10 },
        { repo: 'demo', verb: 'land', lane: 'ready', state: 'queued' },
        { repo: 'other', verb: 'gate', lane: 'x', state: 'running' }
    ]
    const glance = glanceOf(repo, agents, jobs)
    assert.deepEqual([glance.lanes, glance.aside, glance.finished], [4, 1, 2])
    assert.deepEqual(glance.groups, [
        { verdict: 'land now', label: 'Ready', names: ['ready'] },
        { verdict: 'gate now', label: 'Needs a gate', names: ['also', 'gate-me'] },
        { verdict: 'empty', label: 'Nothing committed', names: ['empty'] }
    ])
    assert.deepEqual(glance.agents.map((agent) => agent.lane), ['also', 'gate-me', 'ready'], 'waiting on you, then at work, then the rest; its own only')
    assert.equal(glance.needsYou, 1)
    assert.equal(glance.running.lane, 'gate-me')
    assert.equal(glance.waiting, 1)
    const reviews = [{ repo: 'acme/demo', number: 7 }, { repo: 'acme/demo', number: 9 }, { repo: 'other/thing', number: 3 }]
    assert.equal(glanceOf({ ...repo, github: { slug: 'acme/demo' } }, agents, jobs, reviews).reviews, 2, 'its own reviews waiting on you, by its name on GitHub')
    assert.equal(glanceOf(repo, agents, jobs, reviews).reviews, 0, 'none matched where its name on GitHub is not known')
    const broken = glanceOf({ id: 'demo', error: 'lane.config.json is not JSON', lanes: [] }, agents, [])
    assert.deepEqual([broken.lanes, broken.groups, broken.running], [0, [], null])
})
