/**
 * The agents' reports (lib/agents.mjs), asked what they promise: Claude Code's hook events and
 * OpenCode's taken to one state each, a late event never undoing a later one, a report written into
 * the main checkout whichever lane the agent works in and read back against that lane, an agent no
 * longer running left unread and then cleared away, `lane report claude` silent on stdout and never
 * failing, OpenCode's plugin finding lanekit, and the reporters added to a repository beside what
 * is there without replacing it.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'

import {
    agentsDirOf, agentsIn, claudeHooks, claudeStep, installReporters, OPENCODE_PLUGIN, opencodeReporter,
    readReports, reportClaude, withClaudeHooks
} from '../lib/agents.mjs'
import { createService } from '../lib/service.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const sh = (cwd, command, ...args) => execFileSync(command, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const git = (cwd, ...args) => sh(cwd, 'git', ...args)

// A pid that is running (this test's) and one that is not, as the agent's.
const RUNNING = process.pid
const GONE = 4_194_000
/** The processes above a hook, as ancestry would say them: the reporter, its shell, the agent, the terminal's shell. */
const chainTo = (agent) => [{ pid: 4_194_101, name: 'node' }, { pid: 4_194_102, name: 'sh' }, { pid: agent, name: 'claude' }, { pid: 4_194_103, name: 'bash' }]

let scratch
let work
let repo
let laneDir

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-agents-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: {
            portBase: 19801, portCeiling: 19899, copyOnCreate: [], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    sh(repo, process.execPath, path.join(KIT, 'dev', 'lane.mjs'), 'new', 'midi-export')
    laneDir = path.join(work, 'demo-midi-export')
})

after(() => {
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

const event = (hook_event_name, extra = {}) => ({ session_id: 'abc-123', cwd: laneDir, hook_event_name, ...extra })

test('Claude Code\'s events each come to one state, the tool beside running and needs you', () => {
    const step = (before, input, now) => claudeStep(before, input, { now, pid: RUNNING, pids: [RUNNING] })
    const ready = step(null, event('SessionStart'), 1000)
    assert.equal(ready.state, 'ready')
    assert.equal(ready.key, 'claude-abc-123')
    const thinking = step(ready, event('UserPromptSubmit', { prompt: 'secret words' }), 2000)
    assert.equal(thinking.state, 'thinking')
    assert.ok(!JSON.stringify(thinking).includes('secret'), 'nothing anybody said is kept')
    const running = step(thinking, event('PreToolUse', { tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'curl -H "token: x"' } }), 3000)
    assert.deepEqual([running.state, running.tool], ['running', 'Bash'])
    assert.ok(!JSON.stringify(running).includes('curl'), 'nor what a tool was given')
    const asking = step(running, event('PermissionRequest', { tool_name: 'Bash', tool_use_id: 't1' }), 4000)
    assert.deepEqual([asking.state, asking.tool], ['needs-you', 'Bash'])
    const back = step(asking, event('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' }), 5000)
    assert.deepEqual([back.state, back.tool], ['thinking', null])
    assert.equal(back.since, 5000)
    const still = step(back, event('PostToolUse', { tool_name: 'Read', tool_use_id: 't2' }), 6000)
    assert.equal(still.since, 5000, 'since stays while the state does')
    assert.equal(step(still, event('Stop'), 7000).state, 'done')
    assert.equal(step(still, event('StopFailure'), 7000).state, 'failed')
    assert.equal(step(still, event('Notification', { notification_type: 'permission_prompt' }), 7000).state, 'needs-you')
    assert.equal(step(still, event('Notification', { notification_type: 'idle_prompt' }), 7000), null, 'idle is not news')
    assert.equal(step(still, event('SubagentStop'), 7000), null)
    assert.equal(step(still, { ...event('Stop'), session_id: '../../etc' }, 7000), null, 'a session id that is not one')
})

