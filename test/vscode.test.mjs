/**
 * The Lanes extension (vscode/host.mjs), asked what it promises the editor, with a stand-in
 * for VS Code's API: the page in a tab with nothing allowed but its own files, the page's
 * questions answered, a commit's and a lane's changes opened as diffs of the right files at
 * the right commits, a refusal for anything the page did not show, the status bar naming
 * the lane in front, and the .vsix holding what the extension needs and nothing it does not.
 *
 *     node --test
 *
 * Needs git and node, and unzip for the .vsix; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

import { agentsDir } from '../lib/agents.mjs'
import { activate, colourOf, pageHtml, SCHEME, wordOf } from '../vscode/host.mjs'
import { build } from '../vscode/pack.mjs'

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

/** Just enough of VS Code's API for host.mjs, recording what it was asked to do. */
const standIn = (folders) => {
    const disposable = { dispose () {} }
    const event = () => () => disposable
    // The terminal events, which a test fires as the editor would.
    const listeners = new Map()
    const heard = (name) => (listener) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return disposable }
    const emit = (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(payload) }
    class Uri {
        constructor (parts) { Object.assign(this, { query: '', ...parts }); this.fsPath = this.path }
        static file (file) { return new Uri({ scheme: 'file', path: file }) }
        static from (parts) { return new Uri(parts) }
        toString () { return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}` }
    }
    const config = {}
    const answers = {}   // what the stand-in person picks and types, when a test says
    const seen = { picks: [], commands: new Map(), executed: [], posted: [], sidePosted: [], said: [], providers: new Map(), terminals: [], made: [], views: new Map() }
    /** A terminal as the editor hands one out: where it was opened, what was typed into it, how it was last shown. */
    let nextPid = 3_900_000   // above any process id a test's own processes are, so no terminal is taken for one
    const terminal = (options, extra = {}) => ({
        name: options.name, creationOptions: options, typed: [], shown: null, processId: Promise.resolve(++nextPid),
        show (preserveFocus = false) { this.shown = { preserveFocus } },
        sendText (text) { this.typed.push(text) },
        ...extra
    })
    let activeTerminal
    const terminals = []
    let receive = null
    let sideReceive = null
    let active = null
    // The status bar's items, by their priority: the lane's (40), and the agents' (39) beside it.
    const bars = new Map()
    const statusItem = () => ({ text: '', tooltip: '', command: null, shown: false, show () { this.shown = true }, hide () { this.shown = false }, dispose () {} })
    const panel = {
        visible: true,
        webview: {
            options: null, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri) => ({ toString: () => `vscode-webview://page${uri.path}` }),
            postMessage: (message) => { seen.posted.push(message); return Promise.resolve(true) },
            onDidReceiveMessage: (listener) => { receive = listener; return disposable }
        },
        reveal () {},
        onDidChangeViewState: event(),
        onDidDispose: event()
    }
    /** Every tab made after the first, each a page of its own: what was posted to it, how often it was brought
        forward, and closing it, as the person would. */
    const panels = []
    const makePanel = () => {
        let heard = null
        const closed = []
        const made = {
            visible: true, title: '', revealed: 0, posted: [],
            webview: {
                options: null, html: '', cspSource: 'vscode-webview:',
                asWebviewUri: (uri) => ({ toString: () => `vscode-webview://page${uri.path}` }),
                postMessage (message) { made.posted.push(message); return Promise.resolve(true) },
                onDidReceiveMessage: (listener) => { heard = listener; return disposable }
            },
            reveal () { this.revealed++ },
            says: (message) => heard(message),
            close: () => { for (const listener of closed) listener() },
            onDidChangeViewState: event(),
            onDidDispose: (listener) => { closed.push(listener); return disposable }
        }
        return made
    }
    // The side bar's view, made by the provider when VS Code first shows it (here: when asked to focus it).
    const sideView = {
        visible: true,
        webview: {
            options: null, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri) => ({ toString: () => `vscode-webview://side${uri.path}` }),
            postMessage: (message) => { seen.sidePosted.push(message); return Promise.resolve(true) },
            onDidReceiveMessage: (listener) => { sideReceive = listener; return disposable }
        },
        onDidChangeVisibility: event(),
        onDidDispose: event()
    }
    let sideMade = false
    class Range { constructor (startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }) } }
    class ThemeColor { constructor (id) { this.id = id } }
    class ThemeIcon { constructor (id) { this.id = id } }
    const vscode = {
        Uri,
        Range,
        ThemeColor,
        ThemeIcon,
        ViewColumn: { Active: -1 },
        StatusBarAlignment: { Left: 1 },
        window: {
            createOutputChannel: () => ({ append () {}, appendLine () {}, show () {}, dispose () {} }),
            // The first tab is `panel`, as every test before there were several expects; each after it is new.
            createWebviewPanel: (view, title) => {
                const made = seen.tabs ? makePanel() : panel
                seen.tabs = (seen.tabs ?? 0) + 1
                made.title = title
                if (made !== panel) panels.push(made)
                return made
            },
            registerWebviewPanelSerializer: (view, serializer) => { seen.serializer = serializer; return disposable },
            createStatusBarItem: (alignment, priority) => { const item = statusItem(); bars.set(priority, item); return item },
            state: { focused: true },
            createTerminal: (options) => {
                seen.terminals.push(options)
                const made = terminal(options)
                seen.made.push(made)
                terminals.push(made)
                return made
            },
            get activeTerminal () { return activeTerminal },
            terminals,
            onDidStartTerminalShellExecution: heard('start'),
            onDidEndTerminalShellExecution: heard('end'),
            onDidChangeTerminalShellIntegration: heard('integration'),
            onDidChangeActiveTerminal: heard('active'),
            onDidCloseTerminal: heard('close'),
            registerWebviewViewProvider: (id, provider, options) => { seen.views.set(id, { provider, options }); return disposable },
            showInformationMessage: (...args) => { seen.said.push(args[0]); return Promise.resolve(answers.choose?.(args[0], args.slice(1))) },
            showErrorMessage: (...args) => { seen.said.push(args[0]); return Promise.resolve(undefined) },
            showWarningMessage: () => Promise.resolve(undefined),
            showQuickPick: (items) => { seen.picks.push(items); return Promise.resolve(answers.pick ? items.find((item) => item.label.includes(answers.pick)) : undefined) },
            showInputBox: () => Promise.resolve(answers.input),
            onDidChangeWindowState: event(),
            onDidChangeActiveTextEditor: event(),
            get activeTextEditor () { return active }
        },
        workspace: {
            workspaceFolders: folders.map((folder) => ({ uri: Uri.file(folder) })),
            getConfiguration: () => ({ get: (key) => config[key] }),
            onDidSaveTextDocument: event(),
            onDidChangeWorkspaceFolders: event(),
            onDidChangeConfiguration: event(),
            registerTextDocumentContentProvider: (scheme, provider) => { seen.providers.set(scheme, provider); return disposable }
        },
        commands: {
            registerCommand: (id, run) => { seen.commands.set(id, run); return disposable },
            executeCommand: async (...args) => {
                seen.executed.push(args)
                const view = /^(.*)\.focus$/.exec(args[0])
                if (view && seen.views.has(view[1]) && !sideMade) { sideMade = true; seen.views.get(view[1]).provider.resolveWebviewView(sideView) }
            }
        }
    }
    let sequence = 0
    /** What the page would ask, and the reply the extension posts back to it. */
    const ask = async (method, params) => {
        const id = `t${++sequence}`
        await receive({ type: 'request', id, method, params })
        for (let i = 0; i < 400; i++) {
            const reply = seen.posted.find((message) => message.type === 'reply' && message.id === id)
            if (reply) return reply
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error(`no reply to ${method}`)
    }
    /** What the side bar's page would ask, and the reply posted back to it alone. */
    const askSide = async (method, params) => {
        const id = `s${++sequence}`
        await sideReceive({ type: 'request', id, method, params })
        for (let i = 0; i < 400; i++) {
            const reply = seen.sidePosted.find((message) => message.type === 'reply' && message.id === id)
            if (reply) return reply
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        throw new Error(`no reply to ${method} in the side bar`)
    }
    const sideSays = (message) => sideReceive(message)
    const tabSays = (message) => receive(message)
    /** A terminal the person opened themselves, in `cwd`; `shell` gives it shell integration, which says where it is now. */
    const openTerminal = (cwd, { shell = null, name = 'zsh' } = {}) => {
        const commands = []
        const made = terminal({ name, cwd }, shell ? {
            shellIntegration: { cwd: Uri.file(shell), executeCommand: async (...args) => { commands.push(args) } }
        } : {})
        made.commands = commands
        terminals.push(made)
        return made
    }
    const useTerminal = (made) => { activeTerminal = made; if (made) emit('active', made) }
    const closeTerminal = (made) => { terminals.splice(terminals.indexOf(made), 1); if (activeTerminal === made) activeTerminal = undefined; emit('close', made) }
    return {
        vscode, seen, panel, panels, makePanel, sideView, ask, askSide, sideSays, tabSays, config, answers, emit, openTerminal, useTerminal, closeTerminal,
        get bar () { return bars.get(40) },
        get agentBar () { return bars.get(39) },
        setActive: (file) => { active = file ? { document: { uri: Uri.file(file) } } : null }
    }
}

let scratch
let work
let repo
let working
let first
let editor
let host
let READ_AGENTS
let FAKE_TMUX

before(async () => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-vscode-')))
    work = path.join(scratch, 'work')
    repo = path.join(work, 'demo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: {
            portBase: 19701, portCeiling: 19799, copyOnCreate: ['.env'], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, '.env'), 'PORT=19700\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    first = git(repo, 'rev-parse', 'HEAD').trim()
    lane(repo, 'new', 'working')
    working = path.join(work, 'demo-working')
    fs.writeFileSync(path.join(working, 'feature.txt'), 'feature\n')
    git(working, 'add', '-A')
    git(working, 'commit', '-qm', 'Add the feature')
    fs.writeFileSync(path.join(working, 'app.txt'), 'one\ntwo\n')

    // The editor opened on the lane itself: its repository is still found.
    // Reports the editor below reads, in its scratch home; and anything written by a default, in scratch too.
    process.env.XDG_STATE_HOME = path.join(scratch, 'state')
    READ_AGENTS = agentsDir({ home: path.join(scratch, 'home-never'), env: {} })
    editor = standIn([working])
    // Never asked here whether to add the agents' reporters: the test of that asks in a home of its own.
    editor.config.reportAgents = 'never'
    // A stand-in for tmux, which says how it was asked and answers as FAKE_TMUX_* say; agents start in it only in its test.
    FAKE_TMUX = path.join(scratch, 'bin', 'tmux')
    fs.mkdirSync(path.dirname(FAKE_TMUX), { recursive: true })
    fs.writeFileSync(FAKE_TMUX, [
        '#!/bin/sh',
        'printf "%s\\n" "$*" >> "$FAKE_TMUX_LOG"',
        'case "$1" in',
        '  -V) echo "tmux 3.4"; exit 0 ;;',
        '  has-session) [ "$3" = "=$FAKE_TMUX_TAKEN" ] && exit 0; exit 1 ;;',
        '  -S) case "$3" in',
        '        display-message) [ -n "$FAKE_TMUX_SESSION" ] || exit 1; echo "$FAKE_TMUX_SESSION" ;;',
        '        list-clients) [ -n "$FAKE_TMUX_CLIENTS" ] && echo "$FAKE_TMUX_CLIENTS" ;;',
        '      esac; exit 0 ;;',
        'esac',
        'exit 1', ''].join('\n'), { mode: 0o755 })
    process.env.FAKE_TMUX_LOG = path.join(scratch, 'tmux.log')
    editor.config.agentsInTmux = false
    const remembered = new Map()
    const workspaceState = { get: (key) => remembered.get(key), update: async (key, value) => { remembered.set(key, value) } }
    host = await activate({ subscriptions: [], workspaceState }, editor.vscode, { root: KIT, home: path.join(scratch, 'home-never'), env: {}, tmux: FAKE_TMUX })
})

