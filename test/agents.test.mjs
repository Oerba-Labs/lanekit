/**
 * The agents' reports (lib/agents.mjs), asked what they promise: Claude Code's hook events and
 * OpenCode's taken to one state each, a late event never undoing a later one, a report written into
 * the person's own state folder and read back against the lane it works in, an agent in a repository
 * without lanes named by its folder, another machine's reports left alone, an agent no longer running
 * left unread and then cleared away,
 * `lane report claude` silent on stdout and never failing, OpenCode's plugin finding lanekit, and the
 * reporters installed once a machine beside what is there, without replacing anything not LaneKit's.
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
    agentsDir, agentsIn, ancestry, CLAUDE_EVENTS, claudeHooks, claudeStep, installForUser, opencodePlugin, opencodeReporter,
    readReports, reportClaude, reportersOn, statOf, withClaudeHooks
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
let AGENTS

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-agents-')))
    // Every report this test writes, by any path (a hook, the plugin, a default), goes to a scratch state folder.
    process.env.XDG_STATE_HOME = env.XDG_STATE_HOME = path.join(scratch, 'state')
    AGENTS = agentsDir()
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

test('a report goes to the person\'s own state folder, is read against the lane it works in, and goes when the session ends', async () => {
    const written = reportClaude(JSON.stringify(event('PreToolUse', { tool_name: 'Edit', tool_use_id: 'e1' })), { chain: chainTo(RUNNING) })
    assert.equal(written.pid, RUNNING, 'the agent is the first process above the hook that is not a shell')
    assert.deepEqual(written.pids, [RUNNING, 4_194_103])
    const file = path.join(AGENTS, 'claude-abc-123.json')
    assert.ok(fs.existsSync(file), 'in the person\'s ~/.local/state/lanekit/agents')
    assert.equal(written.host, os.hostname(), 'named for the machine it was written on')
    assert.ok(!fs.existsSync(path.join(laneDir, '.lanekit')) && !fs.existsSync(path.join(repo, '.lanekit', 'agents')), 'nothing in the repository')
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
    const file = path.join(AGENTS, 'claude-dead-one.json')
    assert.ok(fs.existsSync(file))
    assert.deepEqual(readReports().map((report) => report.key), [], 'not read')
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'live-one' }), { chain: chainTo(RUNNING) })
    assert.ok(!fs.existsSync(file), 'cleared when another starts')
    assert.deepEqual(readReports().map((report) => report.key), ['claude-live-one'])
    reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: 'live-one' }), { chain: chainTo(RUNNING) })
})

test('a process\'s name and parent are read from Linux\'s /proc as it writes them, and from ps elsewhere', () => {
    assert.deepEqual(statOf('4242 (claude) S 4100 4242 4100 34816 4242 4194304 1234 0 0 0 5 2 0 0 20 0 9 0 812 1\n'), { name: 'claude', parent: 4100 })
    assert.deepEqual(statOf('77 (tmux: server) S 1 77 77 0 -1 4194624'), { name: 'tmux: server', parent: 1 }, 'a name with a space')
    assert.deepEqual(statOf('88 (odd) name)) R 12 88 88'), { name: 'odd) name)', parent: 12 }, 'and with brackets')
    // This machine, whichever way it reads: this test's own process, under the process that started it.
    const chain = ancestry(process.pid)
    assert.equal(chain[0].pid, process.pid)
    assert.equal(chain[1].pid, process.ppid)
    assert.ok(chain[0].name.length > 0)
})

test('a report file is read for what it may say, and nothing else', () => {
    const dir = AGENTS
    const host = os.hostname()
    fs.writeFileSync(path.join(dir, 'claude-odd.json'), JSON.stringify({ key: 'claude-odd', agent: 'claude', host, state: 'running', tool: 'x'.repeat(500), pid: RUNNING, at: 1, extra: '<script>', pids: ['1', RUNNING] }))
    fs.writeFileSync(path.join(dir, 'claude-bad.json'), JSON.stringify({ key: 'claude-bad', agent: 'claude', host, state: 'exploding', pid: RUNNING }))
    fs.writeFileSync(path.join(dir, 'not-json.json'), '{')
    const read = readReports()
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
    assert.ok(fs.existsSync(path.join(AGENTS, 'claude-via-lane.json')))
    const ended = shim(JSON.stringify({ ...event('SessionEnd'), session_id: 'via-lane' }))
    assert.equal(ended.status, 0)
    assert.ok(!fs.existsSync(path.join(AGENTS, 'claude-via-lane.json')))
    const junk = shim('not json at all')
    assert.equal(junk.status, 0)
    assert.equal(junk.stdout, '')
    const outside = shim(JSON.stringify({ ...event('Stop'), session_id: 'outside', cwd: scratch }))
    assert.equal(outside.status, 0, 'outside a repository too')
    assert.ok(fs.existsSync(path.join(AGENTS, 'claude-outside.json')))
    shim(JSON.stringify({ ...event('SessionEnd'), session_id: 'outside', cwd: scratch }))
    const other = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'report', 'codex'], { cwd: laneDir, env, input: '{}', encoding: 'utf8' })
    assert.equal(other.status, 0)
    assert.match(other.stderr, /knows claude/)
})

test('OpenCode\'s events come to one state for the process, written only when it changes', async () => {
    const times = [1000]
    const hooks = await opencodeReporter({ directory: laneDir, worktree: laneDir }, { now: () => times.at(-1), pid: RUNNING, chain: [{ pid: RUNNING, name: 'opencode' }, { pid: 4_194_103, name: 'zsh' }] })
    const file = path.join(AGENTS, `opencode-${RUNNING}.json`)
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

test('OpenCode\'s plugin finds this lanekit, hands over to it, and does nothing outside a repository with lanes', async () => {
    const plugin = path.join(scratch, 'opencode-plugins', 'lanekit.js')
    fs.mkdirSync(path.dirname(plugin), { recursive: true })
    fs.writeFileSync(plugin, opencodePlugin(KIT))
    const { LaneKitReport } = await import(pathToFileURL(plugin).href)
    const hooks = await LaneKitReport({ directory: laneDir, worktree: laneDir })
    assert.equal(typeof hooks.event, 'function')
    assert.equal(typeof hooks['tool.execute.before'], 'function')
    const file = path.join(AGENTS, `opencode-${process.pid}.json`)
    assert.ok(fs.existsSync(file))
    fs.rmSync(file)
    const elsewhere = path.join(scratch, 'elsewhere')
    fs.mkdirSync(elsewhere, { recursive: true })
    const there = await LaneKitReport({ directory: elsewhere, worktree: elsewhere })
    assert.equal(typeof there.event, 'function', 'outside a repository too')
    fs.rmSync(path.join(AGENTS, `opencode-${process.pid}.json`))
})

test('an agent in a repository without lanes is named by it, and the repository is given no file', async () => {
    const plain = path.join(scratch, 'plain')
    fs.mkdirSync(path.join(plain, 'src'), { recursive: true })
    git(plain, 'init', '-q', '-b', 'main')
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'no-lanes', cwd: path.join(plain, 'src') }), { chain: chainTo(RUNNING) })
    const repos = [{ id: 'demo', path: repo, lanes: [{ name: 'midi-export', path: laneDir, exists: true }] }]
    const found = agentsIn(repos).find((agent) => agent.session === 'no-lanes')
    assert.deepEqual([found.repo, found.lane, found.where], [null, null, 'plain'], 'the repository it is in, by name')
    assert.deepEqual(fs.readdirSync(plain).sort(), ['.git', 'src'], 'nothing written into it')
    reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: 'no-lanes', cwd: plain }), { chain: chainTo(RUNNING) })
    const hooks = await opencodeReporter({ directory: scratch, worktree: scratch }, { pid: RUNNING, chain: [] })
    assert.equal(typeof hooks.event, 'function', 'and in a folder in no repository at all, OpenCode reports too')
    assert.equal(agentsIn([]).find((agent) => agent.agent === 'opencode').where, path.basename(scratch))
    fs.rmSync(path.join(AGENTS, `opencode-${RUNNING}.json`))
})

test('another machine\'s reports in a shared home are not read, and are cleared away after some days', () => {
    const theirs = (key, at) => fs.writeFileSync(path.join(AGENTS, `${key}.json`), JSON.stringify({ key, agent: 'claude', host: 'another-workspace', state: 'thinking', cwd: laneDir, at, pid: RUNNING, pids: [RUNNING] }))
    theirs('claude-theirs-new', Date.now())
    theirs('claude-theirs-old', Date.now() - 4 * 24 * 60 * 60 * 1000)
    assert.deepEqual(readReports().map((report) => report.key), [], 'its process ids mean nothing here, however alive one looks')
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'mine' }), { chain: chainTo(RUNNING) })
    assert.ok(fs.existsSync(path.join(AGENTS, 'claude-theirs-new.json')), 'a recent one is left for its own machine')
    assert.ok(!fs.existsSync(path.join(AGENTS, 'claude-theirs-old.json')), 'an old one is cleared')
    assert.equal(readReports({ host: 'another-workspace' }).length, 1, 'and read where it was written')
    fs.rmSync(path.join(AGENTS, 'claude-theirs-new.json'))
    reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: 'mine' }), { chain: chainTo(RUNNING) })
})

test('Claude Code\'s hooks are added beside the ones there, once, in the background but for SessionEnd, and never fail it', () => {
    const theirs = { permissions: { allow: ['Bash(npm test)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }] } }
    const { settings, added } = withClaudeHooks(theirs, KIT)
    assert.equal(added, CLAUDE_EVENTS.length)
    assert.deepEqual(settings.permissions, theirs.permissions)
    assert.equal(settings.hooks.PreToolUse.length, 2)
    assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, './guard.sh', 'theirs first, untouched')
    const ours = settings.hooks.PreToolUse[1].hooks[0]
    assert.equal(ours.command, `node '${KIT}/dev/lane.mjs' report claude || true`)
    assert.equal(ours.async, true)
    assert.equal(settings.hooks.SessionEnd[0].hooks[0].async, undefined, 'SessionEnd waits: Claude Code may be gone before a background hook starts')
    assert.equal(withClaudeHooks(settings, KIT).added, 0, 'once')
    // lanekit moved: LaneKit's own are made to name it, and nothing else changes.
    const moved = withClaudeHooks(settings, '/opt/lanekit')
    assert.deepEqual([moved.added, moved.updated], [0, CLAUDE_EVENTS.length])
    assert.equal(moved.settings.hooks.PreToolUse[1].hooks[0].command, "node '/opt/lanekit/dev/lane.mjs' report claude || true")
    assert.equal(moved.settings.hooks.PreToolUse[0].hooks[0].command, './guard.sh')
    // A path with a quote in it is still one word to the shell.
    assert.equal(claudeHooks("/srv/it's/lanekit").Stop.command, `node '/srv/it'\\''s/lanekit/dev/lane.mjs' report claude || true`)
})

test('the hook Claude Code is given runs the reporter, from any folder', () => {
    const { command } = claudeHooks(KIT).SessionStart
    const ran = spawnSync('sh', ['-c', command], { cwd: scratch, env, input: JSON.stringify({ ...event('SessionStart'), session_id: 'by-hook' }), encoding: 'utf8' })
    assert.equal(ran.status, 0, ran.stderr)
    assert.equal(ran.stdout, '')
    assert.ok(fs.existsSync(path.join(AGENTS, 'claude-by-hook.json')))
    spawnSync('sh', ['-c', command], { cwd: scratch, env, input: JSON.stringify({ ...event('SessionEnd'), session_id: 'by-hook' }), encoding: 'utf8' })
    assert.ok(!fs.existsSync(path.join(AGENTS, 'claude-by-hook.json')))
})

test('the reporters are installed once a machine, where Claude Code and OpenCode look, and nothing not LaneKit\'s is replaced', () => {
    const home = path.join(scratch, 'home')
    const places = { home, env: {} }
    const settingsFile = path.join(home, '.claude', 'settings.json')
    const pluginFile = path.join(home, '.config', 'opencode', 'plugins', 'lanekit.js')
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
    fs.writeFileSync(settingsFile, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }))
    assert.deepEqual([reportersOn(KIT, places).claude.state, reportersOn(KIT, places).opencode.state], ['missing', 'missing'])
    const checked = installForUser(KIT, { ...places, check: true })
    assert.equal(checked.wrote.length, 2)
    assert.ok(!fs.existsSync(pluginFile), '--check writes nothing')
    const first = installForUser(KIT, places)
    assert.deepEqual(first.wrote, [`${settingsFile} (LaneKit's hooks)`, pluginFile])
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    assert.equal(settings.model, 'opus')
    assert.equal(settings.hooks.Stop[0].hooks[0].command, 'say done', 'theirs kept, first')
    assert.equal(settings.hooks.Stop.length, 2)
    assert.equal(fs.readFileSync(pluginFile, 'utf8'), opencodePlugin(KIT))
    assert.deepEqual([reportersOn(KIT, places).claude.state, reportersOn(KIT, places).opencode.state], ['current', 'current'])
    assert.deepEqual(installForUser(KIT, places).wrote, [], 'once')
    // Another lanekit: LaneKit's own brought up to date.
    assert.equal(installForUser('/opt/lanekit', places).wrote.length, 2)
    assert.match(fs.readFileSync(pluginFile, 'utf8'), /\["\/opt\/lanekit"/)
    // What is not LaneKit's is left, and said.
    fs.writeFileSync(pluginFile, '// somebody else\'s plugin\n')
    fs.writeFileSync(settingsFile, '{ not json')
    const refused = installForUser(KIT, places)
    assert.deepEqual(refused.wrote, [])
    assert.equal(refused.warnings.length, 2)
    assert.equal(fs.readFileSync(pluginFile, 'utf8'), '// somebody else\'s plugin\n')
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), '{ not json')
    // Where Claude Code and OpenCode are told to look instead.
    const elsewhere = installForUser(KIT, { home, env: { CLAUDE_CONFIG_DIR: path.join(scratch, 'cc'), XDG_CONFIG_HOME: path.join(scratch, 'xdg') } })
    assert.deepEqual(elsewhere.wrote, [`${path.join(scratch, 'cc', 'settings.json')} (LaneKit's hooks)`, path.join(scratch, 'xdg', 'opencode', 'plugins', 'lanekit.js')])
})

test('every repository\'s agents are attributed to the lane whose folder holds theirs, the main checkout else', () => {
    const repos = [{ id: 'demo', path: repo, lanes: [{ name: 'midi-export', path: laneDir, exists: true }] }]
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'in-main', cwd: path.join(repo) }), { chain: chainTo(RUNNING) })
    reportClaude(JSON.stringify({ ...event('SessionStart'), session_id: 'in-lane' }), { chain: chainTo(RUNNING) })
    const found = agentsIn(repos).map((agent) => [agent.session, agent.lane])
    assert.deepEqual(found.sort(), [['in-lane', 'midi-export'], ['in-main', null]])
    for (const session of ['in-main', 'in-lane']) reportClaude(JSON.stringify({ ...event('SessionEnd'), session_id: session }), { chain: chainTo(RUNNING) })
})

test('agent-reports installs for the person running it, and says what it did in words or in JSON', () => {
    const home = path.join(scratch, 'home-cli')
    const run = (...args) => spawnSync(process.execPath, [path.join(KIT, 'bin', 'agent-reports.mjs'), ...args], {
        env: { ...env, HOME: home, CLAUDE_CONFIG_DIR: '', XDG_CONFIG_HOME: '', NO_COLOR: '1' }, encoding: 'utf8'
    })
    const checked = run('--check', '--json')
    assert.equal(checked.status, 0, checked.stderr)
    assert.equal(JSON.parse(checked.stdout).wrote.length, 2)
    assert.ok(!fs.existsSync(home), '--check writes nothing')
    const words = run()
    assert.equal(words.status, 0, words.stderr)
    assert.match(words.stdout, /wrote\s+.*\.claude\/settings\.json \(LaneKit's hooks\)/)
    assert.ok(fs.existsSync(path.join(home, '.config', 'opencode', 'plugins', 'lanekit.js')))
    const again = JSON.parse(run('--json').stdout)
    assert.deepEqual([again.wrote.length, again.kept.length, again.warnings.length], [0, 2, 0], 'settled: nothing to say')
})