test('a hook finishing late never undoes a later one', () => {
    const step = (before, input, now) => claudeStep(before, input, { now })
    const after = step(null, event('PostToolUse', { tool_use_id: 't9' }), 5000)
    assert.equal(step(after, event('PreToolUse', { tool_name: 'Read', tool_use_id: 't9' }), 5001), null, 'a finished tool does not start again')
    assert.equal(step(after, event('PermissionRequest', { tool_name: 'Read', tool_use_id: 't9' }), 5002), null)
    assert.equal(step(after, event('Stop'), 4000), null, 'an event older than the report is dropped')
})

test('a report goes to the main checkout from a lane, is read against that lane, and goes when the session ends', async () => {
    const written = reportClaude(JSON.stringify(event('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1' })), { chain: chainTo(RUNNING) })
    assert.equal(written.pid, RUNNING, 'the agent is the first process above the hook that is not a shell')
    assert.deepEqual(written.pids, [RUNNING, 4_194_103])
    const file = path.join(agentsDirOf(repo), 'claude-abc-123.json')
    assert.ok(fs.existsSync(file), 'in the main checkout\'s .lanekit/agents')
    assert.ok(!fs.existsSync(path.join(laneDir, '.lanekit', 'agents')), 'not the lane\'s')
    const service = createService({ dirs: [work], packageRoot: KIT })
    const state = await service.state()
    assert.deepEqual(state.agents.map((agent) => [agent.repo, agent.lane, agent.agent, agent.state, agent.tool]), [['demo', 'midi-export', 'claude', 'running', 'Edit']])
    assert.deepEqual(service.agents().map((agent) => agent.key), ['claude-abc-123'])
    service.dispose()
    assert.equal(reportClaude(JSON.stringify(event('SessionEnd')), { chain: chainTo(RUNNING) }), 'removed')
    assert.ok(!fs.existsSync(file))
})

test('an agent no longer running is not read, and the next to start clears it away', () => {
    reportClaude(JSON.stringify({ ...event('UserPromptSubmit'), session_id: 'dead-one' }), { chain: chainTo(GONE) })
    const file = path.join(agentsDirOf(repo), 'claude-dead-one.json')
    assert.ok(fs.existsSync(file))
    assert.deepEqual(readReports(repo).map((report) => report.key), [], 'not read')
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'live-one' }), { chain: chainTo(RUNNING) })
    assert.ok(!fs.existsSync(file), 'cleared when another starts')
    assert.deepEqual(readReports(repo).map((report) => report.key), ['claude-live-one'])
    reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: 'live-one' }), { chain: chainTo(RUNNING) })
})

test('a report file is read for what it may say, and nothing else', () => {
    const dir = agentsDirOf(repo)
    fs.writeFileSync(path.join(dir, 'claude-odd.json'), JSON.stringify({ key: 'claude-odd', agent: 'claude', state: 'running', tool: 'x'.repeat(500), pid: RUNNING, at: 1, extra: '<script>', pids: ['1', RUNNING] }))
    fs.writeFileSync(path.join(dir, 'claude-bad.json'), JSON.stringify({ key: 'claude-bad', agent: 'claude', state: 'exploding', pid: RUNNING }))
    fs.writeFileSync(path.join(dir, 'not-json.json'), '{')
    const read = readReports(repo)
    assert.deepEqual(read.map((report) => report.key), ['claude-odd'])
    assert.equal(read[0].tool.length, 40)
    assert.equal(read[0].extra, undefined)
    assert.deepEqual(read[0].pids, [RUNNING])
    for (const name of ['claude-odd.json', 'claude-bad.json', 'not-json.json']) fs.rmSync(path.join(dir, name))
})

test('lane report claude says nothing on stdout and never fails, whatever it is handed', () => {
    const shim = (input) => spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'report', 'claude'], { cwd: laneDir, env, input, encoding: 'utf8' })
    const good = shim(JSON.stringify({ ...event('SessionStart'), session_id: 'via-lane' }))
    assert.equal(good.status, 0, good.stderr)
    assert.equal(good.stdout, '', 'stdout after SessionStart is words for the model')
    assert.ok(fs.existsSync(path.join(agentsDirOf(repo), 'claude-via-lane.json')))
    const ended = shim(JSON.stringify({ ...event('SessionEnd'), session_id: 'via-lane' }))
    assert.equal(ended.status, 0)
    assert.ok(!fs.existsSync(path.join(agentsDirOf(repo), 'claude-via-lane.json')))
    const junk = shim('not json at all')
    assert.equal(junk.status, 0)
    assert.equal(junk.stdout, '')
    const outside = shim(JSON.stringify({ ...event('Stop'), cwd: scratch }))
    assert.equal(outside.status, 0, 'outside a repository: nothing to say, and no failure')
    const other = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'report', 'codex'], { cwd: laneDir, env, input: '{}', encoding: 'utf8' })
    assert.equal(other.status, 0)
    assert.match(other.stderr, /knows claude/)
})

