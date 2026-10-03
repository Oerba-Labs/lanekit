// LaneKit's editor extension, its front half: find the lanekit checkout on this machine and hand over
// to its vscode/host.mjs, which does the work.
//
// WHY A LOADER. The page, the service and the commands the page runs are lanekit's, and the
// shims every repository calls find lanekit's checkout (in a workspace, /opt/lanekit). This
// reads the same checkout, so the extension, the page and `lane` are always one version: a
// `git pull` of lanekit reaches the editor at its next window reload, and the .vsix only
// changes when this file or the manifest beside it does (vscode/pack.mjs).
//
// AND WHAT A LOADER IS LEFT TO DO: where there is no lanekit (installed from Open VSX or a release's
// .vsix, on a machine that never had it), it offers to clone one into ~/.lanekit, where the shims look
// too; and, once allowed, it keeps the checkout current, fetched every few hours and fast-forwarded when
// it may be (updates.js says when), and itself with it: where the checkout holds a newer build of this
// extension, it is built and installed from there. So everything LaneKit is, this file included, comes
// from the branch stable, and no extension store is needed to keep it current.
//
// CommonJS, as VS Code loads an extension's entry; host.mjs is an ES module, imported.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')
const vscode = require('vscode')

const updates = require('./updates.js')

// Every window checks, and each check is a fetch: once every few hours is enough for all of them.
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
// The commands this file answers itself, whether or not there is a lanekit to hand over to.
const OWN = new Set(['lanekit.update'])

let host = null
let timer = null
let soon = null
let placeholders = []

const lanekitRoot = () => {
    const set = vscode.workspace.getConfiguration('lanekit').get('path')
    // The shim's places, in the shim's order, so the editor runs the lanekit the `lane` commands
    // run; last, the checkout this file is in, when it runs from one (a development host).
    const candidates = [set, process.env.LANEKIT, process.env.LANEKIT_HOME, '/opt/lanekit', homeCopy(), path.resolve(__dirname, '..')]
    return candidates.find((dir) => typeof dir === 'string' && dir && fs.existsSync(path.join(dir, 'vscode', 'host.mjs'))) ?? null
}
const homeCopy = () => path.join(os.homedir(), '.lanekit')
const tilde = (dir) => (dir.startsWith(`${os.homedir()}${path.sep}`) ? `~${dir.slice(os.homedir().length)}` : dir)
const newCommits = (count) => `${count} new ${count === 1 ? 'commit' : 'commits'}`

/** Hand over to the checkout's host, the commands that only offered to install it gone first, and keep it current. */
const start = async (context, root) => {
    for (const placeholder of placeholders.splice(0)) placeholder.dispose()
    const module = await import(pathToFileURL(path.join(root, 'vscode', 'host.mjs')).href)
    host = await module.activate(context, vscode, { root })
    keepCurrent(context, root)
    return host
}

// ---------------------------------------------------------------------------
// where there is no lanekit: offered, and cloned
// ---------------------------------------------------------------------------

let installing = null
/**
 * Offer to clone lanekit into ~/.lanekit, or to use a copy somewhere else: once by itself (Not Now is remembered),
 * and whenever a command of LaneKit's is asked for while there is none. The clone is the person's yes to keeping it
 * current, as an extension from a store is kept current.
 */
const offerInstall = (context, { asked }) => {
    if (installing) return installing
    if (!asked && context.globalState.get('lanekit.install') === 'not-now') return Promise.resolve(null)
    installing = (async () => {
        const to = homeCopy()
        const pick = await vscode.window.showInformationMessage(
            `LaneKit runs from a copy of lanekit on this machine, and there is none yet. Install it in ${tilde(to)} (a git clone of ${updates.REPOSITORY}), and keep it up to date?`,
            'Install', 'Use a Copy I Have…', 'Not Now')
        if (pick === 'Use a Copy I Have…') {
            const chosen = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use This lanekit' })
            const dir = chosen?.[0]?.fsPath
            if (!dir) return null
            if (!updates.isLanekit(dir)) { vscode.window.showErrorMessage(`LaneKit: ${dir} is not a copy of lanekit (it has no vscode/host.mjs).`); return null }
            await vscode.workspace.getConfiguration('lanekit').update('path', dir, vscode.ConfigurationTarget.Global)
            return start(context, dir)
        }
        if (pick !== 'Install') {
            if (!asked) await context.globalState.update('lanekit.install', 'not-now')
            return null
        }
        const made = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `LaneKit: installing lanekit in ${tilde(to)}…` }, () => updates.install(to))
        if (!made.ok) { vscode.window.showErrorMessage(`LaneKit: ${made.why}.`); return null }
        await context.globalState.update('lanekit.updatesAllowed', 'yes')
        vscode.window.showInformationMessage(`LaneKit: lanekit is in ${tilde(made.root)}${made.branch ? `, following ${made.branch}` : ''}, and kept up to date. Projects with lanes find it there too.`)
        return start(context, made.root)
    })().finally(() => { installing = null })
    return installing
}

