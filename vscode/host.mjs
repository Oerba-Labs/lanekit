/**
 * LaneKit's editor extension at work, inside VS Code: the lanes page as a tab of the editor, the
 * service it asks (lib/service.mjs) running here in the editor, and everything the page
 * points at opened where a developer already is — a commit's changes, a lane's, a file's
 * diff, what is uncommitted, a lane's folder, a terminal in it, an agent in one. The shape of Sapling's
 * Interactive Smartlog: one page, drawn the same in a browser and in the editor, and in
 * the editor its clicks drive the editor.
 *
 * WHY HERE AND NOT BEHIND A PORT. `lane web` serves the page to a browser; framing that in
 * the editor would leave a server to keep running, a proxy between every click and its
 * answer, and a page in its own colours. Here the page is the editor's, it is told when
 * anything changed rather than asking every few seconds, and it works in whatever folder
 * the editor has open, a lane's own included.
 *
 * WHAT IT WILL NOT DO. Run anything the page cannot: every press goes through the same
 * service, with the same refusals, as `lane web`'s. Open a file outside a repository the
 * service found, or at anything but a commit. Keep the editor waiting: the repositories
 * are read in a worker thread.
 *
 * `vscode` is handed in by extension.js rather than imported, so the tests can hand in a
 * stand-in (test/vscode.test.mjs).
 */