test('OpenCode\'s events come to one state for the process, written only when it changes', async () => {
    const times = [1000]
    const hooks = await opencodeReporter({ directory: laneDir, worktree: laneDir }, { now: () => times.at(-1), pid: RUNNING, chain: [{ pid: RUNNING, name: 'opencode' }, { pid: 4_194_103, name: 'zsh' }] })
    const file = path.join(agentsDirOf(repo), `opencode-${RUNNING}.json`)
    const read = () => JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(read().state, 'ready')
    assert.deepEqual(read().pids, [RUNNING, 4_194_103])
    const say = async (type, properties) => { times.push(times.at(-1) + 1000); await hooks.event({ event: { type, properties } }) }
    await say('session.status', { sessionID: 's1', status: { type: 'busy' } })
    assert.equal(read().state, 'thinking')
    assert.equal(read().session, 's1')
    times.push(times.at(-1) + 1000)
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: 's1', callID: 'c1' }, { args: { command: 'secret' } })
    assert.deepEqual([read().state, read().tool], ['running', 'bash'])
    assert.ok(!fs.readFileSync(file, 'utf8').includes('secret'))
    await say('permission.asked', { id: 'p1', sessionID: 's1', permission: 'bash', patterns: ['*'] })
    assert.deepEqual([read().state, read().tool], ['needs-you', 'bash'])
    await say('permission.replied', { sessionID: 's1', requestID: 'p1', reply: 'once' })
    assert.equal(read().state, 'running')
    // A message streaming changes nothing, and is not written.
    const before = fs.statSync(file).mtimeMs
    await say('message.part.updated', { sessionID: 's1' })
    await say('session.status', { sessionID: 's1', status: { type: 'busy' } })
    assert.equal(fs.statSync(file).mtimeMs, before)
    await hooks['tool.execute.after']({ tool: 'bash', sessionID: 's1', callID: 'c1' }, {})
    assert.equal(read().state, 'thinking')
    // A session of its own (a subagent) going idle leaves the first one thinking.
    await say('session.status', { sessionID: 's2', status: { type: 'busy' } })
    await say('session.idle', { sessionID: 's2' })
    assert.equal(read().state, 'thinking')
    await say('session.status', { sessionID: 's1', status: { type: 'idle' } })
    assert.equal(read().state, 'done')
    await say('question.asked', { id: 'q1', sessionID: 's1', questions: [] })
    assert.deepEqual([read().state, read().tool], ['needs-you', 'question'])
    await say('question.rejected', { sessionID: 's1', requestID: 'q1' })
    assert.equal(read().state, 'done')
    await say('session.status', { sessionID: 's1', status: { type: 'busy' } })
    await say('session.error', { sessionID: 's1', error: { name: 'APIError' } })
    assert.equal(read().state, 'failed')
    await say('session.status', { sessionID: 's1', status: { type: 'busy' } })
    await say('session.error', { sessionID: 's1', error: { name: 'MessageAbortedError' } })
    assert.equal(read().state, 'done', 'stopped by the person is not a failure')
    fs.rmSync(file)
})

