/**
 * LaneKit's editor extension at work, inside VS Code: the lanes page as a tab of the editor, the
 * service it asks (lib/service.mjs) running here in the editor, and everything the page
 * points at opened where a developer already is — a commit's changes, a lane's, a file's
 * diff, what is uncommitted, a lane's folder, a terminal in it. The shape of Sapling's
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

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { createService } from '../lib/service.mjs'

export const VIEW = 'lanekit.lanes'
export const SIDEBAR = 'lanekit.sidebar'
export const SCHEME = 'lanekit'
const EVERY_VISIBLE_MS = 4000
const EVERY_HIDDEN_MS = 20000
const EVERY_IDLE_MS = 60000
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

/** What the side bar's view holds where LaneKit opens in a tab: a line and a link, no script and no second page.
    It is seen for a moment when the icon is pressed, or for good where the side bar cannot be closed. */
export const signpostHtml = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
body { margin: 0; padding: 10px 14px; color: var(--vscode-descriptionForeground); font: var(--vscode-font-size, 13px)/1.5 var(--vscode-font-family, sans-serif); }
a { color: var(--vscode-textLink-foreground); }
code { font-family: var(--vscode-editor-font-family, monospace); }
</style></head><body>
<p>LaneKit opens in an editor tab. <a href="command:lanekit.show">Open LaneKit</a></p>
<p>To keep it here in the side bar instead, set <code>lanekit.opensIn</code> to <code>sideBar</code>.</p>
</body></html>`

/** The page's HTML for a webview: its own files by the webview's addresses, and nothing else allowed. */
export const pageHtml = (webDir, webview, fileUri, { nonce = crypto.randomBytes(18).toString('base64'), surface = 'tab' } = {}) => {
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
    return html.replace(/<html\b/, `<html data-surface="${surface === 'sidebar' ? 'sidebar' : 'tab'}"`)
}

export const activate = async (context, vscode, { root }) => {
    const webDir = path.join(root, 'web')
    const subscriptions = context.subscriptions
    const output = vscode.window.createOutputChannel('LaneKit')
    subscriptions.push(output)

    const foldersNow = () => [
        ...(vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
        ...(vscode.workspace.getConfiguration('lanekit').get('folders') ?? []).filter((dir) => typeof dir === 'string' && dir)
    ]
    const service = createService({ dirs: foldersNow(), reader: 'worker', packageRoot: root })

    // -----------------------------------------------------------------------
    // the pages: the side bar's, there by default, and a tab, for room
    // -----------------------------------------------------------------------

    // Every page open, each its own webview. What changed and a job's news go to all of them; a reply goes
    // only to the page that asked, since each page numbers its own questions from one.
    const pages = new Set()
    let panel = null
    let sidebar = null
    /** Where LaneKit opens, from its icon and from everything that asks to show it: an editor tab, by default (the
        owner, 30 Sep: the icon should open the page in the editor, not the narrow side bar), or the side bar itself
        where lanekit.opensIn says sideBar. */
    const inTab = () => vscode.workspace.getConfiguration('lanekit').get('opensIn') !== 'sideBar'
    let pendingFocus = null   // { surface, repo, lane }: asked for before that page could hear it
    let lastSent = null
    const post = (message) => { for (const page of pages) page.webview.postMessage(message) }
    const anyVisible = () => [...pages].some((page) => page.visible())

    const wire = (page) => {
        page.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(webDir)] }
        page.webview.html = pageHtml(webDir, page.webview, (file) => vscode.Uri.file(file), { surface: page.surface })
        pages.add(page)
        lastSent = null
        page.webview.onDidReceiveMessage((message) => onMessage(message, page), null, subscriptions)
    }
    /** A lane to mark on a page: at once on a page that is listening, when it says it is ready on one just made. */
    const focusIn = (surface, focus, fresh) => {
        if (!focus?.repo || !focus?.lane) return
        const page = surface === 'tab' ? panel : sidebar
        if (fresh || !page) pendingFocus = { surface, repo: focus.repo, lane: focus.lane }
        else page.webview.postMessage({ type: 'focus', repo: focus.repo, lane: focus.lane })
    }

    const adopt = (made) => {
        const page = { surface: 'tab', webview: made.webview, visible: () => made.visible, reveal: () => made.reveal() }
        panel = page
        wire(page)
        made.onDidChangeViewState(() => schedule(true), null, subscriptions)
        made.onDidDispose(() => { pages.delete(page); if (panel === page) panel = null; schedule() }, null, subscriptions)
    }

    /** The full page in a tab of its own: room for a long log, or a second look beside the side bar's. */
    const show = (focus) => {
        const fresh = !panel
        if (panel) panel.reveal()
        else {
            adopt(vscode.window.createWebviewPanel(VIEW, 'LaneKit', vscode.ViewColumn.Active, {
                enableScripts: true,
                // Its drawer, its open confirmations and where it was scrolled survive a switch of tabs.
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(webDir)]
            }))
        }
        focusIn('tab', focus, fresh)
        schedule(true)
    }

    subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW, {
        deserializeWebviewPanel: async (restored) => { adopt(restored); schedule(true) }
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
    const toTab = async () => {
        show()
        await vscode.commands.executeCommand('workbench.action.closeSidebar')
    }
    subscriptions.push(vscode.window.registerWebviewViewProvider(SIDEBAR, {
        resolveWebviewView: (view) => {
            sideView = view
            fillSide(view)
            view.onDidChangeVisibility(() => {
                if (view.visible && inTab()) void toTab()
                schedule(true)
            }, null, subscriptions)
            view.onDidDispose(() => {
                if (sidebar?.view === view) { pages.delete(sidebar); sidebar = null }
                if (sideView === view) sideView = null
                schedule()
            }, null, subscriptions)
            if (view.visible && inTab()) void toTab()
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
    service.events.on('output', (job, text) => {
        output.append(text)
        pingedJob = job
        if (!jobPing) jobPing = setTimeout(() => { jobPing = null; post({ type: 'job', id: pingedJob.id, job: pingedJob }) }, 100)
    })
    service.events.on('fetched', () => schedule(true))
    // A press that ends while no LaneKit page is in sight says how it ended, whoever pressed it, with the lane and
    // its output a click away.
    const SAID = { gate: ['passed', 'failed'], land: ['landed', 'did not land'], rebase: ['rebased', 'stopped'], push: ['pushed', 'was refused'],
        pr: ['has a pull request', 'has no pull request'], pull: ['pulled', 'did not pull'], new: ['is made', 'was not made'], sweep: ['swept', 'was not swept'] }
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

    const open = async (asked) => {
        const repo = service.known().repos.find((candidate) => candidate.path === asked.repo && !candidate.error)
        if (!repo) throw new Error('That repository is not one the page showed: the page asks again.')
        const lane = asked.lane ? repo.lanes.find((candidate) => candidate.name === asked.lane && candidate.exists) : null
        if (asked.lane && !lane) throw new Error(`There is no lane called ${asked.lane} in ${repo.id} now.`)
        switch (asked.what) {
            case 'lane':
                if (!lane) throw new Error('Which lane?')
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(lane.path), { forceNewWindow: true })
                return true
            case 'terminal': {
                const terminal = vscode.window.createTerminal({ name: lane ? `lane ${lane.name}` : repo.id, cwd: lane?.path ?? repo.path })
                terminal.show()
                return true
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
                if (!changed.parent) {
                    return showChanges(title, changed.files.map((file) => { const after = atCommit(repo, changed.sha, file.path, repo.path); return [after, undefined, after] }))
                }
                return showChanges(title, rowsOf(repo, changed.files, { beforeSha: changed.parent, afterSha: changed.sha, checkout: repo.path }))
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
                return state
            }
            case 'press': {
                const pressed = await service.press(params)
                schedule(true)
                return pressed
            }
            case 'job': return service.job(String(params.id ?? ''), params.from)
            case 'open': return open(params)
            default: throw new Error(`The page asked for "${String(method)}", which the extension does not do.`)
        }
    }

    const onMessage = async (message, page) => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'ready') {
            lastSent = null
            hereSaid = null   // a page just made has not heard where the editor is
            updateBar()
            // A lane asked for before this page could hear it: said now, and then forgotten.
            if (pendingFocus?.surface === page.surface) {
                page.webview.postMessage({ type: 'focus', repo: pendingFocus.repo, lane: pendingFocus.lane })
                pendingFocus = null
            }
            schedule(true)
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
        if (lane) {
            const working = lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)
            if (working || lane.dirty) item('$(diff) Changes', `everything ${lane.name} holds that ${repo.integrationBranch} does not`, () => open({ what: 'changes', repo: repo.path, lane: lane.name }))
            item('$(terminal) Terminal', `a terminal in ${lane.name}`, () => open({ what: 'terminal', repo: repo.path, lane: lane.name }))
            if (working) item('$(check) Gate…', wordOf(lane), () => commands['lanekit.gate'](at))
            if (working) item('$(git-merge) Land…', `into ${repo.integrationBranch}, after a check`, () => commands['lanekit.land'](at))
            if (lane.behind > 0 && !lane.operation) item('$(sync) Rebase…', `${lane.behind} behind ${repo.integrationBranch}`, () => commands['lanekit.rebase'](at))
            if (lane.kind === 'working' && (!lane.upstream || lane.upstream.ahead > 0)) item('$(cloud-upload) Push', lane.upstream ? `${lane.upstream.ahead} not pushed` : 'not pushed yet', () => commands['lanekit.push'](at))
            item('$(add) New lane from here…', `on top of ${lane.branch}`, () => commands['lanekit.newLaneHere'](at))
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
        'lanekit.terminal': async (argument) => {
            const x = await laneFor(argument, 'A terminal in which lane?')
            if (x) await open({ what: 'terminal', repo: x.repo.path, lane: x.lane.name })
        },
        'lanekit.openLane': async () => {
            await readIfNever()
            const x = await laneFor(null, 'Open which lane?', () => true)
            if (x) await open({ what: 'lane', repo: x.repo.path, lane: x.lane.name })
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
        sidebar: () => sidebar,
        dispose: () => { disposed = true; clearTimeout(timer); clearTimeout(jobPing); service.dispose() }
    }
}