// ---------------------------------------------------------------------------
// keeping it current
// ---------------------------------------------------------------------------

/** Whether the checkout may be moved on by itself: the setting's word, else the person's answer, else null (not asked). */
const allowed = (context) => {
    const said = vscode.workspace.getConfiguration('lanekit').get('updates') ?? 'ask'
    if (said === 'always' || said === 'never') return said === 'always'
    const answered = context.globalState.get('lanekit.updatesAllowed')
    return answered === 'yes' ? true : answered === 'no' ? false : null
}

const isInside = (dir, root) => { const rel = path.relative(root, dir); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)) }

/**
 * The extension itself, kept current from the copy of lanekit as the copy is kept current from stable, with no
 * extension store: where the copy holds a newer build of this extension (the same ID, one this editor can run), it is
 * built there by the copy's own pack.mjs and installed as the editor installs any .vsix. Not where this file is the
 * copy's own (a development host), nor in a remote window, whose editor would look for the file on its own machine.
 * `may`: as checkForUpdate's, null to ask, which is the same yes as keeping the copy current.
 */
const upgradeLoader = async (context, root, may) => {
    if (isInside(__dirname, root) || vscode.env?.remoteName) return { state: 'own' }
    const seen = updates.newerLoader({ running: require('./package.json'), offered: updates.offeredLoader(root), editor: vscode.version })
    if (!seen.newer) return { state: 'current', why: seen.why }
    // Installed already, by this window or another: what is left is the reload.
    if (context.globalState.get('lanekit.loaderInstalled') === seen.version) return { state: 'installed', version: seen.version, already: true }
    if (may === false) return { state: 'off' }
    if (may === null) {
        const pick = await vscode.window.showInformationMessage(
            `lanekit in ${tilde(root)} holds LaneKit ${seen.version}, and this window runs ${require('./package.json').version}. Install it, and keep LaneKit up to date by itself from now on?`,
            'Keep It Up to Date', 'Not Now')
        if (pick === 'Not Now') await context.globalState.update('lanekit.updatesAllowed', 'no')
        if (pick !== 'Keep It Up to Date') return { state: 'declined' }
        await context.globalState.update('lanekit.updatesAllowed', 'yes')
    }
    const file = path.join(os.tmpdir(), `lanekit-${seen.version}-${process.pid}.vsix`)
    try {
        // Asked of the copy as it is now: a copy moved on while the window was open is read again, not remembered.
        const { build } = await import(`${pathToFileURL(path.join(root, 'vscode', 'pack.mjs')).href}?at=${Date.now()}`)
        fs.writeFileSync(file, build().bytes)
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(file))
    } catch (error) {
        return { state: 'left', why: `LaneKit ${seen.version} could not be installed from it: ${error.message}` }
    } finally {
        fs.rmSync(file, { force: true })
    }
    await context.globalState.update('lanekit.loaderInstalled', seen.version)
    return { state: 'installed', version: seen.version }
}

/** What came, in one message, with the reload that uses it: what runs in this window was read before it came. */
const sayWhatCame = (done, loader) => {
    const took = done?.state === 'updated' ? `lanekit took ${newCommits(done.count)}, and is at ${done.to}` : null
    const installed = loader?.state === 'installed' ? `the extension is LaneKit ${loader.version} now` : null
    if (!took && !installed) return
    const words = [took, installed].filter(Boolean).join('; ')
    vscode.window.showInformationMessage(`LaneKit: ${words}. Reload the window to use ${took && !installed && done.count === 1 ? 'it' : 'them'}.`, 'Reload Window')
        .then((pick) => (pick === 'Reload Window' ? vscode.commands.executeCommand('workbench.action.reloadWindow') : null))
}

