/**
 * Which agents are at work in which lane, and what each is doing — thinking, running a tool, waiting
 * on a person, done — as the agents themselves say it.
 *
 * WHY THE AGENTS SAY IT. Nothing outside an agent can tell its thinking from its waiting, and a
 * process's folder says where it started, not where it works: `/lane` moves a session into a lane
 * long after it began. So each agent reports itself. Claude Code does it through hooks in the
 * repository's .claude/settings.json, which run `./<slug> lane report claude` in the background on
 * each event, the event on stdin. OpenCode does it through a plugin in .opencode/plugins/, which finds
 * this file where the shim finds lanekit and runs opencodeReporter inside OpenCode. Both write one
 * small file per agent into the main checkout's .lanekit/agents/, pooled there as the gate's runs are
 * (runs.mjs), so every lane's agents are read in one place.
 *
 * WHAT A REPORT HOLDS. The agent, its session, the folder it works in, its state and since when, the
 * name of the tool it is running or asks to run, and the ids of its process and those above it, by
 * which the editor finds its terminal. Never what a tool was given or what anybody said: a command
 * line or a prompt can hold a token, and these files are drawn on a page.
 *
 * GONE MEANS GONE. A session that ends removes its file. A report whose process is no longer
 * running is not read, so an agent killed without a word drops off the page at the next reading, and
 * the next agent to start in that repository clears its file away.
 *
 * No dependency: node's own modules.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { isUnder, mainRepoFrom } from './lanes.mjs'

export const STATES = ['ready', 'thinking', 'running', 'needs-you', 'done', 'failed']
export const AGENT_NAMES = { claude: 'Claude', opencode: 'OpenCode' }
const SESSION = /^[A-Za-z0-9_-]{1,80}$/
const KEY = /^(claude|opencode)-[A-Za-z0-9_-]{1,80}$/
// A report with no process to ask after (one the reporter could not find) is believed for this long.
const UNPROVEN_MS = 12 * 60 * 60 * 1000
// The shells between an agent and its hooks, and between a terminal and its agent.
const SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|csh|tcsh)$/

export const agentsDirOf = (mainRepo) => path.join(mainRepo, '.lanekit', 'agents')

/** One /proc/<pid>/stat, "pid (name) state ppid …": the name may hold spaces and brackets, so it is cut at the last. */
export const statOf = (text) => {
    const close = text.lastIndexOf(')')
    return { name: text.slice(text.indexOf('(') + 1, close), parent: Number(text.slice(close + 2).split(' ')[1]) }
}

/** A process and those above it, nearest first, as `{ pid, name }`: from /proc where there is one, else one `ps`. */
export const ancestry = (pid) => {
    const chain = []
    if (fs.existsSync('/proc/self/stat')) {
        for (let at = pid; at > 1 && chain.length < 32;) {
            let stat
            try { stat = statOf(fs.readFileSync(`/proc/${at}/stat`, 'utf8')) } catch { break }
            chain.push({ pid: at, name: stat.name })
            at = stat.parent
        }
        return chain
    }
    const listed = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' })
    const table = new Map()
    for (const line of String(listed.stdout ?? '').split('\n')) {
        const row = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
        if (row) table.set(Number(row[1]), { parent: Number(row[2]), name: path.basename(row[3].trim()) })
    }
    for (let at = pid; at > 1 && table.has(at) && chain.length < 32; at = table.get(at).parent) chain.push({ pid: at, name: table.get(at).name })
    return chain
}

/** Whether a process is running: one owned by somebody else still counts. */
export const alive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 1) return false
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        return error.code === 'EPERM'
    }
}

const live = (report, now) => (report.pid ? alive(report.pid) : now - report.at < UNPROVEN_MS)

const fileOf = (dir, key) => path.join(dir, `${key}.json`)
const readReport = (dir, key) => {
    try { return JSON.parse(fs.readFileSync(fileOf(dir, key), 'utf8')) } catch { return null }
}
/** Written whole or not at all: a page reading mid-write sees the report before or the one after. */
const writeReport = (dir, report) => {
    fs.mkdirSync(dir, { recursive: true })
    const temp = `${fileOf(dir, report.key)}.${process.pid}.tmp`
    fs.writeFileSync(temp, JSON.stringify(report) + '\n')
    fs.renameSync(temp, fileOf(dir, report.key))
}
const removeReport = (dir, key) => {
    if (KEY.test(key)) fs.rmSync(fileOf(dir, key), { force: true })
}

