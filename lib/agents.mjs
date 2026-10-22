/**
 * Which agents are at work in which lane, and what each is doing — thinking, running a tool, waiting
 * on a person, done — as the agents themselves say it.
 *
 * WHY THE AGENTS SAY IT. Nothing outside an agent can tell its thinking from its waiting, and a
 * process's folder says where it started, not where it works: `/lane` moves a session into a lane
 * long after it began. So each agent reports itself. Claude Code does it through hooks, which run
 * `node <lanekit>/dev/lane.mjs report claude` in the background on each event, the event on stdin.
 * OpenCode does it through a plugin, which runs opencodeReporter inside OpenCode: OpenCode 1's server
 * plugin, or OpenCode 2's TUI plugin, since OpenCode 2 runs server plugins in one background service
 * shared by every terminal (opencodeTui, below). Both write one small
 * file per agent into the person's own ~/.local/state/lanekit/agents/, whatever folder the agent works
 * in. The reader puts each on the lane, or main checkout, whose folder holds the agent's. An agent
 * anywhere else (a repository without lanes, say) is named by its folder, so the editor still says
 * when it needs somebody (the owner, 1 Oct). No repository is given a file.
 *
 * ONCE A MACHINE, NOT ONCE A REPOSITORY. The hook goes into the person's own Claude Code settings and
 * the plugin into their own OpenCode plugins (installForUser, below), asked once by the editor's
 * extension, run by bin/agent-reports.mjs, or by a workspace's setup: one install covers every agent
 * the person starts on the machine, and nothing is committed anywhere.
 *
 * ONE HOME, SEVERAL MACHINES. A person's workspaces can share a home, and with it this folder, while
 * each runs its own processes. So a report names the machine it was written on, and a machine reads
 * only its own: another's process ids mean nothing here, and its folders are other folders.
 *
 * WHAT A REPORT HOLDS. The agent, its session, the folder it works in, its state and since when, the
 * name of the tool it is running or asks to run, the ids of its process and those above it, and the
 * tmux pane it runs in where it runs in one, by which the editor finds its terminal, or attaches a
 * new one to it. Never what a tool was given or what anybody said: a command
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
import os from 'node:os'
import path from 'node:path'

import { isUnder } from './lanes.mjs'

export const STATES = ['ready', 'thinking', 'running', 'needs-you', 'done', 'failed']
export const AGENT_NAMES = { claude: 'Claude', opencode: 'OpenCode' }
const SESSION = /^[A-Za-z0-9_-]{1,80}$/
const KEY = /^(claude|opencode)-[A-Za-z0-9_-]{1,80}$/
// A report with no process to ask after (one the reporter could not find) is believed for this long; and another
// machine's, whose processes cannot be asked from here, is cleared away after the longer.
const UNPROVEN_MS = 12 * 60 * 60 * 1000
const ELSEWHERE_MS = 3 * 24 * 60 * 60 * 1000
// The shells between an agent and its hooks, and between a terminal and its agent.
const SHELL = /^-?(sh|bash|zsh|dash|fish|ksh|csh|tcsh)$/

/** Where this person's agents report: their own state folder, as the XDG convention puts it. */
export const agentsDir = ({ home = os.homedir(), env = process.env } = {}) =>
    path.join(env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'lanekit', 'agents')

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

/** The tmux pane an agent runs in, from what tmux puts in its environment: the server's socket and the pane. */
export const tmuxOf = (env = process.env) => {
    const socket = String(env.TMUX ?? '').split(',')[0]
    const pane = String(env.TMUX_PANE ?? '')
    return path.isAbsolute(socket) && /^%\d+$/.test(pane) ? { socket, pane } : null
}

const live = (report, now) => (report.pid ? alive(report.pid) : now - report.at < UNPROVEN_MS)
const HOST = /^[A-Za-z0-9._-]{1,253}$/

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

/** What a report may say, and nothing else: a file is not trusted to be the shape it should. */
const cleaned = (raw) => {
    if (!raw || typeof raw !== 'object' || !KEY.test(String(raw.key)) || !AGENT_NAMES[raw.agent] || !STATES.includes(raw.state)) return null
    const number = (value) => (Number.isFinite(value) ? value : 0)
    return {
        key: raw.key,
        agent: raw.agent,
        host: HOST.test(String(raw.host)) ? raw.host : null,
        session: SESSION.test(String(raw.session)) ? raw.session : null,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : null,
        state: raw.state,
        tool: typeof raw.tool === 'string' ? raw.tool.slice(0, 40) : null,
        at: number(raw.at),
        since: number(raw.since) || number(raw.at),
        pid: Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : null,
        pids: Array.isArray(raw.pids) ? raw.pids.filter((pid) => Number.isInteger(pid) && pid > 1).slice(0, 32) : [],
        tmux: raw.tmux && typeof raw.tmux === 'object' ? tmuxOf({ TMUX: raw.tmux.socket, TMUX_PANE: raw.tmux.pane }) : null
    }
}

