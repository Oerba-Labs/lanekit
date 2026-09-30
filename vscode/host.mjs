/**
 * The Lanes extension's work, inside VS Code: the lanes page as a tab of the editor, the
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

/** The page's HTML for a webview: its own files by the webview's addresses, and nothing else allowed. */
export const pageHtml = (webDir, webview, fileUri, nonce = crypto.randomBytes(18).toString('base64')) => {
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
    return html
}

export const activate = async (context, vscode, { root }) => {
    const webDir = path.join(root, 'web')
    const subscriptions = context.subscriptions
    const output = vscode.window.createOutputChannel('Lanes')
    subscriptions.push(output)

    const foldersNow = () => [
        ...(vscode.workspace.workspaceFolders ?? []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath),
        ...(vscode.workspace.getConfiguration('lanekit').get('folders') ?? []).filter((dir) => typeof dir === 'string' && dir)
    ]
    const service = createService({ dirs: foldersNow(), reader: 'worker', packageRoot: root })

    // -----------------------------------------------------------------------
    // the tab
    // -----------------------------------------------------------------------

    let panel = null
    let pendingFocus = null
    let lastSent = null
    const post = (message) => { if (panel) panel.webview.postMessage(message) }

    const adopt = (made) => {
        panel = made
        made.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(webDir)] }
        made.webview.html = pageHtml(webDir, made.webview, (file) => vscode.Uri.file(file))
        lastSent = null
        made.webview.onDidReceiveMessage((message) => onMessage(message), null, subscriptions)
        made.onDidChangeViewState(() => schedule(true), null, subscriptions)
        made.onDidDispose(() => { if (panel === made) panel = null; schedule() }, null, subscriptions)
    }

    const show = (focus) => {
        const fresh = !panel
        if (panel) panel.reveal()
        else {
            adopt(vscode.window.createWebviewPanel(VIEW, 'Lanes', vscode.ViewColumn.Active, {
                enableScripts: true,
                // Its drawer, its open confirmations and where it was scrolled survive a switch of tabs.
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.file(webDir)]
            }))
        }
        if (focus?.repo && focus?.lane) {
            // An open page hears it now; a page just made hears it when it says it is ready.
            if (fresh) pendingFocus = { repo: focus.repo, lane: focus.lane }
            else post({ type: 'focus', repo: focus.repo, lane: focus.lane })
        }
        schedule(true)
    }

    subscriptions.push(vscode.window.registerWebviewPanelSerializer(VIEW, {
        deserializeWebviewPanel: async (restored) => { adopt(restored); schedule(true) }
    }))

    // -----------------------------------------------------------------------
    // reading: when the tab is looked at, when a file is saved, after a press
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
        } catch (error) {
            output.appendLine(`Reading the lanes failed: ${error.message}`)
        } finally {
            reading = false
            if (readAgain) { readAgain = false; tick() } else schedule(false, state)
        }
    }

    const schedule = (soon = false, state = null) => {
        if (disposed) return
        clearTimeout(timer)
        const idle = !panel && state && !state.repos.length
        timer = setTimeout(tick, soon ? 250 : panel?.visible ? EVERY_VISIBLE_MS : idle ? EVERY_IDLE_MS : EVERY_HIDDEN_MS)
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
    service.events.on('output', (job, text) => {
        output.append(text)
        // The page asks for the new output when told there is some: told at most every tenth of a second.
        if (!jobPing) jobPing = setTimeout(() => { jobPing = null; post({ type: 'job', id: job.id }) }, 100)
    })
    service.events.on('done', (job) => {
        post({ type: 'job', id: job.id })
        schedule(true)
        if (fromPalette.delete(job.id) && !panel?.visible) {
            const what = `${job.verb}${job.lane ? ` ${job.lane}` : ''}`
            const said = job.code === 0 ? vscode.window.showInformationMessage(`Lanes: ${what} finished.`, 'Show output')
                : vscode.window.showErrorMessage(`Lanes: ${what} failed (exit ${job.code}).`, 'Show output')
            Promise.resolve(said).then((choice) => { if (choice === 'Show output') output.show(true) })
        }
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
            case 'uncommitted': {
                const left = await service.uncommitted(repo.path, asked.checkout)
                if (!left) throw new Error('That checkout is not one the page showed.')
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

    const onMessage = async (message) => {
        if (!message || typeof message !== 'object') return
        if (message.type === 'ready') {
            lastSent = null
            // A lane asked for before the page could hear it: said now, and then forgotten.
            if (pendingFocus) { post({ type: 'focus', ...pendingFocus }); pendingFocus = null }
            schedule(true)
            return
        }
        if (message.type !== 'request') return
        try {
            post({ type: 'reply', id: message.id, ok: true, value: await answer(message.method, message.params ?? {}) })
        } catch (error) {
            post({ type: 'reply', id: message.id, ok: false, error: error.message })
        }
    }

    // -----------------------------------------------------------------------
    // the status bar: the lane the file in front of you is in, and what it needs
    // -----------------------------------------------------------------------

    const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40)
    subscriptions.push(bar)
    // The file in front; with none (the Lanes tab itself, a diff, a terminal), the last one that was, so the
    // bar keeps naming the lane you were in while you look at its page; before any, the first folder open.
    let lastFile = null
    const whereNow = () => {
        const editor = vscode.window.activeTextEditor
        if (editor?.document?.uri?.scheme === 'file') return (lastFile = editor.document.uri.fsPath)
        if (!editor && lastFile) return lastFile
        const first = (vscode.workspace.workspaceFolders ?? []).find((folder) => folder.uri.scheme === 'file')
        return first?.uri.fsPath ?? null
    }
    const updateBar = () => {
        const file = whereNow()
        const at = file ? service.laneAt(file) : null
        if (!at) { bar.hide(); return }
        if (at.lane) {
            bar.text = `$(git-branch) ${at.lane.name} · ${wordOf(at.lane)}`
            bar.tooltip = `Lane ${at.lane.name} of ${at.repo.id}, on branch ${at.lane.branch}. Show it in Lanes.`
            bar.command = { command: 'lanekit.show', title: 'Show in Lanes', arguments: [{ repo: at.repo.id, lane: at.lane.name }] }
        } else {
            const live = at.repo.lanes.filter((lane) => lane.kind === 'working' || lane.kind === 'fresh').length
            bar.text = `$(list-tree) ${live} ${live === 1 ? 'lane' : 'lanes'}`
            bar.tooltip = `${at.repo.id}'s main checkout. Show every lane in Lanes.`
            bar.command = { command: 'lanekit.show', title: 'Show in Lanes', arguments: [] }
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
        if (!choices.length) { vscode.window.showInformationMessage('Lanes: no lane to choose from here.'); return null }
        const picked = await vscode.window.showQuickPick(choices.map((x) => ({
            label: x.lane.name, description: x.repo.id, detail: wordOf(x.lane), x
        })), { title, matchOnDescription: true })
        return picked?.x ?? null
    }

    const refused = (pressed) => {
        if (pressed.status < 400) return false
        vscode.window.showErrorMessage(`Lanes: ${pressed.body?.error ?? `refused (${pressed.status})`}`)
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

    const commands = {
        'lanekit.show': (focus) => show(focus),
        'lanekit.refresh': () => schedule(true),
        'lanekit.newLane': async () => {
            await readIfNever()
            const repos = service.known().repos.filter((repo) => !repo.error)
            if (!repos.length) { vscode.window.showInformationMessage('Lanes: no repository with a lane.config.json is open here.'); return }
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
                const choice = await vscode.window.showErrorMessage(`Lanes: ${x.lane.name} cannot land yet.`, 'Show why')
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
                vscode.window.showErrorMessage(`Lanes: ${error.message}`)
                return undefined
            }
        }))
    }

    schedule(true)

    return {
        commands: Object.keys(commands),
        service,
        panel: () => panel,
        dispose: () => { disposed = true; clearTimeout(timer); clearTimeout(jobPing); service.dispose() }
    }
}
