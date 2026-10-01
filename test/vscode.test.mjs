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

import { activate, pageHtml, SCHEME, wordOf } from '../vscode/host.mjs'
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
    class Uri {
        constructor (parts) { Object.assign(this, { query: '', ...parts }); this.fsPath = this.path }
        static file (file) { return new Uri({ scheme: 'file', path: file }) }
        static from (parts) { return new Uri(parts) }
        toString () { return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}` }
    }
    const config = {}
    const answers = {}   // what the stand-in person picks and types, when a test says
    const seen = { picks: [], commands: new Map(), executed: [], posted: [], sidePosted: [], said: [], providers: new Map(), terminals: [], views: new Map() }
    let receive = null
    let sideReceive = null
    let active = null
    const bar = { text: '', tooltip: '', command: null, shown: false, show () { this.shown = true }, hide () { this.shown = false }, dispose () {} }
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
    const vscode = {
        Uri,
        Range,
        ViewColumn: { Active: -1 },
        StatusBarAlignment: { Left: 1 },
        window: {
            createOutputChannel: () => ({ append () {}, appendLine () {}, show () {}, dispose () {} }),
            createWebviewPanel: () => panel,
            registerWebviewPanelSerializer: () => disposable,
            createStatusBarItem: () => bar,
            createTerminal: (options) => { seen.terminals.push(options); return { show () {} } },
            registerWebviewViewProvider: (id, provider, options) => { seen.views.set(id, { provider, options }); return disposable },
            showInformationMessage: (...args) => { seen.said.push(args[0]); return Promise.resolve(undefined) },
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
    return { vscode, seen, bar, panel, sideView, ask, askSide, sideSays, config, answers, setActive: (file) => { active = file ? { document: { uri: Uri.file(file) } } : null } }
}

let scratch
let work
let repo
let working
let first
let editor
let host

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
    editor = standIn([working])
    host = await activate({ subscriptions: [] }, editor.vscode, { root: KIT })
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

test('a terminal opens in the lane', async () => {
    const reply = await editor.ask('open', { what: 'terminal', repo, lane: 'working' })
    assert.equal(reply.ok, true)
    assert.equal(editor.seen.terminals.at(-1).cwd, working)
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
    // Pressed again, after something else had the side bar: the tab again.
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
    const terminals = editor.seen.terminals.length
    await editor.seen.commands.get('lanekit.laneMenu')({ repo: 'demo', lane: 'working' })
    const labels = editor.seen.picks.at(-1).map((item) => item.label)
    for (const want of ['Show in LaneKit', 'Terminal', 'New lane from here', 'Open in a new window']) {
        assert.ok(labels.some((label) => label.includes(want)), `${want} in ${labels.join(', ')}`)
    }
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

test('the pages are told where the editor is, for their You are here', async () => {
    editor.seen.posted.length = 0
    editor.setActive(path.join(working, 'feature.txt'))
    await editor.ask('state')
    assert.ok(editor.seen.posted.some((m) => m.type === 'here' && m.repo === 'demo' && m.lane === 'working'), JSON.stringify(editor.seen.posted.filter((m) => m.type === 'here')))
    editor.setActive(path.join(repo, 'app.txt'))
    await editor.ask('state')
    assert.ok(editor.seen.posted.some((m) => m.type === 'here' && m.repo === 'demo' && m.lane === null), 'the main checkout')
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