after(() => {
    host?.dispose()
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('every command the manifest offers is one the extension answers', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(KIT, 'vscode', 'package.json'), 'utf8'))
    const offered = manifest.contributes.commands.map((command) => command.command).sort()
    assert.deepEqual([...editor.seen.commands.keys()].sort(), offered)
})

test('the page opens in a tab that allows its own files and nothing else', async () => {
    await editor.seen.commands.get('lanekit.show')()
    const html = editor.panel.webview.html
    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1]
    assert.ok(nonce, 'a nonce for its one script')
    assert.match(html, /default-src 'none'/)
    assert.ok(html.includes(`<script nonce="${nonce}" src="vscode-webview://page${path.join(KIT, 'web', 'lanes.js')}" defer>`))
    assert.ok(html.includes(`href="vscode-webview://page${path.join(KIT, 'web', 'lanes.css')}"`))
    assert.doesNotMatch(html, /src="lanes\.js"|href="lanes\.css"/, 'no address left for the browser page')
    assert.deepEqual(editor.panel.webview.options.localResourceRoots.map((uri) => uri.path), [path.join(KIT, 'web')])
})

test('pageHtml refuses an index.html that no longer names its files', () => {
    const odd = path.join(scratch, 'odd-web')
    fs.mkdirSync(odd, { recursive: true })
    fs.writeFileSync(path.join(odd, 'index.html'), '<html></html>')
    assert.throws(() => pageHtml(odd, editor.panel.webview, (file) => editor.vscode.Uri.file(file)), /no longer names/)
})

test('the page is answered what lanes there are', async () => {
    const reply = await editor.ask('state')
    assert.equal(reply.ok, true)
    assert.deepEqual(reply.value.repos.map((r) => r.id), ['demo'])
    assert.equal(reply.value.repos[0].lanes[0].name, 'working')
})

test('a commit opens as the diffs of what it changed, read at that commit', async () => {
    const head = git(working, 'rev-parse', 'HEAD').trim()
    editor.seen.executed.length = 0
    const reply = await editor.ask('open', { what: 'commit', repo, sha: head })
    assert.equal(reply.ok, true, reply.error)
    const [command, title, rows] = editor.seen.executed.at(-1)
    assert.equal(command, 'vscode.changes')
    assert.match(title, /Add the feature/)
    assert.equal(rows.length, 1)
    const [, before, after] = rows[0]
    assert.equal(before, undefined, 'an added file has nothing before it')
    assert.equal(after.scheme, SCHEME)
    const content = await editor.seen.providers.get(SCHEME).provideTextDocumentContent(after)
    assert.equal(content, 'feature\n')
})