/** What a report may say, and nothing else: a file in the repository is not trusted to be the shape it should. */
const cleaned = (raw) => {
    if (!raw || typeof raw !== 'object' || !KEY.test(String(raw.key)) || !AGENT_NAMES[raw.agent] || !STATES.includes(raw.state)) return null
    const number = (value) => (Number.isFinite(value) ? value : 0)
    return {
        key: raw.key,
        agent: raw.agent,
        session: SESSION.test(String(raw.session)) ? raw.session : null,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        state: raw.state,
        tool: typeof raw.tool === 'string' ? raw.tool.slice(0, 40) : null,
        at: number(raw.at),
        since: number(raw.since) || number(raw.at),
        pid: Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : null,
        pids: Array.isArray(raw.pids) ? raw.pids.filter((pid) => Number.isInteger(pid) && pid > 1).slice(0, 32) : []
    }
}

/** A repository's reports whose agent is still at work, in the order they were named. */
export const readReports = (mainRepo, { now = Date.now() } = {}) => {
    const dir = agentsDirOf(mainRepo)
    let names
    try { names = fs.readdirSync(dir) } catch { return [] }
    return names.filter((name) => name.endsWith('.json')).sort()
        .map((name) => { try { return cleaned(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) } catch { return null } })
        .filter((report) => report && live(report, now))
}

/** The files of agents no longer at work, cleared away when another starts. */
const prune = (dir, now) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const report = cleaned(readReport(dir, name.slice(0, -'.json'.length)))
        if (!report || !live(report, now)) removeReport(dir, name.slice(0, -'.json'.length))
    }
}

/**
 * Every repository's agents, each with the lane it works in: the lane whose folder holds the folder it
 * works in, or null for the main checkout (and for a lane since removed).
 */
export const agentsIn = (repos, options) => repos.filter((repo) => !repo.error).flatMap((repo) =>
    readReports(repo.main?.path ?? repo.path, options).map((report) => {
        const lane = repo.lanes.filter((candidate) => candidate.exists && isUnder(report.cwd, candidate.path))
            .sort((a, b) => b.path.length - a.path.length)[0]
        return { repo: repo.id, lane: lane?.name ?? null, ...report }
    }))

// ---------------------------------------------------------------------------
// Claude Code: a hook on each event, in the background
// ---------------------------------------------------------------------------

/** The hook events that move a Claude Code session from one state to another. SessionEnd's runs in the foreground,
    since Claude Code may be gone before a background one starts; it only removes a file. */
export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'PermissionDenied', 'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'CwdChanged', 'SessionEnd']
const REPORTS = 'lane report claude'
/** The hooks, for a repository's .claude/settings.json. `|| true`: a reporter that fails never stops Claude Code. */
export const claudeHooks = (slug) => Object.fromEntries(CLAUDE_EVENTS.map((event) => [event, [{
    hooks: [{ type: 'command', command: `"$CLAUDE_PROJECT_DIR"/${slug} ${REPORTS} || true`, ...(event === 'SessionEnd' ? { timeout: 5 } : { async: true }) }]
}]]))

/** Settings with LaneKit's hooks added beside whatever hooks are there, and how many events gained one. */
export const withClaudeHooks = (settings, slug) => {
    const hooks = { ...(settings?.hooks ?? {}) }
    let added = 0
    for (const [event, groups] of Object.entries(claudeHooks(slug))) {
        const have = Array.isArray(hooks[event]) ? hooks[event] : []
        if (have.some((group) => (group?.hooks ?? []).some((hook) => String(hook?.command ?? '').includes(REPORTS)))) continue
        hooks[event] = [...have, ...groups]
        added++
    }
    return { settings: { ...settings, hooks }, added }
}

const NEEDS_YOU = new Set(['permission_prompt', 'elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'])

/**
 * Claude Code's report after one hook event, from the report before it; null where the event changes
 * nothing. The hooks run in the background, so two can finish out of order: a tool's PreToolUse landing
 * after its PostToolUse would say it is still running. So a tool already finished is not started
 * again, and an event older than the report it would replace is dropped.
 */
export const claudeStep = (before, input, { now, pid = null, pids = [] }) => {
    const session = input?.session_id
    if (!SESSION.test(String(session))) return null
    if (before && before.at > now) return null
    const tool = typeof input.tool_name === 'string' ? input.tool_name.slice(0, 40) : null
    const id = typeof input.tool_use_id === 'string' ? input.tool_use_id : null
    const finished = Array.isArray(before?.finished) ? before.finished : []
    let state
    let shown = null
    let ended = null
    switch (input.hook_event_name) {
        case 'SessionStart': state = 'ready'; break
        case 'UserPromptSubmit': state = 'thinking'; break
        case 'PreToolUse':
            if (id && finished.includes(id)) return null
            state = 'running'; shown = tool; break
        case 'PermissionRequest':
            if (id && finished.includes(id)) return null
            state = 'needs-you'; shown = tool; break
        case 'PostToolUse': case 'PostToolUseFailure': state = 'thinking'; ended = id; break
        case 'PermissionDenied': case 'ElicitationResult': state = 'thinking'; break
        case 'Elicitation': state = 'needs-you'; break
        case 'Notification':
            if (!NEEDS_YOU.has(input.notification_type)) return null
            state = 'needs-you'; shown = before?.tool ?? null; break
        case 'Stop': state = 'done'; break
        case 'StopFailure': state = 'failed'; break
        case 'CwdChanged': state = before?.state ?? 'ready'; shown = before?.tool ?? null; break
        default: return null
    }
    return {
        key: `claude-${session}`,
        agent: 'claude',
        session,
        cwd: typeof input.cwd === 'string' ? input.cwd : before?.cwd ?? null,
        state,
        tool: shown,
        at: now,
        since: before?.state === state && before?.since ? before.since : now,
        pid: pid ?? before?.pid ?? null,
        pids: pids.length ? pids : before?.pids ?? [],
        finished: ended ? [ended, ...finished.filter((other) => other !== ended)].slice(0, 16) : finished
    }
}