import { execFile, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { AGENT_NAMES, agentsDir, ancestry, installForUser, reportersOn } from '../lib/agents.mjs'
import { createService } from '../lib/service.mjs'

export const VIEW = 'lanekit.lanes'
export const SIDEBAR = 'lanekit.sidebar'
export const SCHEME = 'lanekit'
const EVERY_VISIBLE_MS = 4000
const EVERY_HIDDEN_MS = 20000
const EVERY_IDLE_MS = 60000
const AGENTS_EVERY_MS = 2000
const NAME = /^[a-z0-9][a-z0-9-]*$/

/** A lane's state in a few words, for the status bar: the page's own words, shorter. */
export const wordOf = (lane) => {
    if (lane.kind === 'missing') return 'folder gone'
    if (lane.operation) return lane.operation === 'rebase' ? 'mid-rebase' : 'mid-merge'
    if (lane.kind === 'landed') return 'landed'
    if (lane.kind === 'fresh' && !lane.dirty) return 'nothing committed'
    switch (lane.queue?.verdict) {
        case 'land now': return 'ready to land'
        case 'gate now': return 'needs a gate'
        case 'hold the gate': return 'wait for another lane'
        case 'commit first': return 'uncommitted changes'
        case 'rebase first': return 'conflicts with main'
        case 'parked': return 'parked'
        default: return lane.queue?.verdict ?? 'not planned'
    }
}

/** What an agent is doing, in the page's words. */
export const STATE_WORDS = { ready: 'Ready', thinking: 'Thinking', running: 'Running', 'needs-you': 'Needs you', done: 'Done', failed: 'Failed' }
/** An agent as a person names it: where it works (its lane, its repository, or the folder it is in, where LaneKit
    reads no lanes) and what it is, as its terminal is named. */
export const agentName = (agent) => `${agent.lane ?? agent.repo ?? agent.where ?? 'somewhere'} · ${AGENT_NAMES[agent.agent] ?? agent.agent}`

/** A lane's colour, the same for every terminal LaneKit opens in it: from its name, so it stays put across reloads. */
const COLOURS = ['terminal.ansiCyan', 'terminal.ansiMagenta', 'terminal.ansiYellow', 'terminal.ansiGreen', 'terminal.ansiBlue', 'terminal.ansiRed']
export const colourOf = (name) => COLOURS[[...String(name)].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % COLOURS.length]

/** The agents a lane can be started with: the command each runs as, and where its installer puts it, for one that is
    not on the PATH the editor itself was given. */
export const AGENTS = {
    claude: { label: 'Claude Code', short: 'Claude', bin: 'claude', args: (lane) => ['-n', lane], homes: ['.local/bin', '.claude/local'] },
    opencode: { label: 'OpenCode', short: 'OpenCode', bin: 'opencode', args: () => [], homes: ['.opencode/bin'] }
}
const agentAt = (agent) => {
    for (const dir of [...String(process.env.PATH ?? '').split(path.delimiter), ...agent.homes.map((home) => path.join(os.homedir(), home))]) {
        if (!dir) continue
        try {
            const file = path.join(dir, agent.bin)
            fs.accessSync(file, fs.constants.X_OK)
            if (fs.statSync(file).isFile()) return file
        } catch {}
    }
    return null
}

/** What the side bar's view holds where LaneKit opens in a tab: a line and a link, no script and no second page.
    It is seen for a moment when the icon is pressed, or for good where the side bar cannot be closed. */
export const signpostHtml = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body { margin: 0; padding: 10px 14px; color: var(--vscode-descriptionForeground); font: var(--vscode-font-size, 13px)/1.5 var(--vscode-font-family, sans-serif); }
/* Unseen for the moment the side bar is open on its way to closing; there only if it stays. */
body { animation: appear 0.2s ease 0.6s both; }
@keyframes appear { from { opacity: 0; } to { opacity: 1; } }
a { color: var(--vscode-textLink-foreground); }
code { font-family: var(--vscode-editor-font-family, monospace); }
</style></head><body>
<p>LaneKit opens in an editor tab. <a href="command:lanekit.show">Open LaneKit</a></p>
<p>To keep it here in the side bar instead, set <code>lanekit.opensIn</code> to <code>sideBar</code>.</p>
</body></html>`

/** A value put inside an attribute's double quotes, as text: a repository's name is somebody's words. */
const attribute = (value) => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The page's HTML for a webview: its own files by the webview's addresses, and nothing else allowed. `repo` is the
    repository a tab opened for one starts on. */
export const pageHtml = (webDir, webview, fileUri, { nonce = crypto.randomBytes(18).toString('base64'), surface = 'tab', repo = null } = {}) => {
    const uri = (file) => webview.asWebviewUri(fileUri(path.join(webDir, file))).toString()
    const csp = [
        "default-src 'none'",
        `style-src ${webview.cspSource}`,
        `script-src 'nonce-${nonce}'`,
        `img-src ${webview.cspSource} data:`,
        `font-src ${webview.cspSource}`
    ].join('; ')
    let html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8')
    const style = '<link rel="stylesheet" href="lanes.css">'
    const script = '<script src="lanes.js" defer></script>'
    if (!html.includes(style) || !html.includes(script)) throw new Error('web/index.html no longer names lanes.css and lanes.js as the extension expects')
    html = html.replace(style, `<meta http-equiv="Content-Security-Policy" content="${csp}">\n<link rel="stylesheet" href="${uri('lanes.css')}">`)
    html = html.replace(script, `<script nonce="${nonce}" src="${uri('lanes.js')}" defer></script>`)
    // Where the page is drawn, for its stylesheet and its log: the side bar's is narrow.
    if (!/<html\b/.test(html)) throw new Error('web/index.html has no <html> element to say where it is drawn')
    const marks = `data-surface="${surface === 'sidebar' ? 'sidebar' : 'tab'}"${repo ? ` data-repo="${attribute(repo)}"` : ''}`
    // A function, so nothing in a repository's name is read as a replacement pattern ($&).
    return html.replace(/<html\b/, () => `<html ${marks}`)
}

export const activate = async (context, vscode, { root, home = os.homedir(), env = process.env, tmux: tmuxGiven }) => {
    const webDir = path.join(root, 'web')
    const subscriptions = context.subscriptions
    const output = vscode.window.createOutputChannel('LaneKit')
    subscriptions.push(output)

    const foldersNow = () => [
        ...(vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
        ...(vscode.workspace.getConfiguration('lanekit').get('folders') ?? []).filter((dir) => typeof dir === 'string' && dir)
    ]
    const service = createService({ dirs: foldersNow(), reader: 'worker', packageRoot: root, agentsDir: agentsDir({ home, env }) })

    // -----------------------------------------------------------------------
    // the pages: the side bar's, there by default, and a tab, for room
    // -----------------------------------------------------------------------

    // Every page open, each its own webview. What changed and a job's news go to all of them; a reply goes
    // only to the page that asked, since each page numbers its own questions from one.
    const pages = new Set()
    // Tabs, as many as there are repositories at most: one shows every repository, each other one repository (its
    // `showing`), titled with its name. `panel` is the tab looked at last, where the icon and a Show go.
    let panel = null
    let sidebar = null
    const tabs = () => [...pages].filter((page) => page.surface === 'tab')
    /** Where LaneKit opens, from its icon and from everything that asks to show it: an editor tab, by default (the
        owner, 30 Sep: the icon should open the page in the editor, not the narrow side bar), or the side bar itself
        where lanekit.opensIn says sideBar. */
    const inTab = () => vscode.workspace.getConfiguration('lanekit').get('opensIn') !== 'sideBar'
    let pendingFocus = null   // { page, surface, repo, lane }: asked for before that page could hear it
    let lastSent = null
    const post = (message) => { for (const page of pages) page.webview.postMessage(message) }
    const anyVisible = () => [...pages].some((page) => page.visible())

    const wire = (page) => {
        page.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(webDir)] }
        page.webview.html = pageHtml(webDir, page.webview, (file) => vscode.Uri.file(file), { surface: page.surface, repo: page.showing })
        pages.add(page)
        lastSent = null
        page.webview.onDidReceiveMessage((message) => onMessage(message, page), null, subscriptions)
    }
    /** A lane to mark on a page: at once on a page that is listening, when it says it is ready on one just made. */
    const focusIn = (surface, focus, fresh, page = surface === 'tab' ? panel : sidebar) => {
        if (!focus?.repo || !focus?.lane) return
        if (fresh || !page) pendingFocus = { page, surface, repo: focus.repo, lane: focus.lane }
        else page.webview.postMessage({ type: 'focus', repo: focus.repo, lane: focus.lane })
    }

    const adopt = (made, { repo = null } = {}) => {
        const page = { surface: 'tab', made, showing: repo, webview: made.webview, visible: () => made.visible, reveal: () => made.reveal() }
        panel = page
        wire(page)
        made.onDidChangeViewState(() => { if (made.active) panel = page; schedule(true) }, null, subscriptions)
        made.onDidDispose(() => { pages.delete(page); if (panel === page) panel = tabs().at(-1) ?? null; schedule() }, null, subscriptions)
        return page
    }
    /** A new tab: every repository, or the one named, under its name until its page says what it is called. */
    const newTab = (repo = null) => adopt(vscode.window.createWebviewPanel(VIEW, repo ? `${repo} · LaneKit` : 'LaneKit', vscode.ViewColumn.Active, {
        enableScripts: true,
        // Its drawer, its open confirmations and where it was scrolled survive a switch of tabs.
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.file(webDir)]
    }), { repo })

    /** The full page in a tab of its own: room for a long log, or a second look beside the side bar's. A lane asked
        for goes to the tab showing its repository alone, if one does; anything else to the tab looked at last. */
    const show = (focus) => {
        const target = (focus?.repo && tabs().find((page) => page.showing === focus.repo)) || panel
        if (target) target.reveal()
        const page = target ?? newTab()
        focusIn('tab', focus, !target, page)
        schedule(true)
    }
    /** One repository in a tab of its own, titled with its name: the tab already showing it, or a new one. */
    const showOwn = (repo) => {
        const open = tabs().find((page) => page.showing === repo)
        if (open) open.reveal(); else newTab(repo)
        schedule(true)
    }

    // A tab VS Code brings back after a reload is the page's again, on the repository it last showed (the page keeps
    // that in its state, which VS Code hands back here too).
    subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW, {
        deserializeWebviewPanel: async (restored, state) => {
            adopt(restored, { repo: typeof state?.only === 'string' && state.only ? state.only : null })
            schedule(true)
        }
    }))

    // The side bar's view, behind the LaneKit icon, which is there whenever the extension is. VS Code makes it the
    // first time it is shown and keeps what it holds while another view is in front. VS Code gives an activity-bar
    // icon no way to open a tab of its own, so where LaneKit opens in a tab, the view, each time the icon brings it
    // out, opens the tab and closes the side bar again, and holds a signpost rather than a second page. Where it
    // opens in the side bar, the view is the page.
    let sideView = null
    const fillSide = (view) => {
        const isPage = sidebar?.view === view
        if (inTab()) {
            if (isPage) { pages.delete(sidebar); sidebar = null }
            view.webview.options = { enableScripts: false, enableCommandUris: ['lanekit.show'] }
            view.webview.html = signpostHtml()
        } else if (!isPage) {
            const page = { surface: 'sidebar', view, webview: view.webview, visible: () => view.visible }
            sidebar = page
            wire(page)
        }
    }
    // The side bar is told to close before the tab is opened: both go to the window together, and the side bar
    // is in sight only for the round trip that told LaneKit it was (over code-server, the browser and back). A
    // press is acted on once, though VS Code may say both that the view was made and that it became visible.
    let toTabAt = 0
    const toTab = () => {
        if (Date.now() - toTabAt < 400) return
        toTabAt = Date.now()
        void vscode.commands.executeCommand('workbench.action.closeSidebar')
        show()
    }
    subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR, {
        resolveWebviewView: (view) => {
            sideView = view
            fillSide(view)
            view.onDidChangeVisibility(() => {
                if (view.visible && inTab()) toTab()
                schedule(true)
            }, null, subscriptions)
            view.onDidDispose(() => {
                if (sidebar?.view === view) { pages.delete(sidebar); sidebar = null }
                if (sideView === view) sideView = null
                schedule()
            }, null, subscriptions)
            if (view.visible && inTab()) toTab()
            schedule(true)
        }
    }, { webviewOptions: { retainContextWhenHidden: true } }))
    subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('lanekit.opensIn') && sideView) fillSide(sideView)
    }))

    /** LaneKit brought forward, with a lane marked on it, wherever it opens: where the status bar sends you. */
    const reveal = async (focus) => {
        if (inTab()) return show(focus)
        const fresh = !sidebar
        await vscode.commands.executeCommand(`${SIDEBAR}.focus`)
        focusIn('sidebar', focus, fresh)
        schedule(true)
    }

    // -----------------------------------------------------------------------
    // reading: while a page is looked at, when a file is saved, after a press
    // -----------------------------------------------------------------------

    let timer = null
    let reading = false
    let readAgain = false
    let disposed = false

    const tick = async () => {
        if (disposed) return
        if (reading) { readAgain = true; return }
        reading = true
        let state = null
        try {
            state = await service.state()
            const key = JSON.stringify({ ...state, at: 0 })
            if (key !== lastSent) { lastSent = key; post({ type: 'state', state }) }
            updateBar()
            heardAgents(state.agents ?? [])
            if (state.repos.length) void offerReporters().catch((error) => output.appendLine(`Offering the agents' reporters failed: ${error.message}`))
            // Somebody is looking: each repository fetched now and then, by itself (the service keeps to five minutes).
            if (anyVisible()) service.fetchQuietly().catch(() => {})
            gateOnCommit(state)
        } catch (error) {
            output.appendLine(`Reading the lanes failed: ${error.message}`)
        } finally {
            reading = false
            if (readAgain) { readAgain = false; tick() } else schedule(false, state)
        }
    }

    /**
     * `lanekit.gateOnCommit`: a lane whose commit moved since the last reading, with nothing uncommitted, nothing
     * running in its repository, and no gate result for the new commit, is gated by itself. The gate rebases it
     * first, as it always does; the rebased commit it then passes is the one its result names, so it does not
     * start another.
     */
    const heads = new Map()
    const gateOnCommit = (state) => {
        const on = vscode.workspace.getConfiguration('lanekit').get('gateOnCommit') === true
        for (const repo of state.repos) {
            if (repo.error) continue
            const running = state.jobs.some((job) => job.state === 'running' && job.repo === repo.id)
            for (const lane of repo.lanes) {
                if (lane.kind !== 'working' || !lane.head) continue
                const key = `${repo.path}\0${lane.name}`
                const before = heads.get(key)
                heads.set(key, lane.head.sha)
                if (!on || !before || before === lane.head.sha || running) continue
                if (lane.dirty || lane.operation || lane.gate?.current) continue
                service.press({ repo: repo.id, verb: 'gate', lane: lane.name }).then((pressed) => {
                    if (pressed.status < 400) output.appendLine(`LaneKit: gating ${lane.name} by itself, after a commit (lanekit.gateOnCommit).`)
                }).catch(() => {})
            }
        }
    }

    const schedule = (soon = false, state = null) => {
        if (disposed) return
        clearTimeout(timer)
        const idle = !pages.size && state && !state.repos.length
        timer = setTimeout(tick, soon ? 250 : anyVisible() ? EVERY_VISIBLE_MS : idle ? EVERY_IDLE_MS : EVERY_HIDDEN_MS)
    }

    subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => schedule(true)))
    subscriptions.push(vscode.window.onDidChangeWindowState((state) => { if (state.focused) schedule(true) }))
    subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => updateBar()))
    subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => { service.setRoots(foldersNow()); schedule(true) }))
    subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('lanekit')) { service.setRoots(foldersNow()); schedule(true) }
    }))

    // -----------------------------------------------------------------------
    // jobs: the page follows them; a job begun from the palette says how it ended
    // -----------------------------------------------------------------------

    const fromPalette = new Set()
    let jobPing = null
    let pingedJob = null
    // The pages are told of a job with the job itself (its step, its state), and ask for its new output when
    // they show it: told at most every tenth of a second.
    service.events.on('started', (job) => post({ type: 'job', id: job.id, job }))
    service.events.on('queued', (job) => post({ type: 'job', id: job.id, job }))
    service.events.on('output', (job, text) => {
        output.append(text)
        pingedJob = job
        if (!jobPing) jobPing = setTimeout(() => { jobPing = null; post({ type: 'job', id: pingedJob.id, job: pingedJob }) }, 100)
    })
    service.events.on('fetched', () => schedule(true))
    // A press that ends while no LaneKit page is in sight says how it ended, whoever pressed it, with the lane and
    // its output a click away.
    const SAID = { gate: ['passed', 'failed'], land: ['landed', 'did not land'], rebase: ['rebased', 'stopped'], push: ['pushed', 'was refused'],
        pr: ['has a pull request', 'has no pull request'], pull: ['pulled', 'did not pull'], new: ['is made', 'was not made'], sweep: ['swept', 'was not swept'],
        commit: ['is committed', 'was not committed'], uncommit: ['is uncommitted', 'was not uncommitted'], discard: ['is discarded', 'was not discarded'], resolve: ['is resolved', 'is not resolved'],
        aside: ['is set aside', 'was not set aside'], resume: ['is back', 'was not brought back'], drop: ['is dropped, its branch kept', 'was not dropped'], adopt: ['has lanes', 'was not given lanes'] }
    service.events.on('done', (job) => {
        post({ type: 'job', id: job.id, job })
        schedule(true)
        fromPalette.delete(job.id)
        if (anyVisible() || job.verb === 'fetch' || job.dryRun) return
        const [good, bad] = SAID[job.verb] ?? ['finished', 'failed']
        const what = `${job.lane ?? job.repo} ${job.code === 0 ? good : bad}`
        const choices = job.lane ? ['Show', 'Show output'] : ['Show output']
        const said = job.code === 0 ? vscode.window.showInformationMessage(`LaneKit: ${what}.`, ...choices)
            : vscode.window.showErrorMessage(`LaneKit: ${what} (exit ${job.code}).`, ...choices)
        Promise.resolve(said).then((choice) => {
            if (choice === 'Show output') output.show(true)
            if (choice === 'Show') reveal({ repo: job.repo, lane: job.lane })
        })
    })
    const finished = (id) => new Promise((resolve) => {
        const kept = service.job(id)
        if (kept && kept.state === 'done') return resolve(kept)
        const on = (job) => { if (job.id === id) { service.events.off('done', on); resolve(service.job(id)) } }
        service.events.on('done', on)
    })

    // -----------------------------------------------------------------------
    // terminals: each named for its lane and in the lane's colour, an agent's among them
    // -----------------------------------------------------------------------

    // What the editor says of its terminals, where the shell has shell integration: the folder each is in, and
    // whether a command is running in it. A terminal counts as waiting at its prompt only once LaneKit has seen it
    // there, so one that was running something before LaneKit started is never taken for idle.
    const running = new Map()
    const atPrompt = new Set()
    const recent = []          // the terminals used, the last first
    const opened = new Map()   // terminal → { checkout, name, agent }: the ones LaneKit opened
    const listen = (event, run) => { if (typeof event === 'function') subscriptions.push(event(run)) }
    const forget = (list, item) => { const at = list.indexOf(item); if (at >= 0) list.splice(at, 1) }
    listen(vscode.window.onDidStartTerminalShellExecution, ({ terminal }) => { running.set(terminal, (running.get(terminal) ?? 0) + 1) })
    listen(vscode.window.onDidEndTerminalShellExecution, ({ terminal }) => {
        const left = (running.get(terminal) ?? 1) - 1
        if (left > 0) running.set(terminal, left)
        else { running.delete(terminal); atPrompt.add(terminal) }
    })
    listen(vscode.window.onDidChangeTerminalShellIntegration, ({ terminal }) => { if (!running.get(terminal)) atPrompt.add(terminal) })
    listen(vscode.window.onDidChangeActiveTerminal, (terminal) => { if (terminal) { forget(recent, terminal); recent.unshift(terminal) } })
    listen(vscode.window.onDidCloseTerminal, (terminal) => { running.delete(terminal); atPrompt.delete(terminal); opened.delete(terminal); forget(recent, terminal) })
    const idle = (terminal) => Boolean(terminal.shellIntegration) && atPrompt.has(terminal) && !running.get(terminal)
    const folderOf = (where) => (typeof where === 'string' ? where : where?.fsPath ?? null)
    /** Where a terminal is: where its shell says it is, else where it was opened. */
    const terminalAt = (terminal) => folderOf(terminal.shellIntegration?.cwd) ?? folderOf(terminal.creationOptions?.cwd)

    /** A new terminal in a lane, or in the main checkout: named for it, and in the lane's colour, which all of its share. */
    const newTerminal = (repo, lane, { agent = null, name = lane ? lane.name : repo.id } = {}) => {
        const checkout = lane?.path ?? repo.path
        const terminal = vscode.window.createTerminal({
            name, cwd: checkout,
            ...(lane && vscode.ThemeColor ? { color: new vscode.ThemeColor(colourOf(lane.name)) } : {}),
            ...(vscode.ThemeIcon ? { iconPath: new vscode.ThemeIcon(agent ? 'sparkle' : lane ? 'git-branch' : 'terminal') } : {})
        })
        opened.set(terminal, { checkout, name, agent })
        return terminal
    }

    /** Which agent to start in a lane: the one started last first, then those found on this machine. */
    const pickAgent = async (lane) => {
        const last = context.workspaceState?.get?.('lanekit.agent')
        const items = Object.entries(AGENTS).map(([id, agent]) => {
            const found = agentAt(agent)
            return { label: agent.label, description: found ?? 'not found where LaneKit looked', detail: `in a terminal named ${lane.name} · ${agent.short}`, id, found }
        }).sort((a, b) => (b.id === last) - (a.id === last) || Boolean(b.found) - Boolean(a.found))
        const picked = await vscode.window.showQuickPick(items, { title: `Start an agent in ${lane.name}` })
        return picked?.id ?? null
    }

    // tmux, where the machine has it (3.0 or newer, which takes a command as words): an agent started from LaneKit runs
    // in a tmux session of its own, and its terminal only shows it, so closing the terminal or the editor detaches the
    // agent rather than ending it, and a click on the agent attaches a terminal to it again (the owner, 1 Oct).
    // lanekit.agentsInTmux turns it off.
    let tmuxAt
    const tmuxPath = () => {
        if (tmuxAt !== undefined) return tmuxAt
        tmuxAt = null
        const places = tmuxGiven !== undefined ? [tmuxGiven]
            : [...String(env.PATH ?? '').split(path.delimiter), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].filter(Boolean).map((dir) => path.join(dir, 'tmux'))
        for (const file of places.filter(Boolean)) {
            const said = spawnSync(file, ['-V'], { encoding: 'utf8', timeout: 3000 })
            const major = Number(/tmux (?:next-)?(\d+)\./.exec(said.stdout ?? '')?.[1])
            if (said.status === 0 && major >= 3) { tmuxAt = file; break }
        }
        return tmuxAt
    }
    /** What tmux answers, or null where it fails (a session that is not there, a server that is not running). */
    const tmuxSays = (args) => new Promise((resolve) => {
        if (!tmuxPath()) return resolve(null)
        execFile(tmuxPath(), args, { timeout: 3000 }, (error, stdout) => resolve(error ? null : String(stdout).trim()))
    })
    const inTmux = () => vscode.workspace.getConfiguration('lanekit').get('agentsInTmux') !== false && Boolean(tmuxPath())
    // Words typed into a person's shell, each one word whatever it holds: in sh, bash and zsh, and in fish alike.
    const word = (text) => `'${String(text).replaceAll("'", "'\\''")}'`
    const loginShell = () => { try { return os.userInfo().shell || '/bin/bash' } catch { return '/bin/bash' } }

    /**
     * An agent in a lane, in a terminal of its own named for the lane and the agent and in the lane's colour, so the
     * terminal list says which agent works where. A second of the same agent in one lane is numbered. In tmux, the
     * session is named as the terminal is, and the agent runs in a login shell of the person's own (`-lic`), so it has
     * the PATH and the environment their terminal has; the session ends when the agent does, and the terminal is left
     * at its prompt in the lane. Without tmux the command is typed into the terminal's shell, for the same reason.
     */
    const startAgent = async (repo, lane, id) => {
        const agent = AGENTS[id]
        if (!agent) throw new Error(`LaneKit knows no agent called ${id}.`)
        if (!NAME.test(lane.name)) throw new Error(`${lane.name} is not a lane name LaneKit would type into a terminal.`)
        const tmux = inTmux() ? tmuxPath() : null
        const taken = new Set([...opened.values()].filter((about) => about.checkout === lane.path).map((about) => about.name))
        const stem = `lk-${String(repo.id).toLowerCase().replace(/[^a-z0-9-]+/g, '-')}-${lane.name}-${id}`
        let name
        let session
        for (let n = 1; n < 100; n++) {
            name = `${lane.name} · ${agent.short}${n > 1 ? ` ${n}` : ''}`
            session = `${stem}${n > 1 ? `-${n}` : ''}`
            if (taken.has(name)) continue
            if (tmux && await tmuxSays(['has-session', '-t', `=${session}`]) !== null) continue   // a session of that name runs already
            break
        }
        const terminal = newTerminal(repo, lane, { agent: id, name })
        const command = [agent.bin, ...agent.args(lane.name)].join(' ')
        terminal.sendText(tmux ? [tmux, 'new-session', '-s', session, '-c', lane.path, loginShell(), '-lic', command].map(word).join(' ') : command)
        terminal.show()
        await context.workspaceState?.update?.('lanekit.agent', id)
        return { terminal: name, ...(tmux ? { tmux: session } : {}) }
    }

    /**
     * The terminal in use follows Goto and takes the focus, since Goto is how a lane's terminal is reached (the owner,
     * 1 Oct: Goto did not move the focus, and did what Terminal did). A shell waiting at its prompt in another checkout
     * of the repository is sent `cd` to the same folder in this one, as a file reopens at the same path. One running
     * something (a server, an agent, an editor) is left as it is, as a file with unsaved changes is, since a `cd` typed
     * into an agent reaches it as words; so is one whose state the editor cannot tell, with no shell integration. For
     * those, and with no terminal open at all, the terminal last used in this checkout comes forward, or one opens there.
     */
    const followTerminal = async (repo, lane, target, ownerOf) => {
        const terminal = vscode.window.activeTerminal
        const at = terminal ? terminalAt(terminal) : null
        const from = at ? ownerOf(at) : null
        if (terminal && from === target) { terminal.show(false); return 'here' }
        if (terminal && from && idle(terminal)) {
            const there = path.join(target, path.relative(from, at))
            await terminal.shellIntegration.executeCommand('cd', [fs.existsSync(there) ? there : target])
            terminal.show(false)
            return 'moved'
        }
        const all = vscode.window.terminals ?? []
        const order = [...recent.filter((candidate) => all.includes(candidate)), ...all.filter((candidate) => !recent.includes(candidate))]
        const theirs = order.find((candidate) => { const where = terminalAt(candidate); return where && ownerOf(where) === target })
        ;(theirs ?? newTerminal(repo, lane)).show(false)
        return theirs ? 'shown' : 'opened'
    }
    const TERMINAL_SAID = { here: 'its terminal is in front', moved: 'your terminal moved with you', shown: 'the terminal you used there last is in front', opened: 'a terminal opened there' }

    // -----------------------------------------------------------------------
    // agents: what each is doing, its terminal, and a word when one needs you
    // -----------------------------------------------------------------------

    // Each agent reports itself into its repository (lib/agents.mjs), and the reports are read every couple of seconds,
    // apart from the readings of git, so that one waiting on a person is said at once rather than at the next reading.
    let agentsNow = []
    let agentsSaid = null
    const agentStates = new Map()   // report key -> the state last heard, to say each change once

    /** The tmux session an agent's pane is in, or null where its server or its pane is gone. */
    const tmuxSessionOf = (agent) => (agent.tmux ? tmuxSays(['-S', agent.tmux.socket, 'display-message', '-p', '-t', agent.tmux.pane, '#{session_name}']) : Promise.resolve(null))
    /**
     * An agent's terminal, among this window's: the one whose shell its process runs under, or, for an agent in tmux,
     * whose shell runs a tmux client attached to the agent's session.
     */
    const terminalOfAgent = async (agent) => {
        const terminals = await Promise.all((vscode.window.terminals ?? []).map(async (terminal) => [terminal, await Promise.resolve(terminal.processId).catch(() => null)]))
        const under = (pids) => terminals.find(([, pid]) => pid && pids.includes(pid))?.[0] ?? null
        const direct = under(agent.pids)
        if (direct || !agent.tmux) return direct
        const session = await tmuxSessionOf(agent)
        if (!session) return null
        const clients = await tmuxSays(['-S', agent.tmux.socket, 'list-clients', '-t', `=${session}`, '-F', '#{client_pid}'])
        for (const client of String(clients ?? '').split('\n').map(Number).filter((pid) => pid > 1)) {
            const showing = under(ancestry(client).map((entry) => entry.pid))
            if (showing) return showing
        }
        return null
    }
    /**
     * An agent brought forward: its terminal, with the focus. One in tmux with no terminal of this window on it (the
     * terminal was closed, or the editor) is attached again in a new terminal named for it. Else its lane on LaneKit's
     * page, and a word that the agent runs elsewhere.
     */
    const showAgent = async (agent) => {
        const terminal = await terminalOfAgent(agent)
        if (terminal) { terminal.show(false); return true }
        const session = await tmuxSessionOf(agent)
        if (session) {
            const again = vscode.window.createTerminal({
                name: agentName(agent), ...(agent.cwd ? { cwd: agent.cwd } : {}),
                ...(agent.lane && vscode.ThemeColor ? { color: new vscode.ThemeColor(colourOf(agent.lane)) } : {}),
                ...(vscode.ThemeIcon ? { iconPath: new vscode.ThemeIcon('sparkle') } : {})
            })
            again.sendText([tmuxPath(), '-S', agent.tmux.socket, 'attach-session', '-t', `=${session}`].map(word).join(' '))
            again.show(false)
            return true
        }
        if (agent.repo) await reveal({ repo: agent.repo, lane: agent.lane })
        vscode.window.showInformationMessage(`LaneKit: ${agentName(agent)} runs in a terminal outside this window (another window, tmux, or a terminal of its own).`)
        return false
    }

    const agentBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 39)
    subscriptions.push(agentBar)
    const updateAgentBar = () => {
        if (!agentsNow.length) { agentBar.hide(); return }
        const needs = agentsNow.filter((agent) => agent.state === 'needs-you')
        agentBar.text = `$(sparkle) ${agentsNow.length} ${agentsNow.length === 1 ? 'agent' : 'agents'}${needs.length ? ` · ${needs.length} ${needs.length === 1 ? 'needs' : 'need'} you` : ''}`
        agentBar.tooltip = agentsNow.map((agent) => `${agentName(agent)}: ${STATE_WORDS[agent.state]}${agent.tool ? ` (${agent.tool})` : ''}`).join('\n')
        agentBar.backgroundColor = needs.length && vscode.ThemeColor ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined
        agentBar.command = { command: 'lanekit.agents', title: 'LaneKit: the agents at work' }
        agentBar.show()
    }

    /**
     * What the agents are doing now. The pages are told when anything they draw changed; a person is told when an
     * agent comes to need them, or stops on an error, unless they are looking at its terminal already.
     */
    const heardAgents = (agents) => {
        agentsNow = agents
        const drawn = JSON.stringify(agents.map(({ at, ...rest }) => rest))
        if (drawn !== agentsSaid) { agentsSaid = drawn; post({ type: 'agents', agents }) }
        updateAgentBar()
        const seen = new Set()
        for (const agent of agents) {
            seen.add(agent.key)
            const before = agentStates.get(agent.key)
            agentStates.set(agent.key, agent.state)
            if (before === agent.state || (agent.state !== 'needs-you' && agent.state !== 'failed')) continue
            void (async () => {
                const terminal = await terminalOfAgent(agent)
                if (terminal && terminal === vscode.window.activeTerminal && vscode.window.state?.focused) return
                const said = agent.state === 'needs-you'
                    ? `LaneKit: ${agentName(agent)} needs you${agent.tool ? `: it asks to use ${agent.tool}` : ''}.`
                    : `LaneKit: ${agentName(agent)} stopped on an error.`
                const choice = await (agent.state === 'needs-you' ? vscode.window.showInformationMessage(said, 'Show') : vscode.window.showErrorMessage(said, 'Show'))
                if (choice === 'Show') await showAgent(agent)
            })()
        }
        for (const key of [...agentStates.keys()]) if (!seen.has(key)) agentStates.delete(key)
    }
    const watchAgents = () => {
        if (disposed || !service.known().at) return
        try { heardAgents(service.agents()) } catch (error) { output.appendLine(`Reading the agents failed: ${error.message}`) }
    }
    const agentsTimer = setInterval(watchAgents, AGENTS_EVERY_MS)

    // The reporters, once a machine (lib/agents.mjs): LaneKit's hook in the person's Claude Code settings and its
    // plugin among their OpenCode plugins. Asked once, the first time a repository with lanes is open on the
    // machine, and the answer kept for it; lanekit.reportAgents answers instead, `always` (a workspace's setup can
    // say so) or `never`. After a yes they are kept up to date, should lanekit move.
    const places = { home, env }
    let reportersOffered = false
    const addReporters = (quietly) => {
        const said = installForUser(root, places)
        for (const file of said.wrote) output.appendLine(`LaneKit: wrote ${file}, so this machine's agents say what they are doing.`)
        for (const warning of said.warnings) output.appendLine(`LaneKit: ${warning}.`)
        if (!quietly) {
            const what = said.wrote.length ? `Added: ${said.wrote.join('; ')}.` : 'They were in place already.'
            const left = said.warnings.length ? ` ${said.warnings.join('. ')}.` : ''
            vscode.window.showInformationMessage(`LaneKit: ${what} Agents started from now on say what they are doing; one running already, once it is started again.${left}`)
        }
        return said
    }
    const offerReporters = async () => {
        if (reportersOffered) return
        reportersOffered = true
        const setting = vscode.workspace.getConfiguration('lanekit').get('reportAgents') ?? 'ask'
        if (setting === 'never') return
        const now = reportersOn(root, places)
        if (now.claude.state !== 'missing' && now.opencode.state !== 'missing') return
        const answered = context.globalState?.get?.('lanekit.reportAgents')
        if (setting === 'always' || answered === 'yes') { addReporters(true); return }
        if (answered === 'no') return
        const choice = await vscode.window.showInformationMessage(
            'LaneKit can show what your agents are doing on each lane: thinking, running, needs you, done. Add its hook to your Claude Code settings and its plugin to your OpenCode plugins, on this machine?',
            'Add', 'Not now')
        if (choice === 'Add') {
            await context.globalState?.update?.('lanekit.reportAgents', 'yes')
            addReporters(false)
        } else if (choice === 'Not now') {
            await context.globalState?.update?.('lanekit.reportAgents', 'no')
        }
    }

    // -----------------------------------------------------------------------
    // what the page opens
    // -----------------------------------------------------------------------

    const fileUri = (checkout, rel) => vscode.Uri.file(path.join(checkout, rel))
    /** A file at a commit, read through the service by the content provider below. */
    const atCommit = (repo, sha, rel, checkout) => vscode.Uri.from({
        scheme: SCHEME, path: path.join(checkout, rel),
        query: new URLSearchParams({ repo: repo.path, sha, rel }).toString()
    })

    subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
        provideTextDocumentContent: async (uri) => {
            const asked = new URLSearchParams(uri.query)
            const bytes = await service.show(asked.get('repo'), asked.get('sha'), asked.get('rel'))
            return bytes ? new TextDecoder().decode(bytes) : ''
        }
    }))

    /**
     * Several files' diffs in one editor, VS Code's multi-diff: `[label, before, after]` each,
     * `before` missing for a file added and `after` for one deleted. Where the editor has no
     * multi-diff, a list to pick one file's diff from.
     */
    const showChanges = async (title, rows) => {
        if (!rows.length) {
            vscode.window.showInformationMessage(`${title}: nothing to show.`)
            return false
        }
        try {
            await vscode.commands.executeCommand('vscode.changes', title, rows)
            return true
        } catch (error) {
            output.appendLine(`The editor has no multi-file diff (${error.message}); offering a list instead.`)
        }
        const picked = rows.length === 1 ? rows[0]
            : (await vscode.window.showQuickPick(rows.map((row) => ({ label: path.basename(row[0].path), description: row[0].path, row })), { title }))?.row
        if (!picked) return false
        const [label, before, after] = picked
        await vscode.commands.executeCommand('vscode.diff', before ?? atEmpty(label), after ?? atEmpty(label), `${path.basename(label.path)} · ${title}`)
        return true
    }
    const atEmpty = (like) => vscode.Uri.from({ scheme: SCHEME, path: like.path, query: '' })

    const rowsOf = (repo, files, { beforeSha, afterSha = null, checkout }) => files.map((file) => {
        const after = file.status === 'D' ? undefined
            : afterSha ? atCommit(repo, afterSha, file.path, checkout) : fileUri(checkout, file.path)
        const before = file.status === 'A' ? undefined : atCommit(repo, beforeSha, file.from ?? file.path, checkout)
        return [after ?? before, before, after]
    })

    const commitNamed = (repo, sha) => [...repo.spine, ...repo.lanes.flatMap((lane) => lane.stack ?? [])]
        .find((commit) => commit.sha === sha)

    /**
     * Goto, ISL's way: where you are moves to a lane, or to the main checkout (`lane` null). Each file open from another
     * checkout of the repository reopens from this one, where it was, and the old tab closes; a file with unsaved
     * changes stays as it is, and one this checkout lacks is left open; the terminal in use follows and takes the focus
     * (followTerminal, above). Nothing on disk changes and no window opens: the lanes are folders of the workspace
     * already (the owner, 30 Sep: Open moving the whole window to a lane's folder did not feel right inside a workspace
     * that holds them all). Nor is the side bar opened on the Explorer, as it once was: with LaneKit in a tab it opened
     * a side bar LaneKit had closed, and moved the whole page across.
     */
    const inside = (file, dir) => file === dir || file.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
    const gotoCheckout = async (repo, lane) => {
        const target = lane?.path ?? repo.main?.path ?? repo.path
        const checkouts = [repo.main?.path ?? repo.path, ...repo.lanes.filter((candidate) => candidate.exists).map((candidate) => candidate.path)]
        const ownerOf = (file) => checkouts.filter((dir) => inside(file, dir)).sort((a, b) => b.length - a.length)[0] ?? null
        const active = vscode.window.activeTextEditor
        const moved = []
        const kept = []
        const missing = []
        for (const group of vscode.window.tabGroups?.all ?? []) {
            for (const tab of [...group.tabs]) {
                const uri = vscode.TabInputText && tab.input instanceof vscode.TabInputText ? tab.input.uri : null
                if (!uri || uri.scheme !== 'file') continue
                const from = ownerOf(uri.fsPath)
                if (!from || from === target) continue
                const rel = path.relative(from, uri.fsPath)
                if (tab.isDirty) { kept.push(rel); continue }
                const there = path.join(target, rel)
                if (!fs.existsSync(there)) { missing.push(rel); continue }
                const shown = vscode.window.visibleTextEditors?.find((editor) => editor.document.uri.fsPath === uri.fsPath)
                const wasActive = active?.document?.uri?.fsPath === uri.fsPath && group.isActive
                await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(there)), {
                    viewColumn: group.viewColumn, preview: false, preserveFocus: !wasActive, selection: shown?.selection
                })
                await vscode.window.tabGroups.close(tab, true)
                moved.push(rel)
            }
        }
        const name = lane ? lane.name : `${repo.id}'s main checkout`
        // A terminal that could not be moved does not undo a Goto that moved the files.
        const terminal = await followTerminal(repo, lane, target, ownerOf).catch((error) => {
            output.appendLine(`Goto moved the files but not the terminal: ${error.message}`)
            return null
        })
        const left = missing.length ? `; not in ${lane ? lane.name : 'main'}, so left as they were: ${missing.join(', ')}` : ''
        const followed = TERMINAL_SAID[terminal] ? `; ${TERMINAL_SAID[terminal]}` : ''
        vscode.window.setStatusBarMessage?.(`LaneKit: you are in ${name} now${moved.length ? `, with ${moved.length === 1 ? 'its copy of the file you had open' : `its copies of ${moved.length} files you had open`}` : ''}${followed}${left}`, 6000)
        if (kept.length) vscode.window.showInformationMessage(`LaneKit: ${kept.length === 1 ? `${kept[0]} has` : `${kept.length} files have`} unsaved changes, so ${kept.length === 1 ? 'it stays' : 'they stay'} where ${kept.length === 1 ? 'it is' : 'they are'}: save or undo them, then Goto again.`)
        return { moved, kept, missing, target, terminal }
    }

    const open = async (asked) => {
        const repo = service.known().repos.find((candidate) => candidate.path === asked.repo && !candidate.error)
        if (!repo) throw new Error('That repository is not one the page showed: the page asks again.')
        const lane = asked.lane ? repo.lanes.find((candidate) => candidate.name === asked.lane && candidate.exists) : null
        if (asked.lane && !lane) throw new Error(`There is no lane called ${asked.lane} in ${repo.id} now.`)
        switch (asked.what) {
            case 'goto': return gotoCheckout(repo, lane)
            case 'lane':
                if (!lane) throw new Error('Which lane?')
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(lane.path), { forceNewWindow: true })
                return true
            case 'agent': {
                if (!lane) throw new Error('An agent starts in a lane: which one?')
                const id = await pickAgent(lane)
                return id ? startAgent(repo, lane, id) : false
            }
            case 'agent-terminal': {
                // An agent the page drew, by its report's key: only one the reports name now.
                const agent = service.agents().find((candidate) => candidate.key === asked.key && candidate.repo === repo.id)
                if (!agent) throw new Error('That agent has stopped, or says nothing now.')
                return showAgent(agent)
            }
            case 'changes': {
                if (!lane) throw new Error('Which lane?')
                const changes = await service.laneChanges(repo.path, lane.name)
                if (!changes) throw new Error(`Could not read what ${lane.name} changed.`)
                return showChanges(`${lane.name} against ${repo.integrationBranch}`, rowsOf(repo, changes.files, { beforeSha: changes.base, checkout: changes.checkout }))
            }
            case 'file': {
                if (!lane) throw new Error('Which lane?')
                const changes = await service.laneChanges(repo.path, lane.name)
                if (!changes) throw new Error(`Could not read what ${lane.name} changed.`)
                const file = changes.files.find((candidate) => candidate.path === asked.path)
                    ?? { status: 'M', path: String(asked.path ?? '') }
                const [label, before, after] = rowsOf(repo, [file], { beforeSha: changes.base, checkout: changes.checkout })[0]
                await vscode.commands.executeCommand('vscode.diff', before ?? atEmpty(label), after ?? atEmpty(label),
                    `${path.basename(file.path)} · ${lane.name} against ${repo.integrationBranch}`)
                return true
            }
            case 'conflicts': {
                // The files a rebase stopped on, opened where each conflict can be accepted one way, the other or both:
                // only files git says are unmerged, whatever the page asked for.
                if (!lane) throw new Error('Which lane?')
                const unmerged = lane.conflicts ?? []
                const files = asked.path ? unmerged.filter((file) => file === asked.path) : unmerged
                if (!files.length) throw new Error(`${lane.name} has no conflicts left to open: Continue carries on.`)
                for (const file of files) {
                    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(lane.path, file)), { preview: false })
                }
                return true
            }
            case 'file-at': {
                // A file named in a failed step's output, opened at its line: only a file inside the lane, found by
                // the path given or, from a step run in a sub-folder, by the one file in the lane whose path ends so.
                if (!lane) throw new Error('Which lane?')
                const asked_ = String(asked.path ?? '')
                let target = path.resolve(lane.path, asked_)
                const inside = (file) => file.startsWith(lane.path + path.sep)
                if (!inside(target) || !fs.existsSync(target)) {
                    const tail = asked_.replace(/^(\.{1,2}\/)+/, '')
                    const listed = await service.filesEndingWith(repo.path, lane.name, tail)
                    if (listed.length !== 1) throw new Error(listed.length ? `${listed.length} files in ${lane.name} end with ${tail}.` : `There is no ${asked_} in ${lane.name}.`)
                    target = path.join(lane.path, listed[0])
                }
                const line = Math.max(1, Number(asked.line) || 1) - 1
                const column = Math.max(1, Number(asked.column) || 1) - 1
                await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(target), { selection: new vscode.Range(line, column, line, column), preview: false })
                return true
            }
            case 'uncommitted': {
                const left = await service.uncommitted(repo.path, asked.checkout)
                if (!left) throw new Error('That checkout is not one the page showed.')
                if (asked.path) {
                    // One file, from the list of what is uncommitted: its own diff, before and now.
                    const file = left.files.find((candidate) => candidate.path === asked.path)
                    if (!file) throw new Error(`${asked.path} is not uncommitted in ${asked.name ?? path.basename(left.checkout)} now.`)
                    const [label, before, after] = rowsOf(repo, [file], { beforeSha: left.head, checkout: left.checkout })[0]
                    await vscode.commands.executeCommand('vscode.diff', before ?? atEmpty(label), after ?? atEmpty(label), `${path.basename(file.path)} · uncommitted`)
                    return true
                }
                return showChanges(`${asked.name ?? path.basename(left.checkout)}: uncommitted`, rowsOf(repo, left.files, { beforeSha: left.head, checkout: left.checkout }))
            }
            case 'commit': {
                const changed = await service.commitChanges(repo.path, asked.sha)
                if (!changed) throw new Error('That is not a commit of this repository.')
                const commit = commitNamed(repo, changed.sha)
                const title = commit ? `${commit.short} ${commit.subject}` : changed.sha.slice(0, 7)
                // One file of it, from the details pane, or all of them.
                const files = asked.path ? changed.files.filter((file) => file.path === asked.path) : changed.files
                if (!changed.parent) {
                    return showChanges(title, files.map((file) => { const after = atCommit(repo, changed.sha, file.path, repo.path); return [after, undefined, after] }))
                }
                return showChanges(title, rowsOf(repo, files, { beforeSha: changed.parent, afterSha: changed.sha, checkout: repo.path }))
            }
            default:
                throw new Error(`The page asked to open "${String(asked.what)}", which the extension does not do.`)
        }
    }

    // -----------------------------------------------------------------------
    // the page's messages
    // -----------------------------------------------------------------------

    const answer = async (method, params) => {
        switch (method) {
            case 'state': {
                const state = await service.state()
                lastSent = JSON.stringify({ ...state, at: 0 })
                updateBar()
                heardAgents(state.agents ?? [])
                return state
            }
            case 'press': {
                const pressed = await service.press(params)
                schedule(true)
                return pressed
            }
            case 'job': return service.job(String(params.id ?? ''), params.from)
            case 'cancel': return service.cancel(String(params?.id ?? ''))
            case 'commit': {
                // A commit's words and files, for the details pane: only a commit of a repository LaneKit reads.
                const repo = service.known().repos.find((candidate) => candidate.path === params?.repo && !candidate.error)
                if (!repo) throw new Error('That is not a repository LaneKit reads.')
                const details = await service.commitDetails(repo.path, String(params.sha ?? ''))
                if (!details) throw new Error('That is not a commit of this repository.')
                return details
            }
            case 'copy': {
                // A commit's hash, to the clipboard: a webview cannot always reach it itself.
                const text = String(params?.text ?? '')
                if (!/^[0-9a-f]{4,64}$/.test(text)) throw new Error('Only a commit\'s hash is copied from here.')
                await vscode.env.clipboard.writeText(text)
                return true
            }
            case 'open': return open(params)
            case 'tab': {
                // A repository in a tab of its own: only one LaneKit reads.
                const repo = service.known().repos.find((candidate) => candidate.id === params?.repo)
                if (!repo) throw new Error('That is not a repository LaneKit reads.')
                showOwn(repo.id)
                return true
            }
            default: throw new Error(`The page asked for "${String(method)}", which the extension does not do.`)
        }
    }

    const onMessage = async (message, page) => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'ready') {
            lastSent = null
            hereSaid = null   // a page just made has not heard where the editor is
            // What was last read, at once, so a tab just opened is not "Reading the lanes…" for the read's length.
            const known = service.stateKnown()
            if (known) page.webview.postMessage({ type: 'state', state: known })
            updateBar()
            // A lane asked for before this page could hear it: said now, and then forgotten.
            if (pendingFocus && (pendingFocus.page ? pendingFocus.page === page : pendingFocus.surface === page.surface)) {
                page.webview.postMessage({ type: 'focus', repo: pendingFocus.repo, lane: pendingFocus.lane })
                pendingFocus = null
            }
            schedule(true)
            return
        }
        if (message.type === 'showing') {
            // What the page shows, for its title: a repository's name on its tab, or beside the side bar's.
            page.showing = typeof message.repo === 'string' && message.repo ? message.repo : null
            const title = typeof message.title === 'string' && message.title ? message.title.slice(0, 80) : null
            if (page.made) page.made.title = title ? `${title} · LaneKit` : 'LaneKit'
            else if (page.view) page.view.description = title ?? undefined
            return
        }
        if (message.type !== 'request') return
        try {
            page.webview.postMessage({ type: 'reply', id: message.id, ok: true, value: await answer(message.method, message.params ?? {}) })
        } catch (error) {
            page.webview.postMessage({ type: 'reply', id: message.id, ok: false, error: error.message })
        }
    }

    // -----------------------------------------------------------------------
    // the status bar: the lane the file in front of you is in, and what it needs
    // -----------------------------------------------------------------------

    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40)
    subscriptions.push(bar)
    // The file in front; with none (the LaneKit tab itself, a diff, a terminal), the last one that was, so the
    // bar keeps naming the lane you were in while you look at its page; before any, the first folder open.
    let lastFile = null
    const whereNow = () => {
        const editor = vscode.window.activeTextEditor
        if (editor?.document?.uri?.scheme === 'file') return (lastFile = editor.document.uri.fsPath)
        if (!editor && lastFile) return lastFile
        const first = (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.scheme === 'file')
        return first?.uri.fsPath ?? null
    }
    // Where the editor is, told to every page as it moves, for its "You are here".
    let hereSaid = null
    const sayHere = (at) => {
        const now = JSON.stringify(at ? { repo: at.repo.id, lane: at.lane?.name ?? null } : null)
        if (now === hereSaid) return
        hereSaid = now
        post({ type: 'here', ...(at ? { repo: at.repo.id, lane: at.lane?.name ?? null } : { repo: null }) })
    }
    const updateBar = () => {
        const file = whereNow()
        const at = file ? service.laneAt(file) : null
        sayHere(at)
        if (!at) { bar.hide(); return }
        if (at.lane) {
            bar.text = `$(git-branch) ${at.lane.name} · ${wordOf(at.lane)}`
            bar.tooltip = `Lane ${at.lane.name} of ${at.repo.id}, on branch ${at.lane.branch}: what to do with it.`
            bar.command = { command: 'lanekit.laneMenu', title: 'LaneKit: this lane', arguments: [{ repo: at.repo.id, lane: at.lane.name }] }
        } else {
            const live = at.repo.lanes.filter((lane) => lane.kind === 'working' || lane.kind === 'fresh').length
            bar.text = `$(list-tree) ${live} ${live === 1 ? 'lane' : 'lanes'}`
            bar.tooltip = `${at.repo.id}'s main checkout: its lanes, and a new one.`
            bar.command = { command: 'lanekit.laneMenu', title: 'LaneKit: this repository', arguments: [{ repo: at.repo.id }] }
        }
        bar.show()
    }

    // -----------------------------------------------------------------------
    // the palette: the same presses, from the keyboard, on the lane in front of you
    // -----------------------------------------------------------------------

    const readIfNever = async () => { if (!service.known().at) await service.state() }
    const allLanes = () => service.known().repos.filter((repo) => !repo.error)
        .flatMap((repo) => repo.lanes.filter((lane) => lane.exists).map((lane) => ({ repo, lane })))

    /** The lane an argument names, else the one the file in front is in, else one picked. */
    const laneFor = async (argument, title, which = () => true) => {
        await readIfNever()
        if (argument?.repo && argument?.lane) {
            const found = allLanes().find((x) => x.repo.id === argument.repo && x.lane.name === argument.lane)
            if (found) return found
        }
        const file = whereNow()
        const here = file ? service.laneAt(file) : null
        if (here?.lane && which(here.lane)) return { repo: here.repo, lane: here.lane }
        const choices = allLanes().filter((x) => which(x.lane))
        if (!choices.length) { vscode.window.showInformationMessage('LaneKit: no lane to choose from here.'); return null }
        const picked = await vscode.window.showQuickPick(choices.map((x) => ({
            label: x.lane.name, description: x.repo.id, detail: wordOf(x.lane), x
        })), { title, matchOnDescription: true })
        return picked?.x ?? null
    }

    const refused = (pressed) => {
        if (pressed.status < 400) return false
        vscode.window.showErrorMessage(`LaneKit: ${pressed.body?.error ?? `refused (${pressed.status})`}`)
        return true
    }
    const pressFromPalette = async (request) => {
        const pressed = await service.press(request)
        if (refused(pressed)) return null
        fromPalette.add(pressed.body.id)
        schedule(true)
        return pressed.body
    }
    const isWorking = (lane) => lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)

    /** A lane's own menu, from the status bar: what can be done with the lane (or the main checkout) in front. */
    const laneMenu = async (argument) => {
        await readIfNever()
        const file = whereNow()
        const here = file ? service.laneAt(file) : null
        const repo = service.known().repos.find((candidate) => candidate.id === (argument?.repo ?? here?.repo?.id) && !candidate.error)
        if (!repo) { vscode.window.showInformationMessage('LaneKit: no repository with lanes is in front.'); return }
        const lane = argument?.lane ? repo.lanes.find((candidate) => candidate.name === argument.lane && candidate.exists) : argument ? null : here?.lane ?? null
        const at = { repo: repo.id, lane: lane?.name }
        const items = []
        const item = (label, detail, run) => items.push({ label, detail, run })
        item('$(list-tree) Show in LaneKit', `${inTab() ? 'its tab' : 'the side bar'}, with this lane marked`, () => reveal(lane ? at : null))
        if (service.known().repos.length > 1) item('$(link-external) A tab of its own', `${repo.name ?? repo.id} alone, in a LaneKit tab with its name`, () => showOwn(repo.id))
        if (lane) item('$(arrow-right) Goto', here?.lane?.name === lane.name ? `your terminal in ${lane.name}, in front` : `move here: the files you have open reopen from ${lane.name}, and your terminal follows`, () => gotoCheckout(repo, lane))
        if (!lane) item('$(arrow-right) Goto main', here?.lane ? `the files you have open reopen from ${repo.id}'s main checkout, and your terminal follows` : `your terminal in ${repo.id}'s main checkout, in front`, () => gotoCheckout(repo, null))
        if (lane) {
            const working = lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)
            if (working || lane.dirty) item('$(diff) Changes', `everything ${lane.name} holds that ${repo.integrationBranch} does not`, () => open({ what: 'changes', repo: repo.path, lane: lane.name }))
            item('$(sparkle) Start agent…', `Claude Code or OpenCode, in a terminal named for ${lane.name}`, () => commands['lanekit.startAgent'](at))
            if (working) item('$(check) Gate…', wordOf(lane), () => commands['lanekit.gate'](at))
            if (working) item('$(git-merge) Land…', `into ${repo.integrationBranch}, after a check`, () => commands['lanekit.land'](at))
            if (lane.behind > 0 && !lane.operation) item('$(sync) Rebase…', `${lane.behind} behind ${repo.integrationBranch}`, () => commands['lanekit.rebase'](at))
            if (lane.kind === 'working' && (!lane.upstream || lane.upstream.ahead > 0)) item('$(cloud-upload) Push', lane.upstream ? `${lane.upstream.ahead} not pushed` : 'not pushed yet', () => commands['lanekit.push'](at))
            item('$(add) New lane from here…', `on top of ${lane.branch}`, () => commands['lanekit.newLaneHere'](at))
            if (lane.aside) item('$(archive) Bring back', 'into the landing order and the log again', () => pressFromPalette({ repo: repo.id, verb: 'resume', lane: lane.name }))
            else item('$(archive) Set aside', 'out of the landing order and the log, nothing removed', () => pressFromPalette({ repo: repo.id, verb: 'aside', lane: lane.name }))
            if (!lane.operation) item('$(trash) Drop…', 'remove its folder, keep its branch', async () => {
                const where = !lane.ahead ? 'It has no commits of its own.' : !lane.upstream ? `It was never pushed: its ${lane.ahead} commits stay only in the branch ${lane.branch} here.` : `Its branch ${lane.branch} stays, and origin has a copy.`
                const go = await vscode.window.showWarningMessage(`Drop ${lane.name}? Its folder goes and what serves on its port stops; its branch stays.`, { modal: true, detail: `${where} lane new ${lane.name} --existing brings it back.` }, 'Drop it')
                if (go === 'Drop it' && await pressFromPalette({ repo: repo.id, verb: 'drop', lane: lane.name })) output.show(true)
            })
            item('$(multiple-windows) Open in a new window', lane.path, () => open({ what: 'lane', repo: repo.path, lane: lane.name }))
        } else {
            item('$(add) New lane…', `from ${repo.integrationBranch}`, () => commands['lanekit.newLaneHere']({ repo: repo.id }))
            const up = repo.main?.upstream
            if (up?.behind && !up.ahead) item(`$(repo-pull) Pull ${up.behind}`, `fast-forward ${repo.integrationBranch} to ${up.name}`, () => pressFromPalette({ repo: repo.id, verb: 'pull' }).then((job) => job && output.show(true)))
            item('$(cloud-download) Fetch now', `what origin has, for ${repo.id}`, () => pressFromPalette({ repo: repo.id, verb: 'fetch' }))
        }
        const picked = await vscode.window.showQuickPick(items, { title: lane ? `Lane ${lane.name}` : `${repo.id}'s main checkout`, matchOnDetail: true })
        if (picked) await picked.run()
    }

    const commands = {
        'lanekit.laneMenu': (argument) => laneMenu(argument),
        'lanekit.newLaneHere': async (argument) => {
            await readIfNever()
            const file = whereNow()
            const here = file ? service.laneAt(file) : null
            const repo = service.known().repos.find((candidate) => candidate.id === (argument?.repo ?? here?.repo?.id) && !candidate.error)
            if (!repo) { vscode.window.showInformationMessage('LaneKit: no repository with lanes is in front.'); return }
            const from = argument ? repo.lanes.find((candidate) => candidate.name === argument.lane && candidate.exists) : here?.lane
            const base = from?.branch ?? repo.integrationBranch
            const name = await vscode.window.showInputBox({
                title: `New lane in ${repo.id}, from ${base}`,
                prompt: from ? `It starts on top of ${from.name}'s work, and lands after it.` : `It starts from ${base} as it is now.`,
                placeHolder: 'new-lane-name',
                validateInput: (value) => NAME.test(value) ? null : 'Lowercase letters, digits and dashes, starting with a letter or a digit.'
            })
            if (!name) return
            if (await pressFromPalette({ repo: repo.id, verb: 'new', name, ...(from ? { base } : {}) })) output.show(true)
        },
        'lanekit.rebase': async (argument) => {
            const x = await laneFor(argument, 'Rebase which lane?', (lane) => lane.behind > 0 && !lane.operation)
            if (!x) return
            const go = await vscode.window.showWarningMessage(`Rebase ${x.lane.name} onto ${x.repo.integrationBranch}?`, {
                modal: true, detail: `It replays its commits on ${x.repo.integrationBranch} as it is now (${x.lane.behind} behind). If they conflict it stops, names the files, and LaneKit opens them.`
            }, 'Rebase it')
            if (go === 'Rebase it' && await pressFromPalette({ repo: x.repo.id, verb: 'rebase', lane: x.lane.name })) output.show(true)
        },
        'lanekit.push': async (argument) => {
            const x = await laneFor(argument, 'Push which lane?', (lane) => lane.kind === 'working')
            if (!x) return
            let force = false
            if (x.lane.upstream?.behind > 0) {
                const go = await vscode.window.showWarningMessage(`Replace origin's ${x.lane.branch}?`, {
                    modal: true, detail: `It was rebased since it was pushed. --force-with-lease replaces origin's copy only if nobody pushed there since this lane last fetched.`
                }, 'Replace it')
                if (go !== 'Replace it') return
                force = true
            }
            if (await pressFromPalette({ repo: x.repo.id, verb: 'push', lane: x.lane.name, force })) output.show(true)
        },
        'lanekit.show': (focus) => show(focus),
        'lanekit.showRepository': async (argument) => {
            await readIfNever()
            const repos = service.known().repos
            if (!repos.length) { vscode.window.showInformationMessage('LaneKit: no repository with a lane.config.json is open here.'); return }
            const id = typeof argument?.repo === 'string' ? argument.repo
                : repos.length === 1 ? repos[0].id
                    : (await vscode.window.showQuickPick(repos.map((candidate) => ({ label: candidate.name ?? candidate.id, description: candidate.path, id: candidate.id })),
                        { title: 'Show which repository in a tab of its own?', matchOnDescription: true }))?.id
            if (id && repos.some((candidate) => candidate.id === id)) showOwn(id)
        },
        'lanekit.reveal': (focus) => reveal(focus),
        'lanekit.refresh': () => schedule(true),
        'lanekit.newLane': async () => {
            await readIfNever()
            const repos = service.known().repos.filter((repo) => !repo.error)
            if (!repos.length) { vscode.window.showInformationMessage('LaneKit: no repository with a lane.config.json is open here.'); return }
            const repo = repos.length === 1 ? repos[0]
                : (await vscode.window.showQuickPick(repos.map((candidate) => ({ label: candidate.id, description: candidate.path, repo: candidate })), { title: 'New lane in' }))?.repo
            if (!repo) return
            const name = await vscode.window.showInputBox({
                title: `New lane in ${repo.id}`,
                prompt: `It becomes a folder beside ${repo.id} and a branch, made from ${repo.integrationBranch}.`,
                placeHolder: 'new-lane-name',
                validateInput: (value) => NAME.test(value) ? null : 'Lowercase letters, digits and dashes, starting with a letter or a digit.'
            })
            if (!name) return
            if (await pressFromPalette({ repo: repo.id, verb: 'new', name })) output.show(true)
        },
        'lanekit.gate': async (argument) => {
            const x = await laneFor(argument, 'Gate which lane?', isWorking)
            if (!x) return
            const go = await vscode.window.showWarningMessage(`Gate ${x.lane.name}?`, {
                modal: true,
                detail: `It rebases ${x.lane.branch} onto ${x.repo.integrationBranch}, then runs the tier its changes earn${x.lane.queue?.tier ? ` (tier ${x.lane.queue.tier})` : ''}. It never merges.`
            }, 'Gate it')
            if (go === 'Gate it' && await pressFromPalette({ repo: x.repo.id, verb: 'gate', lane: x.lane.name })) output.show(true)
        },
        'lanekit.land': async (argument) => {
            const x = await laneFor(argument, 'Land which lane?', isWorking)
            if (!x) return
            const check = await service.press({ repo: x.repo.id, verb: 'land', lane: x.lane.name, dryRun: true })
            if (refused(check)) return
            const checked = await finished(check.body.id)
            if (checked.code !== 0) {
                const choice = await vscode.window.showErrorMessage(`LaneKit: ${x.lane.name} cannot land yet.`, 'Show why')
                if (choice === 'Show why') output.show(true)
                return
            }
            const go = await vscode.window.showWarningMessage(`Land ${x.lane.name}?`, {
                modal: true,
                detail: `The check passed. It merges into ${x.repo.integrationBranch} with --no-ff, then removes the lane's folder and stops its server; the branch is kept. Nothing is pushed.`
            }, 'Land it')
            if (go === 'Land it' && await pressFromPalette({ repo: x.repo.id, verb: 'land', lane: x.lane.name })) output.show(true)
        },
        'lanekit.changes': async (argument) => {
            const x = await laneFor(argument, 'Whose changes?', (lane) => isWorking(lane) || lane.dirty > 0)
            if (x) await open({ what: 'changes', repo: x.repo.path, lane: x.lane.name })
        },
        'lanekit.startAgent': async (argument) => {
            const x = await laneFor(argument, 'Start an agent in which lane?')
            if (x) await open({ what: 'agent', repo: x.repo.path, lane: x.lane.name })
        },
        'lanekit.openLane': async () => {
            await readIfNever()
            const x = await laneFor(null, 'Open which lane in a new window?', () => true)
            if (x) await open({ what: 'lane', repo: x.repo.path, lane: x.lane.name })
        },
        'lanekit.reportAgents': async () => {
            await context.globalState?.update?.('lanekit.reportAgents', 'yes')
            addReporters(false)
        },
        'lanekit.agents': async () => {
            const agents = service.known().at ? service.agents() : []
            if (!agents.length) { vscode.window.showInformationMessage('LaneKit: no agent is at work in a repository LaneKit reads.'); return }
            const order = { 'needs-you': 0, failed: 1, running: 2, thinking: 2, done: 3, ready: 4 }
            const picked = await vscode.window.showQuickPick(agents.slice().sort((a, b) => order[a.state] - order[b.state]).map((agent) => ({
                label: agentName(agent),
                description: `${STATE_WORDS[agent.state]}${agent.tool ? ` · ${agent.tool}` : ''}`,
                detail: agent.lane ? `lane ${agent.lane} of ${agent.repo}` : agent.repo ? `${agent.repo}'s main checkout` : `${agent.cwd ?? agent.where}, which has no lanes`,
                agent
            })), { title: 'The agents at work: pick one for its terminal', matchOnDetail: true })
            if (picked) await showAgent(picked.agent)
        },
        'lanekit.goto': async () => {
            await readIfNever()
            const file = whereNow()
            const here = file ? service.laneAt(file) : null
            const choices = allLanes().filter((x) => x.lane.exists)
            const mains = service.known().repos.filter((repo) => !repo.error)
            const items = [
                ...mains.map((repo) => ({ label: repo.integrationBranch, description: `${repo.id}'s main checkout`, detail: 'Goto main', go: () => gotoCheckout(repo, null) })),
                ...choices.map((x) => ({ label: x.lane.name, description: x.repo.id, detail: wordOf(x.lane), go: () => gotoCheckout(x.repo, x.lane) }))
            ]
            if (!items.length) { vscode.window.showInformationMessage('LaneKit: no lane to go to.'); return }
            const picked = await vscode.window.showQuickPick(items, { title: 'Go to which lane? The files and the terminal you have open move to it', matchOnDescription: true })
            if (picked) await picked.go()
        }
    }
    for (const [id, run] of Object.entries(commands)) {
        subscriptions.push(vscode.commands.registerCommand(id, async (...args) => {
            try {
                return await run(...args)
            } catch (error) {
                vscode.window.showErrorMessage(`LaneKit: ${error.message}`)
                return undefined
            }
        }))
    }

    schedule(true)

    return {
        commands: Object.keys(commands),
        service,
        panel: () => panel,
        tabs: () => tabs(),
        sidebar: () => sidebar,
        dispose: () => { disposed = true; clearTimeout(timer); clearTimeout(jobPing); clearInterval(agentsTimer); service.dispose() }
    }
}