/** This machine's reports whose agent is still at work, in the order they were named. */
export const readReports = ({ dir = agentsDir(), host = os.hostname(), now = Date.now() } = {}) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return [] }
    return names.filter((name) => name.endsWith('.json')).sort()
        .map((name) => { try { return cleaned(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))) } catch { return null } })
        .filter((report) => report && report.host === host && live(report, now))
}

/** The files of agents no longer at work, cleared away when another starts: this machine's whose process has gone,
    and another's after some days, since its processes cannot be asked from here. */
const prune = (dir, host, now) => {
    let names
    try { names = fs.readdirSync(dir) } catch { return }
    for (const name of names.filter((entry) => entry.endsWith('.json'))) {
        const key = name.slice(0, -'.json'.length)
        const report = cleaned(readReport(dir, key))
        const gone = !report || (report.host === host ? !live(report, now) : now - report.at > ELSEWHERE_MS)
        if (gone) removeReport(dir, key)
    }
}

/** A folder as a person names it: the repository it is in, else itself. */
const placeOf = (cwd) => {
    if (!cwd) return null
    for (let at = cwd; at && at !== path.dirname(at); at = path.dirname(at)) {
        if (fs.existsSync(path.join(at, '.git'))) return path.basename(at)
    }
    return path.basename(cwd) || cwd
}

/**
 * This machine's agents, each with where it works: the repository and lane (null for the main checkout) whose
 * folder holds its own, or, in no repository LaneKit reads, `where`, the repository or folder it is in.
 */
export const agentsIn = (repos, options) => {
    const places = repos.filter((repo) => !repo.error).flatMap((repo) => [
        { repo: repo.id, lane: null, path: repo.main?.path ?? repo.path },
        ...repo.lanes.filter((lane) => lane.exists).map((lane) => ({ repo: repo.id, lane: lane.name, path: lane.path }))
    ]).sort((a, b) => b.path.length - a.path.length)
    return readReports(options).map((report) => {
        const place = places.find((candidate) => isUnder(report.cwd, candidate.path))
        return place ? { repo: place.repo, lane: place.lane, ...report } : { repo: null, lane: null, where: placeOf(report.cwd), ...report }
    })
}

// ---------------------------------------------------------------------------
// Claude Code: a hook on each event, in the background
// ---------------------------------------------------------------------------

/** The hook events that move a Claude Code session from one state to another. SessionEnd's runs in the foreground,
    since Claude Code may be gone before a background one starts; it only removes a file. */
export const CLAUDE_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest',
    'PermissionDenied', 'Notification', 'Elicitation', 'ElicitationResult', 'Stop', 'StopFailure', 'CwdChanged', 'SessionEnd']