/**
 * One hook event, from its JSON. The agent is the nearest process above the hook that is not a shell:
 * Claude Code, however it was installed. Says nothing on stdout, which Claude Code would read as words
 * for the model after SessionStart and UserPromptSubmit.
 */
export const reportClaude = (text, { now = Date.now(), chain = ancestry(process.pid) } = {}) => {
    let input
    try { input = JSON.parse(text) } catch { return null }
    const cwd = typeof input?.cwd === 'string' && fs.existsSync(input.cwd) ? input.cwd : process.cwd()
    let dir
    try { dir = agentsDirOf(mainRepoFrom(cwd)) } catch { return null }   // not in a repository: nothing to say
    if (!SESSION.test(String(input?.session_id))) return null
    const key = `claude-${input.session_id}`
    if (input.hook_event_name === 'SessionEnd') { removeReport(dir, key); return 'removed' }
    const agent = chain.slice(1).find((entry) => !SHELL.test(entry.name))
    const pids = agent ? chain.slice(chain.indexOf(agent)).map((entry) => entry.pid) : []
    const next = claudeStep(readReport(dir, key), input, { now, pid: agent?.pid ?? null, pids })
    if (!next) return null
    if (input.hook_event_name === 'SessionStart') prune(dir, now)
    writeReport(dir, next)
    return next
}

/** `lane report claude`: the event on stdin. It never fails its caller: what went wrong goes to stderr. */
export const reportMain = async (argv) => {
    try {
        if (argv[0] !== 'claude') throw new Error(`lane report knows claude, not ${argv[0] ?? 'nothing'}: OpenCode reports through its plugin.`)
        const chunks = []
        for await (const chunk of process.stdin) chunks.push(chunk)
        reportClaude(Buffer.concat(chunks).toString('utf8'))
    } catch (error) {
        process.stderr.write(`lanekit: no report of this agent: ${error.message}\n`)
    }
    process.exit(0)
}

// ---------------------------------------------------------------------------
// OpenCode: a plugin, inside OpenCode
// ---------------------------------------------------------------------------

/** The plugin a repository carries in .opencode/plugins/: it finds lanekit where the shim does and hands over. */
export const OPENCODE_PLUGIN = `// LaneKit's report of what this OpenCode is doing (thinking, running a tool, waiting on you, done) and in
// which lane, for LaneKit's page and the editor. Written by lanekit's adopt. The work is lanekit's own
// (lib/agents.mjs), found where the project's shim finds lanekit; with no lanekit on the machine, this does nothing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const LaneKitReport = async (input) => {
    const here = input.worktree || input.directory || process.cwd()
    const home = os.homedir()
    const kit = [process.env.LANEKIT, path.join(here, '..', 'lanekit'), '/opt/lanekit', path.join(home, '.lanekit'), path.join(home, 'Documents', 'Programming', 'lanekit')]
        .find((dir) => dir && fs.existsSync(path.join(dir, 'lib', 'agents.mjs')))
    if (!kit) return {}
    try {
        const { opencodeReporter } = await import(pathToFileURL(path.join(kit, 'lib', 'agents.mjs')).href)
        return await opencodeReporter(input)
    } catch {
        return {}
    }
}
`

const short = (value) => (typeof value === 'string' && value ? value.slice(0, 40) : null)

/**
 * OpenCode's hooks, reporting this OpenCode: one report for the process, whichever of its sessions is
 * at work, since a session hands work to sessions of its own. It is waiting on you while any of them
 * asks a permission or a question, running while a tool runs, thinking while any is busy, and done
 * (or failed) when all are idle. Written only when that changes: OpenCode says something many times
 * a second while it writes.
 */