test('OpenCode\'s plugin finds lanekit where the shim does, and hands over to it', async () => {
    const plugin = path.join(laneDir, '.opencode', 'plugins', 'lanekit.js')
    fs.mkdirSync(path.dirname(plugin), { recursive: true })
    fs.writeFileSync(plugin, OPENCODE_PLUGIN)
    const kept = process.env.LANEKIT
    process.env.LANEKIT = KIT
    try {
        const { LaneKitReport } = await import(pathToFileURL(plugin).href)
        const hooks = await LaneKitReport({ directory: laneDir, worktree: laneDir })
        assert.equal(typeof hooks.event, 'function')
        assert.equal(typeof hooks['tool.execute.before'], 'function')
        assert.ok(fs.existsSync(path.join(agentsDirOf(repo), `opencode-${process.pid}.json`)))
        fs.rmSync(path.join(agentsDirOf(repo), `opencode-${process.pid}.json`))
        process.env.LANEKIT = path.join(scratch, 'nowhere')
        const elsewhere = path.join(scratch, 'elsewhere')
        fs.mkdirSync(elsewhere, { recursive: true })
        const none = await LaneKitReport({ directory: elsewhere, worktree: elsewhere })
        assert.deepEqual(none, {}, 'outside a repository, or with no lanekit found: no hooks, and no failure')
    } finally {
        if (kept === undefined) delete process.env.LANEKIT; else process.env.LANEKIT = kept
        fs.rmSync(path.join(laneDir, '.opencode'), { recursive: true })
    }
})

test('Claude Code\'s hooks are added beside the ones there, once, in the background but for SessionEnd, and never fail it', () => {
    const theirs = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] } }
    const { settings, added } = withClaudeHooks(theirs, 'demo')
    assert.equal(added, Object.keys(claudeHooks('demo')).length)
    assert.deepEqual(settings.permissions, theirs.permissions)
    assert.equal(settings.hooks.PreToolUse.length, 2)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, './guard.sh', 'theirs first, untouched')
    const ours = settings.hooks.PreToolUse[1].hooks[0]
    assert.equal(ours.command, '"$CLAUDE_PROJECT_DIR"/demo lane report claude || true')
    assert.equal(ours.async, true)
    assert.equal(settings.hooks.SessionEnd[0].hooks[0].async, undefined, 'SessionEnd waits: Claude Code may be gone before a background hook starts')
    assert.equal(withClaudeHooks(settings, 'demo').added, 0, 'once')
})

test('the reporters are written into a repository where missing, and what is there is kept', () => {
    const dir = path.join(scratch, 'reporters')
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Read'] } }))
    const first = installReporters(dir, 'demo')
    assert.deepEqual(first.wrote, [path.join('.claude', 'settings.json') + " (LaneKit's status hooks)", path.join('.opencode', 'plugins', 'lanekit.js')])
    const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'))
    assert.deepEqual(settings.permissions, { allow: ['Read'] })
    assert.ok(settings.hooks.Stop)
    assert.equal(fs.readFileSync(path.join(dir, '.opencode', 'plugins', 'lanekit.js'), 'utf8'), OPENCODE_PLUGIN)
    const second = installReporters(dir, 'demo')
    assert.deepEqual(second.wrote, [])
    assert.equal(second.kept.length, 2)
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{ not json')
    const broken = installReporters(dir, 'demo', { agents: ['claude'] })
    assert.deepEqual(broken.wrote, [])
    assert.match(broken.warnings[0], /not valid JSON/)
    assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'), '{ not json', 'left as it was')
    const checked = installReporters(path.join(scratch, 'checked'), 'demo', { check: true })
    assert.equal(checked.wrote.length, 2)
    assert.ok(!fs.existsSync(path.join(scratch, 'checked')), '--check writes nothing')
})

test('every repository\'s agents are attributed to the lane whose folder holds theirs, the main checkout else', () => {
    const repos = [{ id: 'demo', path: repo, lanes: [{ name: 'midi-export', path: laneDir, exists: true }] }]
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'in-main', cwd: path.join(repo) }), { chain: chainTo(RUNNING) })
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'in-lane' }), { chain: chainTo(RUNNING) })
    const found = agentsIn(repos).map((agent) => [agent.session, agent.lane])
    assert.deepEqual(found.sort(), [['in-lane', 'midi-export'], ['in-main', null]])
    for (const session of ['in-main', 'in-lane']) reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: session }), { chain: chainTo(RUNNING) })
})