// LaneKit's own hooks, whichever lanekit they name: what is replaced when lanekit moves, and nothing else.
const OURS = /lane(\.mjs'?"?)? report claude/
const quoted = (text) => `'${String(text).replaceAll("'", "'\\''")}'`
/** The hooks, for Claude Code's settings: lanekit by its path on this machine. `|| true`: a reporter that fails
    never stops Claude Code. */
export const claudeHooks = (kit) => {
    const command = `node ${quoted(path.join(kit, 'dev', 'lane.mjs'))} report claude || true`
    return Object.fromEntries(CLAUDE_EVENTS.map((event) => [event,
        { type: 'command', command, ...(event === 'SessionEnd' ? { timeout: 5 } : { async: true }) }]))
}

/**
 * Settings with LaneKit's hooks in them, beside whatever hooks are there: added where missing, and a hook of
 * LaneKit's naming another lanekit (one moved, or a copy elsewhere) made to name this one. Nothing else changes.
 */
export const withClaudeHooks = (settings, kit) => {
    const hooks = { ...(settings?.hooks ?? {}) }
    let added = 0
    let updated = 0
    for (const [event, want] of Object.entries(claudeHooks(kit))) {
        const groups = Array.isArray(hooks[event]) ? hooks[event] : []
        const at = groups.findIndex((group) => (group?.hooks ?? []).some((hook) => OURS.test(String(hook?.command ?? ''))))
        if (at < 0) { hooks[event] = [...groups, { hooks: [want] }]; added++; continue }
        const group = groups[at]
        const inner = group.hooks.map((hook) => (OURS.test(String(hook?.command ?? '')) ? want : hook))
        if (JSON.stringify(inner) === JSON.stringify(group.hooks)) continue
        hooks[event] = groups.map((other, i) => (i === at ? { ...group, hooks: inner } : other))
        updated++
    }
    return { settings: { ...settings, hooks }, added, updated }
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
export const reportClaude = (text, { now = Date.now(), chain = ancestry(process.pid), dir = agentsDir(), host = os.hostname(), env = process.env } = {}) => {
    let input
    try { input = JSON.parse(text) } catch { return null }
    if (!SESSION.test(String(input?.session_id))) return null
    const key = `claude-${input.session_id}`
    if (input.hook_event_name === 'SessionEnd') { removeReport(dir, key); return 'removed' }
    const agent = chain.slice(1).find((entry) => !SHELL.test(entry.name))
    const pids = agent ? chain.slice(chain.indexOf(agent)).map((entry) => entry.pid) : []
    const next = claudeStep(readReport(dir, key), input, { now, pid: agent?.pid ?? null, pids })
    if (!next) return null
    if (input.hook_event_name === 'SessionStart') prune(dir, host, now)
    next.host = host
    next.tmux = tmuxOf(env)
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

const PLUGIN_MARK = "// LaneKit's report of what this OpenCode is doing"
/** A plugin's text: it finds lanekit (this one first) and hands over to what `body` names. */
const pluginText = (kit, why, body) => `${PLUGIN_MARK} (thinking, running a tool, waiting on you, done) and in
// which lane, for LaneKit's page and the editor. Written by LaneKit, which keeps it up to date: the work is lanekit's
// own (lib/agents.mjs). With no lanekit on the machine, it does nothing.
${why}
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const lanekit = async () => {
    const home = os.homedir()
    const kit = [${JSON.stringify(kit)}, process.env.LANEKIT, '/opt/lanekit', path.join(home, '.lanekit')]
        .find((dir) => dir && fs.existsSync(path.join(dir, 'lib', 'agents.mjs')))
    return kit ? await import(pathToFileURL(path.join(kit, 'lib', 'agents.mjs')).href) : {}
}

${body}
`
/** The plugin, for OpenCode's own plugins folder. OpenCode 1 runs its server(); OpenCode 2 loads the same file in
    its background service, which no one terminal's OpenCode is, so there it does nothing: opencodeTuiPlugin reports. */
export const opencodePlugin = (kit) => pluginText(kit, `// OpenCode 1 runs server(). OpenCode 2 runs setup(), in the background service every terminal shares, where it
// does nothing: lanekit/tui.js, beside this file, reports from each terminal's OpenCode instead.`, `export default {
    id: 'lanekit',
    server: async (input) => {
        try {
            const { opencodeReporter } = await lanekit()
            return opencodeReporter ? await opencodeReporter(input) : {}
        } catch {
            return {}
        }
    },
    setup: () => {}
}`)
/** OpenCode 2's TUI plugin, for a folder of its own in the plugins folder: it runs in each terminal's OpenCode. */
export const opencodeTuiPlugin = (kit) => pluginText(kit, `// OpenCode 2 runs it in each terminal's OpenCode, which is where its process, its terminal and its tmux pane are.`, `export default {
    id: 'lanekit-tui',
    setup: async (context) => {
        try {
            const { opencodeTui } = await lanekit()
            return opencodeTui ? await opencodeTui(context) : undefined
        } catch {
            return undefined
        }
    }
}`)

const short = (value) => (typeof value === 'string' && value ? value.slice(0, 40) : null)

/**
 * OpenCode's hooks, reporting this OpenCode: one report for the process, whichever of its sessions is
 * at work, since a session hands work to sessions of its own. It is waiting on you while any of them
 * asks a permission or a question, running while a tool runs, thinking while any is busy, and done
 * (or failed) when all are idle. Written only when that changes: OpenCode says something many times
 * a second while it writes. OpenCode 1's events and OpenCode 2's alike: 2 puts what 1 called properties
 * in data, says a session's work starts and ends where 1 said busy and idle, asks questions as forms,
 * and says a tool runs in its events, where 1 called tool.execute.before and after.
 */
export const opencodeReporter = async ({ directory, worktree } = {}, { now = () => Date.now(), pid = process.pid, chain = ancestry(pid), dir = agentsDir(), host = os.hostname(), env = process.env } = {}) => {
    const cwd = directory || worktree || process.cwd()
    const key = `opencode-${pid}`
    const busy = new Set()
    const asking = new Map()   // request id -> { session, tool }
    const tools = new Map()    // call id -> { session, tool }
    const named = new Map()    // call id -> tool, as OpenCode 2 names it before calling it
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
            writeReport(dir, { key, agent: 'opencode', host, session, cwd, state, tool, at: now(), since, pid, pids: chain.map((entry) => entry.pid), tmux: tmuxOf(env) })
        } catch {}
    }
    const settle = (id) => {
        busy.delete(id)
        for (const [call, running] of tools) if (running.session === id) tools.delete(call)
        for (const [request, asked] of asking) if (asked.session === id) asking.delete(request)
        if (!busy.size) ended = 'done'
    }
    prune(dir, host, now())
    say()
    process.once('exit', () => removeReport(dir, key))
    return {
        event: async ({ event } = {}) => {
            const p = event?.properties ?? event?.data ?? {}
            const id = typeof p.sessionID === 'string' ? p.sessionID : null
            const start = () => { busy.add(id); failed = false; session = id ?? session }
            switch (event?.type) {
                case 'session.status':
                    if (p.status?.type === 'busy' || p.status?.type === 'retry') start(); else if (p.status?.type === 'idle') settle(id)
                    break
                case 'session.execution.started': start(); break
                case 'session.idle': case 'session.execution.succeeded': case 'session.execution.interrupted': settle(id); break
                case 'session.error':
                    settle(id)
                    if (p.error?.name !== 'MessageAbortedError') failed = true
                    break
                case 'session.execution.failed': settle(id); failed = true; break
                case 'session.deleted': settle(p.info?.id ?? id); break
                case 'permission.asked': case 'permission.v2.asked': case 'permission.updated':
                    asking.set(p.id ?? p.requestID, { session: id, tool: short(p.permission) ?? short(p.action) ?? short(p.type) })
                    break
                case 'question.asked': case 'question.v2.asked':
                    asking.set(p.id ?? p.requestID, { session: id, tool: 'question' })
                    break
                case 'form.created':
                    asking.set(p.form?.id, { session: p.form?.sessionID ?? null, tool: 'question' })
                    break
                case 'permission.replied': case 'permission.v2.replied':
                case 'question.replied': case 'question.rejected': case 'question.v2.replied': case 'question.v2.rejected':
                case 'form.replied': case 'form.cancelled':
                    asking.delete(p.requestID ?? p.permissionID ?? p.id)
                    break
                case 'session.tool.input.started': named.set(p.id, short(p.name)); return
                case 'session.tool.called': tools.set(p.id, { session: id, tool: named.get(p.id) ?? null }); break
                case 'session.tool.success': case 'session.tool.failed': tools.delete(p.id); named.delete(p.id); break
                default: return
            }
            say()
        },
        'tool.execute.before': async (input) => { tools.set(input?.callID, { session: input?.sessionID ?? null, tool: short(input?.tool) }); say() },
        'tool.execute.after': async (input) => { tools.delete(input?.callID); say() }
    }
}

/**
 * OpenCode 2's TUI plugin, reporting this terminal's OpenCode: what it hears, handed to opencodeReporter.
 * A terminal hears every session of the background service it shares with other terminals, so only its
 * own count: those it has shown (its route, its tabs) and theirs, a subagent's root being one of them. A
 * session it shows already at work is taken as started. Its cleanup, on leaving, removes its report.
 */
export const opencodeTui = async (context, options = {}) => {
    const { pid = process.pid, dir = agentsDir() } = options
    const hooks = await opencodeReporter({ directory: context?.location?.directory }, options)
    const data = context?.data
    const shown = new Set()
    const rootOf = (id) => { try { return data?.session?.root?.(id) || id } catch { return id } }
    const look = () => {
        const route = context?.ui?.router?.current?.()
        const tabs = (() => { try { return context?.ui?.tabs?.list?.() ?? [] } catch { return [] } })()
        for (const id of [route?.type === 'session' ? route.sessionID : null, ...tabs.map((tab) => tab?.sessionID)]) {
            if (typeof id !== 'string' || shown.has(id)) continue
            shown.add(id)
            if (data?.session?.status?.(id) === 'running') hooks.event({ event: { type: 'session.execution.started', data: { sessionID: id } } })
        }
    }
    const off = data?.listen?.(({ details } = {}) => {
        try {
            look()
            const p = details?.data ?? {}
            if (details?.type === 'session.created' && typeof p.parentID === 'string' && shown.has(rootOf(p.parentID))) shown.add(p.sessionID)
            const id = p.sessionID ?? p.form?.sessionID
            if (typeof id === 'string' && !shown.has(id) && !shown.has(rootOf(id))) return
            hooks.event({ event: details })
        } catch {}
    })
    look()
    return () => {
        off?.()
        removeReport(dir, `opencode-${pid}`)
    }
}

// ---------------------------------------------------------------------------
// the reporters, once a machine: the person's own Claude Code settings and OpenCode plugins
// ---------------------------------------------------------------------------

/** Where this machine's person keeps them, as Claude Code and OpenCode look: OpenCode 2 takes a TUI plugin from a
    folder of its own in the plugins folder, and OpenCode 1 looks in no folder there. */
export const reporterFiles = ({ home = os.homedir(), env = process.env } = {}) => {
    const plugins = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode', 'plugins')
    return {
        claude: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'),
        opencode: path.join(plugins, 'lanekit.js'),
        opencodeTui: path.join(plugins, 'lanekit', 'tui.js')
    }
}
/** LaneKit's plugins, each as reporterFiles names it, with what it should say. */
const PLUGINS = { opencode: opencodePlugin, opencodeTui: opencodeTuiPlugin }

/** Written whole or not at all: a person's settings are never left half-written. */
const writeWhole = (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const temp = `${file}.lanekit-${process.pid}.tmp`
    fs.writeFileSync(temp, text)
    fs.renameSync(temp, file)
}

/**
 * What each reporter needs on this machine, without changing anything: `current`, `missing` (or LaneKit's,
 * naming another lanekit), or `foreign` (a file there that is not LaneKit's, or settings that are not JSON),
 * which is left alone.
 */
export const reportersOn = (kit, places) => {
    const files = reporterFiles(places)
    const claude = (() => {
        if (!fs.existsSync(files.claude)) return { file: files.claude, state: 'missing' }
        let settings
        try { settings = JSON.parse(fs.readFileSync(files.claude, 'utf8')) } catch (error) {
            return { file: files.claude, state: 'foreign', why: `${files.claude} is not valid JSON (${error.message})` }
        }
        const { added, updated } = withClaudeHooks(settings, kit)
        return { file: files.claude, state: added || updated ? 'missing' : 'current', settings }
    })()
    const plugin = (name) => {
        const file = files[name]
        if (!fs.existsSync(file)) return { file, state: 'missing' }
        const text = fs.readFileSync(file, 'utf8')
        if (!text.startsWith(PLUGIN_MARK)) return { file, state: 'foreign', why: `${file} is there and is not LaneKit's` }
        return { file, state: text === PLUGINS[name](kit) ? 'current' : 'missing' }
    }
    return { claude, ...Object.fromEntries(Object.keys(PLUGINS).map((name) => [name, plugin(name)])) }
}

/**
 * The reporters for this machine's person: LaneKit's hooks added to their Claude Code settings beside any
 * there, and the plugins written to their OpenCode plugins. LaneKit's own are brought up to date where they
 * name another lanekit; nothing that is not LaneKit's is replaced. Says what it did.
 */
export const installForUser = (kit, { check = false, ...places } = {}) => {
    const said = { wrote: [], kept: [], warnings: [] }
    const now = reportersOn(kit, places)
    if (now.claude.state === 'foreign') said.warnings.push(`${now.claude.why}: LaneKit's hooks were not added`)
    else if (now.claude.state === 'current') said.kept.push(now.claude.file)
    else {
        const { settings } = withClaudeHooks(now.claude.settings ?? {}, kit)
        if (!check) writeWhole(now.claude.file, JSON.stringify(settings, null, 2) + '\n')
        said.wrote.push(`${now.claude.file} (LaneKit's hooks)`)
    }
    for (const [name, text] of Object.entries(PLUGINS)) {
        if (now[name].state === 'foreign') said.warnings.push(`${now[name].why}: LaneKit's plugin was not written`)
        else if (now[name].state === 'current') said.kept.push(now[name].file)
        else {
            if (!check) writeWhole(now[name].file, text(kit))
            said.wrote.push(now[name].file)
        }
    }
    return said
}