test('a lane\'s changes open against where it forked, its files as they are now', async () => {
    editor.seen.executed.length = 0
    const reply = await editor.ask('open', { what: 'changes', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    const [command, , rows] = editor.seen.executed.at(-1)
    assert.equal(command, 'vscode.changes')
    const byFile = Object.fromEntries(rows.map(([label, before, after]) => [path.basename(label.path), { before, after }]))
    assert.deepEqual(Object.keys(byFile).sort(), ['app.txt', 'feature.txt'])
    assert.equal(byFile['app.txt'].after.scheme, 'file', 'the right side is the file itself, editable')
    assert.equal(byFile['app.txt'].after.path, path.join(working, 'app.txt'))
    assert.equal(new URLSearchParams(byFile['app.txt'].before.query).get('sha'), first)
    assert.equal(await editor.seen.providers.get(SCHEME).provideTextDocumentContent(byFile['app.txt'].before), 'one\n')
})

test('conflicts are opened only where git says there are some', async () => {
    const reply = await editor.ask('open', { what: 'conflicts', repo, lane: 'working' })
    assert.equal(reply.ok, false)
    assert.match(reply.error, /no conflicts left/)
})

test('a lane\'s terminal (the page\'s terminal icon, once Goto): with none open, one opens there, and takes the focus', async () => {
    const reply = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    assert.equal(reply.value.terminal, 'opened')
    assert.equal(editor.seen.terminals.at(-1).cwd, working)
    assert.deepEqual(editor.seen.made.at(-1).shown, { preserveFocus: false })
    const gone = await editor.ask('open', { what: 'terminal', repo, lane: 'working' })
    assert.equal(gone.ok, false, 'one way to a lane\'s terminal, asked for as goto; terminal by itself is refused')
})

test('anything the page did not show is refused, and said', async () => {
    const elsewhere = await editor.ask('open', { what: 'commit', repo: scratch, sha: first })
    assert.equal(elsewhere.ok, false)
    assert.match(elsewhere.error, /not one the page showed/)
    const ghost = await editor.ask('open', { what: 'changes', repo, lane: 'ghost' })
    assert.equal(ghost.ok, false)
    const odd = await editor.ask('open', { what: 'rm', repo })
    assert.equal(odd.ok, false)
    const method = await editor.ask('delete', {})
    assert.equal(method.ok, false)
    const provider = editor.seen.providers.get(SCHEME)
    const sneaky = editor.vscode.Uri.from({ scheme: SCHEME, path: '/etc/passwd', query: new URLSearchParams({ repo, sha: first, rel: '../../etc/passwd' }).toString() })
    assert.equal(await provider.provideTextDocumentContent(sneaky), '')
})

test('the status bar names the lane the file in front is in, and what it needs', async () => {
    editor.setActive(path.join(working, 'feature.txt'))
    await editor.ask('state')
    assert.equal(editor.bar.shown, true)
    assert.match(editor.bar.text, /working/)
    assert.deepEqual(editor.bar.command.arguments, [{ repo: 'demo', lane: 'working' }])
    assert.equal(editor.bar.command.command, 'lanekit.laneMenu', 'the status bar opens the lane\'s menu')
    // The Lanes tab in front, or a diff: no file editor, so the bar keeps the lane it was naming.
    editor.setActive(null)
    await editor.ask('state')
    assert.match(editor.bar.text, /working/, 'with no file in front, the last lane stays named')
    editor.setActive(path.join(repo, 'app.txt'))
    await editor.ask('state')
    assert.match(editor.bar.text, /1 lane/)
    editor.setActive(path.join(scratch, 'elsewhere.txt'))
    editor.vscode.workspace.workspaceFolders = []
    await editor.ask('state')
    assert.equal(editor.bar.shown, false)
    editor.vscode.workspace.workspaceFolders = [{ uri: editor.vscode.Uri.file(working) }]
})

test('a press from the page runs, and the page is told of its output and its end', async () => {
    const reply = await editor.ask('press', { repo: 'demo', verb: 'gate', lane: 'working' })
    assert.equal(reply.ok, true)
    assert.equal(reply.value.status, 202)
    const id = reply.value.body.id
    for (let i = 0; i < 500 && host.service.job(id)?.state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(host.service.job(id).state, 'done')
    assert.ok(editor.seen.posted.some((message) => message.type === 'job' && message.id === id))
    const job = await editor.ask('job', { id, from: 0 })
    assert.match(job.value.output, /gate\.mjs/)
})

test('the side bar has a view of its own, which keeps its page while hidden', () => {
    const view = editor.seen.views.get('lanekit.sidebar')
    assert.ok(view, 'a provider for lanekit.sidebar')
    assert.equal(view.options.webviewOptions.retainContextWhenHidden, true)
    const manifest = JSON.parse(fs.readFileSync(path.join(KIT, 'vscode', 'package.json'), 'utf8'))
    const container = manifest.contributes.viewsContainers.activitybar[0]
    assert.deepEqual(manifest.contributes.views[container.id].map((v) => [v.type, v.id]), [['webview', 'lanekit.sidebar']])
    assert.ok(fs.existsSync(path.join(KIT, 'vscode', container.icon)), 'the icon the manifest names is there')
})

test('the LaneKit icon opens the page in a tab and closes the side bar, which holds only a link to it', async () => {
    const view = editor.seen.views.get('lanekit.sidebar')
    const listeners = []
    const icon = {
        visible: true,
        webview: {
            options: null, html: '', cspSource: 'vscode-webview:',
            asWebviewUri: (uri) => ({ toString: () => `vscode-webview://icon${uri.path}` }),
            postMessage: () => Promise.resolve(true),
            onDidReceiveMessage: () => ({ dispose () {} })
        },
        onDidChangeVisibility: (listener) => { listeners.push(listener); return { dispose () {} } },
        onDidDispose: () => ({ dispose () {} })
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    editor.seen.executed.length = 0
    view.provider.resolveWebviewView(icon)
    await settle()
    assert.ok(editor.seen.executed.some((args) => args[0] === 'workbench.action.closeSidebar'), 'the side bar closes again')
    assert.match(editor.panel.webview.html, /<html data-surface="tab"/, 'the page is in the tab')
    assert.match(icon.webview.html, /href="command:lanekit.show"/, 'the side bar holds a link to the tab')
    assert.doesNotMatch(icon.webview.html, /<script/, 'and runs nothing')
    assert.deepEqual(icon.webview.options, { enableScripts: false, enableCommandUris: ['lanekit.show'] })
    // Pressed again, after something else had the side bar: the tab again (VS Code saying it twice at once is one press).
    await new Promise((resolve) => setTimeout(resolve, 450))
    editor.seen.executed.length = 0
    for (const listener of listeners) listener()
    await settle()
    assert.ok(editor.seen.executed.some((args) => args[0] === 'workbench.action.closeSidebar'))
    // The status bar's Show in LaneKit goes to the tab too, with the lane marked there.
    editor.seen.executed.length = 0
    const posted = editor.seen.posted.length
    await editor.seen.commands.get('lanekit.reveal')({ repo: 'demo', lane: 'working' })
    assert.ok(!editor.seen.executed.some((args) => args[0] === 'lanekit.sidebar.focus'), 'not the side bar')
    assert.deepEqual(editor.seen.posted.slice(posted).filter((m) => m.type === 'focus'), [{ type: 'focus', repo: 'demo', lane: 'working' }])
})

test('with opensIn sideBar, the status bar reveals the side bar, and its page marks the lane once it is ready', async () => {
    editor.config.opensIn = 'sideBar'
    await editor.seen.commands.get('lanekit.reveal')({ repo: 'demo', lane: 'working' })
    assert.ok(editor.seen.executed.some((args) => args[0] === 'lanekit.sidebar.focus'))
    assert.match(editor.sideView.webview.html, /<html data-surface="sidebar"/)
    assert.match(editor.sideView.webview.html, /script-src 'nonce-/)
    assert.equal(editor.seen.sidePosted.filter((m) => m.type === 'focus').length, 0, 'not before the page listens')
    await editor.sideSays({ type: 'ready' })
    assert.deepEqual(editor.seen.sidePosted.filter((m) => m.type === 'focus'), [{ type: 'focus', repo: 'demo', lane: 'working' }])
    const first = editor.seen.sidePosted.find((m) => m.type === 'state')
    assert.ok(first, 'a page just made is sent what was last read, without waiting for a read')
    assert.deepEqual(first.state.repos.map((r) => r.id), ['demo'])
})

test('each page is answered alone, though both hear what changed', async () => {
    const before = editor.seen.posted.length
    const reply = await editor.askSide('state')
    assert.equal(reply.ok, true)
    assert.equal(editor.seen.posted.slice(before).filter((m) => m.type === 'reply' && m.id === reply.id).length, 0, 'the tab is not sent the side bar\'s reply')
    const tabReply = await editor.ask('state')
    assert.equal(editor.seen.sidePosted.filter((m) => m.type === 'reply' && m.id === tabReply.id).length, 0, 'nor the side bar the tab\'s')
    fs.writeFileSync(path.join(working, 'more.txt'), 'more\n')
    for (let i = 0; i < 300 && !(editor.seen.posted.some((m) => m.type === 'state' && m.state.repos[0].lanes[0].dirty === 2) && editor.seen.sidePosted.some((m) => m.type === 'state' && m.state.repos[0].lanes[0].dirty === 2)); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.ok(editor.seen.sidePosted.some((m) => m.type === 'state' && m.state.repos[0].lanes[0].dirty === 2), 'the side bar is told')
    assert.ok(editor.seen.posted.some((m) => m.type === 'state' && m.state.repos[0].lanes[0].dirty === 2), 'and the tab')
    fs.rmSync(path.join(working, 'more.txt'))
})

test('the page asks for main\'s line further back, and every page is told what is read', async () => {
    const refused = await editor.ask('history', { repo: 'demo', way: 'older' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /no commits older/)
    const before = editor.seen.sidePosted.length
    const reply = await editor.ask('history', { repo: 'demo', way: 'newest' })
    assert.equal(reply.ok, true, reply.error)
    assert.equal(reply.value.repos[0].spineDeeper, false)
    assert.ok(editor.seen.sidePosted.slice(before).some((m) => m.type === 'state'), 'the side bar is told too')
    assert.equal((await editor.ask('history', { repo: 'ghost', way: 'newest' })).ok, false)
    const fork = await editor.ask('history', { repo: 'demo', way: 'fork', lane: 'ghost' })
    assert.equal(fork.ok, false)
    assert.match(fork.error, /no lane "ghost"/)
})

test('the status bar\'s words follow the page\'s verdicts', () => {
    assert.equal(wordOf({ kind: 'working', queue: { verdict: 'land now' } }), 'ready to land')
    assert.equal(wordOf({ kind: 'fresh', dirty: 0 }), 'nothing committed')
    assert.equal(wordOf({ kind: 'working', operation: 'rebase' }), 'mid-rebase')
})

test('the .vsix holds the loader, the manifest, its icons, a README and the licence, the same bytes every time', () => {
    const one = build()
    const two = build()
    assert.equal(one.sha256, two.sha256)
    const file = path.join(scratch, 'lanes.vsix')
    fs.writeFileSync(file, one.bytes)
    const listed = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n').sort()
    assert.deepEqual(listed, ['[Content_Types].xml', 'extension.vsixmanifest', 'extension/LICENSE.txt', 'extension/README.md', 'extension/extension.js', 'extension/lanekit.png', 'extension/lanekit.svg', 'extension/package.json'])
    const png = execFileSync('unzip', ['-p', file, 'extension/lanekit.png'])
    assert.equal(png.subarray(1, 4).toString(), 'PNG', 'the Extensions list icon is a PNG')
    assert.equal(png.readUInt32BE(16), 128, 'and 128 pixels wide')
    assert.match(execFileSync('unzip', ['-p', file, 'extension/LICENSE.txt'], { encoding: 'utf8' }), /Apache License\s+Version 2\.0/)
    execFileSync('unzip', ['-tq', file])
    const manifest = JSON.parse(execFileSync('unzip', ['-p', file, 'extension/package.json'], { encoding: 'utf8' }))
    assert.equal(manifest.main, './extension.js')
    assert.equal(manifest.license, 'Apache-2.0')
    assert.equal(manifest.displayName, 'LaneKit')
    assert.equal(manifest.icon, 'lanekit.png')
})

test('the page is answered a commit\'s details, and a cancel of a press that is not waiting is refused', async () => {
    const details = await editor.ask('commit', { repo, sha: first })
    assert.equal(details.ok, true, details.error)
    assert.equal(details.value.subject, 'Begin')
    assert.ok(details.value.files.some((file) => file.path === 'app.txt'))
    const elsewhere = await editor.ask('commit', { repo: '/not/a/repository', sha: first })
    assert.equal(elsewhere.ok, false, 'only a repository LaneKit reads')
    const cancelled = await editor.ask('cancel', { id: 'not-a-job' })
    assert.equal(cancelled.value, false)
})

test('a lane\'s terminal moves the files you have open to the lane, leaves one with unsaved changes, and opens no window', async () => {
    const { vscode } = editor
    class TabInputText { constructor (uri) { this.uri = uri } }
    vscode.TabInputText = TabInputText
    fs.writeFileSync(path.join(repo, 'main-only.txt'), 'only on main\n')
    const tabs = [
        { input: new TabInputText(vscode.Uri.file(path.join(repo, 'app.txt'))), isDirty: false },
        { input: new TabInputText(vscode.Uri.file(path.join(repo, '.gitignore'))), isDirty: true },
        { input: new TabInputText(vscode.Uri.file(path.join(repo, 'main-only.txt'))), isDirty: false }
    ]
    const shown = []
    const closed = []
    const status = []
    vscode.window.tabGroups = { all: [{ tabs, viewColumn: 1, isActive: true }], close: async (tab) => { closed.push(tab) } }
    vscode.window.visibleTextEditors = []
    vscode.workspace.openTextDocument = async (uri) => ({ uri })
    vscode.window.showTextDocument = async (doc, options) => { shown.push([doc.uri.fsPath, options]) }
    vscode.workspace.getWorkspaceFolder = (uri) => ({ uri })
    vscode.window.setStatusBarMessage = (text) => { status.push(text) }
    editor.seen.executed.length = 0
    editor.seen.said.length = 0
    const reply = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    assert.deepEqual(reply.value.moved, ['app.txt'])
    assert.deepEqual(reply.value.kept, ['.gitignore'], 'unsaved changes stay where they are')
    assert.deepEqual(reply.value.missing, ['main-only.txt'], 'a file the lane lacks is left open')
    assert.deepEqual(shown.map(([file]) => file), [path.join(working, 'app.txt')])
    assert.deepEqual(closed, [tabs[0]], 'the old tab closes, the others stay')
    assert.ok(!editor.seen.executed.some(([command]) => command === 'revealInExplorer'), 'the side bar is not opened on the Explorer: it moved the page')
    assert.ok(!editor.seen.executed.some(([command]) => command === 'vscode.openFolder'), 'no window is opened')
    assert.match(status.join(' '), /you are in working now/)
    assert.ok(editor.seen.said.some((line) => /unsaved changes/.test(line)))
    fs.rmSync(path.join(repo, 'main-only.txt'))
})

test('a file a failure names opens at its line, and only inside the lane', async () => {
    editor.seen.executed.length = 0
    const opened = await editor.ask('open', { what: 'file-at', repo, lane: 'working', path: 'feature.txt', line: 3, column: 2 })
    assert.equal(opened.ok, true, opened.error)
    const [command, uri, options] = editor.seen.executed.at(-1)
    assert.equal(command, 'vscode.open')
    assert.equal(uri.path, path.join(working, 'feature.txt'))
    assert.deepEqual([options.selection.startLine, options.selection.startCharacter], [2, 1])
    const outside = await editor.ask('open', { what: 'file-at', repo, lane: 'working', path: '../demo/app.txt', line: 1 })
    assert.equal(outside.ok, false, 'a path climbing out of the lane is not opened')
    const missing = await editor.ask('open', { what: 'file-at', repo, lane: 'working', path: 'nowhere.txt', line: 1 })
    assert.equal(missing.ok, false)
})

test('a press that ends while no page is in sight says how it ended', async () => {
    editor.panel.visible = false
    editor.sideView.visible = false
    editor.seen.said.length = 0
    const reply = await editor.ask('press', { repo: 'demo', verb: 'land', lane: 'working', dryRun: false })
    assert.equal(reply.value.status, 202)
    for (let i = 0; i < 300 && !editor.seen.said.some((line) => /^LaneKit: working/.test(line)); i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.ok(editor.seen.said.some((line) => /^LaneKit: working did not land/.test(line)), editor.seen.said.join(' | '))
    editor.panel.visible = true
    editor.sideView.visible = true
})

test('with gateOnCommit, a commit landing in a lane gates it by itself', async () => {
    editor.config.gateOnCommit = true
    const gatesBefore = () => host.service.state().then((state) => state.jobs.filter((job) => job.verb === 'gate' && job.lane === 'working').length)
    const before = await gatesBefore()
    await editor.seen.commands.get('lanekit.refresh')()
    await new Promise((resolve) => setTimeout(resolve, 600))
    git(working, 'add', '-A')
    git(working, 'commit', '-qm', 'Commit what was uncommitted')
    await editor.seen.commands.get('lanekit.refresh')()
    let after = before
    for (let i = 0; i < 100 && after === before; i++) { await new Promise((resolve) => setTimeout(resolve, 50)); after = await gatesBefore() }
    assert.equal(after, before + 1, 'one gate, pressed by itself')
    editor.config.gateOnCommit = false
})

test('the status bar\'s menu offers what can be done with the lane in front, and does the one picked', async () => {
    editor.seen.picks.length = 0
    editor.answers.pick = 'Terminal'
    for (const made of [...editor.vscode.window.terminals]) editor.closeTerminal(made)
    const terminals = editor.seen.terminals.length
    await editor.seen.commands.get('lanekit.laneMenu')({ repo: 'demo', lane: 'working' })
    const labels = editor.seen.picks.at(-1).map((item) => item.label)
    for (const want of ['Show in LaneKit', 'Terminal', 'Start agent', 'New lane from here', 'Open in a new window']) {
        assert.ok(labels.some((label) => label.includes(want)), `${want} in ${labels.join(', ')}`)
    }
    assert.ok(!labels.some((label) => label.includes('Goto')), 'Terminal, not Goto, as the page says it')
    assert.equal(editor.seen.terminals.length, terminals + 1)
    assert.equal(editor.seen.terminals.at(-1).cwd, working)
    editor.answers.pick = undefined
    await editor.seen.commands.get('lanekit.laneMenu')({ repo: 'demo' })
    const mainLabels = editor.seen.picks.at(-1).map((item) => item.label)
    assert.ok(mainLabels.some((label) => label.includes('New lane…')) && mainLabels.some((label) => label.includes('Fetch now')), mainLabels.join(', '))
})

test('New lane from here starts on top of the lane in front', async () => {
    editor.answers.input = 'stacked'
    await editor.seen.commands.get('lanekit.newLaneHere')({ repo: 'demo', lane: 'working' })
    const job = (await host.service.state()).jobs.find((candidate) => candidate.verb === 'new' && candidate.lane === 'stacked')
    assert.ok(job, 'a new lane pressed')
    assert.match(job.command, /lane\.mjs new stacked --base working/)
    for (let i = 0; i < 300 && host.service.job(job.id)?.state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(host.service.job(job.id).code, 0, host.service.job(job.id).output)
    editor.answers.input = undefined
})

test('the pages are not told where the editor is: work goes on in many places at once, so none is "here"', async () => {
    editor.seen.posted.length = 0
    editor.setActive(path.join(working, 'feature.txt'))
    await editor.ask('state')
    editor.setActive(path.join(repo, 'app.txt'))
    await editor.ask('state')
    assert.ok(!editor.seen.posted.some((m) => m.type === 'here'), JSON.stringify(editor.seen.posted.filter((m) => m.type === 'here')))
    // The status bar still names the lane the file in front is in.
    editor.setActive(path.join(working, 'feature.txt'))
    await editor.ask('state')
})

test('one uncommitted file opens as its own diff', async () => {
    fs.writeFileSync(path.join(working, 'solo.txt'), 'solo\n')
    await editor.ask('state')
    editor.seen.executed.length = 0
    const reply = await editor.ask('open', { what: 'uncommitted', repo, checkout: working, name: 'working', path: 'solo.txt' })
    assert.equal(reply.ok, true, reply.error)
    assert.equal(editor.seen.executed.at(-1)[0], 'vscode.diff')
    fs.rmSync(path.join(working, 'solo.txt'))
})

/** No terminal open, as at the start of a test that counts them. */
const closeAllTerminals = () => { for (const made of [...editor.vscode.window.terminals]) editor.closeTerminal(made) }

test('a lane\'s terminal is a shell waiting at its prompt sent to the same folder in the lane, or to the lane\'s top where it has none', async () => {
    closeAllTerminals()
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true })
    fs.mkdirSync(path.join(working, 'web'), { recursive: true })
    const shell = editor.openTerminal(repo, { shell: path.join(repo, 'web') })
    editor.useTerminal(shell)
    editor.emit('integration', { terminal: shell, shellIntegration: shell.shellIntegration })
    const reply = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    assert.equal(reply.value.terminal, 'moved')
    assert.deepEqual(shell.commands, [['cd', [path.join(working, 'web')]]], 'the same folder, in the lane')
    assert.equal(editor.seen.made.length, editor.seen.terminals.length)
    // A folder the lane does not have: its top.
    shell.commands.length = 0
    fs.mkdirSync(path.join(repo, 'only-main'), { recursive: true })
    shell.shellIntegration.cwd = editor.vscode.Uri.file(path.join(repo, 'only-main'))
    await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.deepEqual(shell.commands, [['cd', [working]]])
    // Already in the lane: nothing typed.
    shell.commands.length = 0
    shell.shellIntegration.cwd = editor.vscode.Uri.file(working)
    const there = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(there.value.terminal, 'here')
    assert.deepEqual(shell.commands, [])
    // And back to main, from the lane.
    const back = await editor.ask('open', { what: 'goto', repo })
    assert.equal(back.value.terminal, 'moved')
    assert.deepEqual(shell.commands, [['cd', [repo]]])
    fs.rmSync(path.join(repo, 'web'), { recursive: true })
    fs.rmSync(path.join(repo, 'only-main'), { recursive: true })
    fs.rmSync(path.join(working, 'web'), { recursive: true })
    closeAllTerminals()
})

test('a lane\'s terminal types nothing into one running something, or one it cannot read, and brings forward the lane\'s instead', async () => {
    closeAllTerminals()
    const busy = editor.openTerminal(repo, { shell: repo })
    editor.useTerminal(busy)
    editor.emit('integration', { terminal: busy, shellIntegration: busy.shellIntegration })
    editor.emit('start', { terminal: busy })   // claude, say, started in it
    const made = editor.seen.terminals.length
    const opened = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(opened.value.terminal, 'opened', 'no terminal in the lane yet: one opens there')
    assert.deepEqual(busy.commands, [], 'nothing typed into the busy terminal')
    assert.equal(editor.seen.terminals.length, made + 1)
    const lanes = editor.seen.made.at(-1)
    assert.equal(lanes.creationOptions.cwd, working)
    assert.equal(lanes.name, 'working')
    assert.equal(lanes.creationOptions.color.id, colourOf('working'), 'in the lane\'s colour')
    assert.equal(lanes.creationOptions.iconPath.id, 'git-branch')
    assert.deepEqual(lanes.shown, { preserveFocus: false }, 'shown, with the focus')
    // Once one is there, it comes forward rather than another.
    editor.useTerminal(busy)
    const shown = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(shown.value.terminal, 'shown')
    assert.equal(editor.seen.terminals.length, made + 1)
    // The one used there last, of two.
    const second = editor.openTerminal(working)
    editor.useTerminal(second)
    editor.useTerminal(busy)
    lanes.shown = null
    await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.deepEqual(second.shown, { preserveFocus: false })
    assert.equal(lanes.shown, null)
    // Its command ended: at its prompt again, so it is moved.
    editor.emit('end', { terminal: busy })
    const moved = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(moved.value.terminal, 'moved')
    // One with no shell integration, whose state the editor cannot tell, is never typed into.
    const blind = editor.openTerminal(repo)
    editor.useTerminal(blind)
    const unread = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(unread.value.terminal, 'shown')
    // No terminal at all: one opens.
    closeAllTerminals()
    const before = editor.seen.terminals.length
    const none = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(none.value.terminal, 'opened')
    assert.equal(editor.seen.terminals.length, before + 1)
    closeAllTerminals()
})

test('a terminal that was running something before LaneKit started is not taken for one at its prompt', async () => {
    closeAllTerminals()
    // Shell integration says where it is, but LaneKit has seen neither its prompt nor a command end.
    const old = editor.openTerminal(repo, { shell: repo })
    editor.useTerminal(old)
    const reply = await editor.ask('open', { what: 'goto', repo, lane: 'working' })
    assert.equal(reply.value.terminal, 'opened')
    assert.deepEqual(old.commands, [])
    closeAllTerminals()
})

test('Start agent opens a terminal named for the lane and the agent, in the lane\'s colour, and types the agent\'s command', async () => {
    closeAllTerminals()
    editor.answers.pick = 'Claude Code'
    const reply = await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    const claude = editor.seen.made.at(-1)
    assert.equal(claude.name, 'working · Claude')
    assert.equal(claude.creationOptions.cwd, working)
    assert.equal(claude.creationOptions.color.id, colourOf('working'))
    assert.equal(claude.creationOptions.iconPath.id, 'sparkle')
    assert.deepEqual(claude.typed, ['claude -n working'], 'typed into its shell, the session named for the lane')
    assert.deepEqual(claude.shown, { preserveFocus: false }, 'in front, with the focus, to be typed to')
    const offered = editor.seen.picks.at(-1)
    assert.deepEqual(offered.map((item) => item.label).sort(), ['Claude Code', 'OpenCode'])
    // A second Claude in the same lane is numbered.
    await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(editor.seen.made.at(-1).name, 'working · Claude 2')
    // OpenCode, from the palette; and the agent picked last is offered first after.
    editor.answers.pick = 'OpenCode'
    await editor.seen.commands.get('lanekit.startAgent')({ repo: 'demo', lane: 'working' })
    const opencode = editor.seen.made.at(-1)
    assert.equal(opencode.name, 'working · OpenCode')
    assert.deepEqual(opencode.typed, ['opencode'])
    editor.answers.pick = undefined
    await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(editor.seen.picks.at(-1)[0].label, 'OpenCode')
    // A closed agent's name is free again.
    editor.closeTerminal(claude)
    editor.answers.pick = 'Claude Code'
    await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(editor.seen.made.at(-1).name, 'working · Claude')
    editor.answers.pick = undefined
    // An agent starts in a lane, not in the main checkout.
    const main = await editor.ask('open', { what: 'agent', repo })
    assert.equal(main.ok, false)
    assert.match(main.error, /in a lane/)
    closeAllTerminals()
})

test('every lane keeps one colour, from the terminal palette', () => {
    assert.equal(colourOf('midi-export'), colourOf('midi-export'))
    assert.match(colourOf('dark-mode'), /^terminal\.ansi[A-Z][a-z]+$/)
    assert.ok(new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(colourOf)).size > 1, 'lanes do not all share one')
})

test('a tab is titled with the repository its page shows, and LaneKit while it shows every one', async () => {
    await editor.seen.commands.get('lanekit.show')()
    await editor.tabSays({ type: 'showing', repo: 'demo', title: 'Demo' })
    assert.equal(editor.panel.title, 'Demo · LaneKit')
    await editor.tabSays({ type: 'showing', repo: null, title: null })
    assert.equal(editor.panel.title, 'LaneKit')
})

test('a repository opens in a tab of its own, on it and with its name, and a second ask brings that one forward', async () => {
    const before = editor.panels.length
    assert.equal((await editor.ask('tab', { repo: 'demo' })).ok, true)
    assert.equal(editor.panels.length, before + 1)
    const own = editor.panels.at(-1)
    assert.equal(own.title, 'demo · LaneKit')
    assert.match(own.webview.html, /<html data-surface="tab" data-repo="demo"/)
    assert.equal((await editor.ask('tab', { repo: 'demo' })).ok, true)
    assert.equal(editor.panels.length, before + 1, 'no second tab for one repository')
    assert.equal(own.revealed, 1)
    assert.equal((await editor.ask('tab', { repo: 'elsewhere' })).ok, false, 'only a repository LaneKit reads')
    // A lane asked for goes to the tab showing its repository alone.
    await editor.seen.commands.get('lanekit.show')({ repo: 'demo', lane: 'working' })
    assert.deepEqual(own.posted.filter((message) => message.type === 'focus'), [{ type: 'focus', repo: 'demo', lane: 'working' }])
    own.close()
    assert.equal(host.tabs().length, 1)
    assert.equal(host.panel()?.webview, editor.panel.webview, 'the tab left is where the icon goes')
})

test('a tab brought back after a reload starts on the repository it last showed', async () => {
    const restored = editor.makePanel()
    await editor.seen.serializer.deserializeWebviewPanel(restored, { only: 'demo', expanded: [] })
    assert.match(restored.webview.html, /data-repo="demo"/)
    restored.close()
    const all = editor.makePanel()
    await editor.seen.serializer.deserializeWebviewPanel(all, { only: null })
    assert.doesNotMatch(all.webview.html, /data-repo/)
    all.close()
})

test('a repository\'s name goes into the page as text, whatever it holds', () => {
    const html = pageHtml(path.join(KIT, 'web'), editor.panel.webview, (file) => editor.vscode.Uri.file(file), { repo: 'a"b<c>$&' })
    assert.match(html, /<html data-surface="tab" data-repo="a&quot;b&lt;c&gt;\$&amp;"/)
})

test('an agent at work is told to the pages and the status bar, said once when it needs you, and its terminal found', async () => {
    closeAllTerminals()
    const { reportClaude } = await import('../lib/agents.mjs')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
    // Claude Code under a terminal of this window: the terminal's shell is among the processes above the hook.
    const shell = editor.openTerminal(working)
    const chain = [{ pid: 4_194_101, name: 'node' }, { pid: process.pid, name: 'claude' }, { pid: await shell.processId, name: 'bash' }]
    const say = (hook_event_name, extra = {}) => reportClaude(JSON.stringify({ session_id: 'vs-1', cwd: working, hook_event_name, ...extra }), { chain, dir: READ_AGENTS })
    say('UserPromptSubmit')
    editor.seen.said.length = 0
    const reply = await editor.ask('state')
    const mine = reply.value.agents.find((agent) => agent.key === 'claude-vs-1')
    assert.deepEqual([mine.lane, mine.state], ['working', 'thinking'])
    assert.ok(editor.seen.posted.some((m) => m.type === 'agents' && m.agents.some((agent) => agent.key === 'claude-vs-1')), 'the pages are told')
    assert.equal(editor.agentBar.shown, true)
    assert.equal(editor.agentBar.text, '$(sparkle) 1 agent')
    assert.equal(editor.seen.said.length, 0, 'thinking is not news')

    say('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'b1' })
    await editor.ask('state')
    await settle()
    assert.deepEqual(editor.seen.said, ['LaneKit: working · Claude needs you: it asks to use Bash.'])
    assert.equal(editor.agentBar.text, '$(sparkle) 1 agent · 1 needs you')
    assert.equal(editor.agentBar.backgroundColor.id, 'statusBarItem.warningBackground')
    await editor.ask('state')
    await settle()
    assert.equal(editor.seen.said.length, 1, 'said once, not at every reading')

    // From the page, its terminal: the one whose shell it runs under.
    shell.shown = null
    const shown = await editor.ask('open', { what: 'agent-terminal', repo, key: 'claude-vs-1' })
    assert.equal(shown.ok, true, shown.error)
    assert.deepEqual(shell.shown, { preserveFocus: false })

    // Not said while you are looking at its terminal.
    say('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b1' })
    await editor.ask('state')
    editor.useTerminal(shell)
    say('PermissionRequest', { tool_name: 'Edit', tool_use_id: 'b2' })
    await editor.ask('state')
    await settle()
    assert.equal(editor.seen.said.length, 1)

    // From the palette: every agent, the one needing you first, picked for its terminal.
    editor.useTerminal(undefined)
    shell.shown = null
    editor.answers.pick = 'working · Claude'
    await editor.seen.commands.get('lanekit.agents')()
    assert.equal(editor.seen.picks.at(-1)[0].description, 'Needs you · Edit')
    assert.deepEqual(shell.shown, { preserveFocus: false })
    editor.answers.pick = undefined

    // Ended: gone from the bar, and the page's click is refused.
    say('SessionEnd')
    await editor.ask('state')
    assert.equal(editor.agentBar.shown, false)
    const gone = await editor.ask('open', { what: 'agent-terminal', repo, key: 'claude-vs-1' })
    assert.equal(gone.ok, false)
    assert.match(gone.error, /stopped/)
    closeAllTerminals()
})

test('the agents\' reporters are offered once a machine: added on Add, not asked again after Not now, and kept up to date after a yes', async () => {
    const home = path.join(scratch, 'home-offer')
    const settingsFile = path.join(home, '.claude', 'settings.json')
    const pluginFile = path.join(home, '.config', 'opencode', 'plugins', 'lanekit.js')
    const QUESTION = /^LaneKit can show what your agents are doing/
    /** A window opening on this machine: the person's answer to the question, and what the machine remembers. */
    const open = async (choose, remembered, { setting, wait = (said) => said.some((line) => QUESTION.test(line)) } = {}) => {
        const other = standIn([working])
        other.answers.choose = (text, choices) => (QUESTION.test(text) ? choose : undefined)
        if (setting) other.config.reportAgents = setting
        const globalState = { get: (key) => remembered.get(key), update: async (key, value) => { remembered.set(key, value) } }
        const made = await activate({ subscriptions: [], globalState }, other.vscode, { root: KIT, home, env: {} })
        for (let i = 0; i < 150 && !wait(other.seen.said); i++) await new Promise((resolve) => setTimeout(resolve, 20))
        await new Promise((resolve) => setTimeout(resolve, 50))
        made.dispose()
        return other.seen.said
    }
    const machine = new Map()
    const declined = await open('Not now', machine)
    assert.ok(declined.some((line) => QUESTION.test(line)), 'asked, once lanes are open')
    assert.equal(machine.get('lanekit.reportAgents'), 'no')
    assert.ok(!fs.existsSync(settingsFile) && !fs.existsSync(pluginFile), 'nothing written')
    const again = await open('Add', machine, { wait: () => false })
    assert.ok(!again.some((line) => QUESTION.test(line)), 'not asked again after Not now')

    const other = new Map()
    const added = await open('Add', other, { wait: (said) => said.some((line) => /^LaneKit: Added/.test(line)) })
    assert.equal(other.get('lanekit.reportAgents'), 'yes')
    assert.ok(added.some((line) => line.includes(settingsFile) && line.includes(pluginFile)), added.join(' | '))
    assert.match(fs.readFileSync(settingsFile, 'utf8'), /lane\.mjs' report claude/)
    assert.ok(fs.existsSync(pluginFile))

    // lanekit moved since: after a yes, brought up to date without a word.
    const written = fs.readFileSync(settingsFile, 'utf8')
    fs.writeFileSync(settingsFile, written.replaceAll(KIT, '/somewhere/old'))
    const quiet = await open('Add', other, { wait: () => fs.readFileSync(settingsFile, 'utf8') === written })
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), written)
    assert.ok(!quiet.some((line) => QUESTION.test(line)))

    // A workspace's setup can answer for it.
    fs.rmSync(path.join(home, '.config'), { recursive: true })
    await open(undefined, new Map(), { setting: 'always', wait: () => fs.existsSync(pluginFile) })
    assert.ok(fs.existsSync(pluginFile), 'always: added without asking')
})

test('an agent in a repository without lanes is counted, named by its folder, and said when it needs you', async () => {
    const { reportClaude } = await import('../lib/agents.mjs')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
    const plain = path.join(scratch, 'plain-repo')
    fs.mkdirSync(plain, { recursive: true })
    git(plain, 'init', '-q', '-b', 'main')
    const chain = [{ pid: 4_194_101, name: 'node' }, { pid: process.pid, name: 'claude' }]
    const say = (hook_event_name, extra = {}) => reportClaude(JSON.stringify({ session_id: 'vs-2', cwd: plain, hook_event_name, ...extra }), { chain, dir: READ_AGENTS })
    say('UserPromptSubmit')
    editor.seen.said.length = 0
    const reply = await editor.ask('state')
    const mine = reply.value.agents.find((agent) => agent.key === 'claude-vs-2')
    assert.deepEqual([mine.repo, mine.lane, mine.where], [null, null, 'plain-repo'])
    assert.equal(editor.agentBar.text, '$(sparkle) 1 agent')
    say('PermissionRequest', { tool_name: 'Bash', tool_use_id: 'p1' })
    await editor.ask('state')
    await settle()
    assert.deepEqual(editor.seen.said, ['LaneKit: plain-repo · Claude needs you: it asks to use Bash.'])
    editor.answers.pick = 'plain-repo · Claude'
    await editor.seen.commands.get('lanekit.agents')()
    assert.match(editor.seen.picks.at(-1)[0].detail, /plain-repo, which has no lanes$/)
    assert.match(editor.seen.said.at(-1), /plain-repo · Claude runs in a terminal outside this window/, 'no terminal of this window: said, and no lanes page to show')
    editor.answers.pick = undefined
    say('SessionEnd')
    await editor.ask('state')
    assert.equal(editor.agentBar.shown, false)
})

test('in tmux, an agent starts in a session of its own, and a click finds the terminal attached to it, or attaches a new one', async () => {
    closeAllTerminals()
    const { reportClaude } = await import('../lib/agents.mjs')
    editor.config.agentsInTmux = true
    process.env.FAKE_TMUX_TAKEN = 'lk-demo-working-claude'   // one of that name runs already, so this one is numbered
    editor.answers.pick = 'Claude Code'
    const reply = await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(reply.ok, true, reply.error)
    assert.equal(reply.value.tmux, 'lk-demo-working-claude-2')
    const started = editor.seen.made.at(-1)
    assert.equal(started.name, 'working · Claude 2', 'the terminal numbered as its session is')
    assert.deepEqual(started.typed, [`'${FAKE_TMUX}' 'new-session' '-s' 'lk-demo-working-claude-2' '-c' '${working}' '${os.userInfo().shell}' '-lic' 'claude -n working'`],
        'in a login shell of the person\'s own, in the lane')
    editor.answers.pick = undefined

    // The agent reports from inside the session: its pane is in its environment.
    const chain = [{ pid: 4_194_101, name: 'node' }, { pid: process.pid, name: 'claude' }]
    const tmuxEnv = { TMUX: '/tmp/tmux-501/default,999,3', TMUX_PANE: '%7' }
    reportClaude(JSON.stringify({ session_id: 'vs-3', cwd: working, hook_event_name: 'SessionStart' }), { chain, dir: READ_AGENTS, env: tmuxEnv })
    await editor.ask('state')
    // A terminal whose shell runs a client of that session is the agent's: here, this test's own process, under its parent.
    process.env.FAKE_TMUX_SESSION = 'lk-demo-working-claude-2'
    process.env.FAKE_TMUX_CLIENTS = String(process.pid)
    const attached = editor.openTerminal(working)
    attached.processId = Promise.resolve(process.ppid)
    const shown = await editor.ask('open', { what: 'agent-terminal', repo, key: 'claude-vs-3' })
    assert.equal(shown.ok, true, shown.error)
    assert.deepEqual(attached.shown, { preserveFocus: false })
    assert.match(fs.readFileSync(process.env.FAKE_TMUX_LOG, 'utf8'), /-S \/tmp\/tmux-501\/default list-clients -t =lk-demo-working-claude-2 -F #\{client_pid\}/)

    // That terminal closed, or the editor: a new one is attached to the session, named for the agent.
    editor.closeTerminal(attached)
    process.env.FAKE_TMUX_CLIENTS = ''
    const before = editor.seen.terminals.length
    await editor.ask('open', { what: 'agent-terminal', repo, key: 'claude-vs-3' })
    assert.equal(editor.seen.terminals.length, before + 1)
    const again = editor.seen.made.at(-1)
    assert.equal(again.name, 'working · Claude')
    assert.equal(again.creationOptions.color.id, colourOf('working'))
    assert.deepEqual(again.typed, [`'${FAKE_TMUX}' '-S' '/tmp/tmux-501/default' 'attach-session' '-t' '=lk-demo-working-claude-2'`])
    assert.deepEqual(again.shown, { preserveFocus: false })

    // Its session gone: nothing to attach, and said.
    process.env.FAKE_TMUX_SESSION = ''
    editor.seen.said.length = 0
    const count = editor.seen.terminals.length
    await editor.ask('open', { what: 'agent-terminal', repo, key: 'claude-vs-3' })
    assert.equal(editor.seen.terminals.length, count)
    assert.match(editor.seen.said.at(-1), /runs in a terminal outside this window/)

    reportClaude(JSON.stringify({ session_id: 'vs-3', cwd: working, hook_event_name: 'SessionEnd' }), { chain, dir: READ_AGENTS })
    editor.config.agentsInTmux = false
    for (const name of ['FAKE_TMUX_TAKEN', 'FAKE_TMUX_SESSION', 'FAKE_TMUX_CLIENTS']) delete process.env[name]
    closeAllTerminals()
})

test('with agentsInTmux off, or no tmux, an agent is typed into its terminal\'s shell as before', async () => {
    closeAllTerminals()
    editor.config.agentsInTmux = false
    editor.answers.pick = 'OpenCode'
    const reply = await editor.ask('open', { what: 'agent', repo, lane: 'working' })
    assert.equal(reply.value.tmux, undefined)
    assert.deepEqual(editor.seen.made.at(-1).typed, ['opencode'])
    editor.answers.pick = undefined
    closeAllTerminals()
})