export const opencodeReporter = async ({ directory, worktree } = {}, { now = () => Date.now(), pid = process.pid, chain = ancestry(pid) } = {}) => {
    const cwd = directory || worktree || process.cwd()
    let dir
    try { dir = agentsDirOf(mainRepoFrom(cwd)) } catch { return {} }
    const key = `opencode-${pid}`
    const busy = new Set()
    const asking = new Map()   // request id -> { session, tool }
    const tools = new Map()    // call id -> { session, tool }
    let session = null
    let ended = 'ready'
    let failed = false
    let written = null
    let since = now()
    const say = () => {
        const state = asking.size ? 'needs-you' : tools.size ? 'running' : busy.size ? 'thinking' : failed ? 'failed' : ended
        const tool = state === 'needs-you' ? [...asking.values()].at(-1).tool : state === 'running' ? [...tools.values()].at(-1).tool : null
        const said = JSON.stringify([state, tool, session])
        if (said === written) return
        if (!written || JSON.parse(written)[0] !== state) since = now()
        written = said
        try {
            writeReport(dir, { key, agent: 'opencode', session, cwd, state, tool, at: now(), since, pid, pids: chain.map((entry) => entry.pid) })
        } catch {}
    }
    const settle = (id) => {
        busy.delete(id)
        for (const [call, running] of tools) if (running.session === id) tools.delete(call)
        for (const [request, asked] of asking) if (asked.session === id) asking.delete(request)
        if (!busy.size) ended = 'done'
    }
    prune(dir, now())
    say()
    process.once('exit', () => removeReport(dir, key))
    return {
        event: async ({ event } = {}) => {
            const p = event?.properties ?? {}
            const id = typeof p.sessionID === 'string' ? p.sessionID : null
            switch (event?.type) {
                case 'session.status':
                    if (p.status?.type === 'busy' || p.status?.type === 'retry') { busy.add(id); failed = false; session = id ?? session } else if (p.status?.type === 'idle') settle(id)
                    break
                case 'session.idle': settle(id); break
                case 'session.error':
                    settle(id)
                    if (p.error?.name !== 'MessageAbortedError') failed = true
                    break
                case 'session.deleted': settle(p.info?.id ?? null); break
                case 'permission.asked': case 'permission.v2.asked': case 'permission.updated':
                    asking.set(p.id ?? p.requestID, { session: id, tool: short(p.permission) ?? short(p.type) })
                    break
                case 'question.asked': case 'question.v2.asked':
                    asking.set(p.id ?? p.requestID, { session: id, tool: 'question' })
                    break
                case 'permission.replied': case 'permission.v2.replied':
                case 'question.replied': case 'question.rejected': case 'question.v2.replied': case 'question.v2.rejected':
                    asking.delete(p.requestID ?? p.permissionID ?? p.id)
                    break
                default: return
            }
            say()
        },
        'tool.execute.before': async (input) => { tools.set(input?.callID, { session: input?.sessionID ?? null, tool: short(input?.tool) }); say() },
        'tool.execute.after': async (input) => { tools.delete(input?.callID); say() }
    }
}

// ---------------------------------------------------------------------------
// writing the reporters into a repository: adopt's and init's
// ---------------------------------------------------------------------------

/**
 * The reporters for a repository's agents: LaneKit's hooks added to .claude/settings.json beside any
 * there, and the plugin written to .opencode/plugins/lanekit.js where it is missing. Nothing replaced.
 */
export const installReporters = (dir, slug, { agents = ['claude', 'opencode'], check = false } = {}) => {
    const said = { wrote: [], kept: [], warnings: [] }
    if (agents.includes('claude')) {
        const rel = path.join('.claude', 'settings.json')
        const file = path.join(dir, rel)
        let settings = {}
        let readable = true
        if (fs.existsSync(file)) {
            try {
                settings = JSON.parse(fs.readFileSync(file, 'utf8'))
            } catch (error) {
                readable = false
                said.warnings.push(`${rel} is not valid JSON (${error.message}), so LaneKit's status hooks were not added: fix it and adopt again`)
            }
        }
        if (readable) {
            const { settings: next, added } = withClaudeHooks(settings, slug)
            if (!added) said.kept.push(`${rel} (its status hooks)`)
            else {
                if (!check) {
                    fs.mkdirSync(path.dirname(file), { recursive: true })
                    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
                }
                said.wrote.push(`${rel} (LaneKit's status hooks)`)
            }
        }
    }
    if (agents.includes('opencode')) {
        const rel = path.join('.opencode', 'plugins', 'lanekit.js')
        const file = path.join(dir, rel)
        if (fs.existsSync(file)) said.kept.push(rel)
        else {
            if (!check) {
                fs.mkdirSync(path.dirname(file), { recursive: true })
                fs.writeFileSync(file, OPENCODE_PLUGIN)
            }
            said.wrote.push(rel)
        }
    }
    return said
}