let checking = null
/**
 * Fetch the checkout, and fast-forward it where it may be: asked once (the first time there is something new), and
 * not again after Not Now, unless `asked` (LaneKit: Update lanekit Now) says to, for this once. Then the extension
 * itself, from the copy as it now is. What came is said, with a reload to use it.
 */
const checkForUpdate = (context, root, { asked = false } = {}) => {
    if (checking) return checking
    checking = (async () => {
        let may = asked ? true : allowed(context)
        if (may === false) return { state: 'off' }
        await context.globalState.update('lanekit.updateCheckedAt', Date.now())
        let done = await updates.check(root)
        if (done.state === 'behind') {
            if (may === null) {
                const pick = await vscode.window.showInformationMessage(
                    `lanekit in ${tilde(root)} is ${newCommits(done.count)} behind ${done.upstream}. Keep it up to date by itself? Only ever a fast-forward, and never while it has changes or commits of its own.`,
                    'Keep It Up to Date', 'Not Now')
                if (pick === 'Not Now') await context.globalState.update('lanekit.updatesAllowed', 'no')
                if (pick !== 'Keep It Up to Date') return { state: 'declined' }
                await context.globalState.update('lanekit.updatesAllowed', 'yes')
                may = true
            }
            done = await updates.update(root)
        }
        // The extension, where the copy (moved on now, or by somebody's own pull) holds a newer build of it.
        const loader = await upgradeLoader(context, root, may)
        sayWhatCame(done, loader)
        return { ...done, loader }
    })().finally(() => { checking = null })
    return checking
}

/**
 * Soon after the window opens and then every hour: the copy fetched, unless that was done lately (it costs a fetch, so
 * once every few hours for every window); and the extension compared with the copy each time, which costs a file read.
 */
const keepCurrent = (context, root) => {
    const due = () => Date.now() - (context.globalState.get('lanekit.updateCheckedAt') ?? 0) >= CHECK_EVERY_MS
    const quietly = () => {
        if (due()) { checkForUpdate(context, root).catch(() => {}); return }
        const may = allowed(context)
        if (may !== false && !checking) upgradeLoader(context, root, may).then((loader) => sayWhatCame(null, loader), () => {})
    }
    clearInterval(timer)
    clearTimeout(soon)
    // Never what keeps a process open: the editor's, or a test's.
    timer = setInterval(quietly, 60 * 60 * 1000)
    soon = setTimeout(quietly, 30 * 1000)
    timer.unref?.()
    soon.unref?.()
}

/** LaneKit: Update lanekit Now: a check now, whatever was answered before, and what it found said either way. */
const updateNow = async (context) => {
    const root = lanekitRoot()
    if (!root) return offerInstall(context, { asked: true })
    const done = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LaneKit: fetching lanekit…' }, () => checkForUpdate(context, root, { asked: true }))
    if (done.state === 'current' && done.loader?.state !== 'installed') vscode.window.showInformationMessage(`LaneKit: lanekit in ${tilde(root)} has everything ${done.upstream} has, and the extension is its newest.`)
    else if (done.state === 'left') vscode.window.showWarningMessage(`LaneKit: lanekit in ${tilde(root)} was left as it is: ${done.why}.`)
    if (done.loader?.state === 'left') vscode.window.showWarningMessage(`LaneKit: ${done.loader.why}.`)
    return done
}

exports.activate = async (context) => {
    context.subscriptions.push(vscode.commands.registerCommand('lanekit.update', () => updateNow(context)))
    const root = lanekitRoot()
    if (root) { await start(context, root); return }
    // No lanekit here: every other command offers to install it, rather than "command not found", and once it is
    // there, does what it was asked; the window offers it once by itself.
    const manifest = require('./package.json')
    placeholders = manifest.contributes.commands.filter(({ command }) => !OWN.has(command))
        .map(({ command }) => vscode.commands.registerCommand(command, async (...args) => {
            if (await offerInstall(context, { asked: true })) return vscode.commands.executeCommand(command, ...args)
            return null
        }))
    context.subscriptions.push(...placeholders)
    void offerInstall(context, { asked: false })
}

exports.deactivate = () => {
    clearInterval(timer)
    clearTimeout(soon)
    timer = null
    soon = null
    host?.dispose()
    host = null
}
