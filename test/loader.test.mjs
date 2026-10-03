/**
 * The extension's loader (vscode/extension.js), as an extension store installs it: on a machine with no lanekit it
 * offers to install one, once by itself and whenever a command is asked for, then hands over and does what was asked;
 * and it keeps the copy it runs from current, asking first, offering a reload, and saying why when it leaves one as
 * it is. In a stand-in for the editor, with a bare repository standing in for GitHub whose lanekit is a small host
 * that writes down that it started.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { after, before, mock, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// A machine with lanekit where the loader looks first would never be without it: there these tests cannot be run.
const skip = fs.existsSync('/opt/lanekit/vscode/host.mjs') ? '/opt/lanekit is lanekit here, so a machine without it cannot be stood in for' : false

const env = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: { ...process.env, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (cwd, file, text) => { fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); fs.writeFileSync(path.join(cwd, file), text) }
const commit = (cwd, file, text, message) => { write(cwd, file, text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }

const manifest = JSON.parse(fs.readFileSync(path.join(KIT, 'vscode', 'package.json'), 'utf8'))
const COMMANDS = manifest.contributes.commands.map((command) => command.command)

let scratch, origin, author, loaderDir
const saved = { HOME: process.env.HOME, LANEKIT: process.env.LANEKIT, LANEKIT_HOME: process.env.LANEKIT_HOME, LANEKIT_REPOSITORY: process.env.LANEKIT_REPOSITORY }

/** The editor, as far as the loader asks it: commands, messages answered by `answer`, a folder picker, settings and state. */
const editor = () => {
    const seen = { commands: new Map(), messages: [], executed: [], progress: [] }
    const config = { path: '', updates: 'ask' }
    const state = new Map()
    const said = { answer: () => undefined, folder: null }
    const message = (kind) => async (text, ...items) => { seen.messages.push({ kind, text, items: items.filter((item) => typeof item === 'string') }); return said.answer(text, items) }
    const vscode = {
        commands: {
            registerCommand: (id, run) => {
                if (seen.commands.has(id)) throw new Error(`command '${id}' already exists`)
                seen.commands.set(id, run)
                return { dispose: () => { if (seen.commands.get(id) === run) seen.commands.delete(id) } }
            },
            executeCommand: async (id, ...args) => { seen.executed.push(id); return seen.commands.get(id)?.(...args) }
        },
        window: {
            showInformationMessage: message('info'), showWarningMessage: message('warning'), showErrorMessage: message('error'),
            showOpenDialog: async () => (said.folder ? [{ fsPath: said.folder }] : undefined),
            withProgress: async (options, task) => { seen.progress.push(options.title); return task({ report() {} }) }
        },
        workspace: { getConfiguration: () => ({ get: (key) => config[key], update: async (key, value) => { config[key] = value } }) },
        ProgressLocation: { Notification: 15 },
        ConfigurationTarget: { Global: 1 }
    }
    const context = { subscriptions: [], globalState: { get: (key) => state.get(key), update: async (key, value) => { state.set(key, value) } } }
    return { vscode, context, seen, config, state, said }
}

// `vscode` is no file: the editor hands it to the extension, and here the stand-in is handed in its place.
const resolveFilename = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) { return request === 'vscode' ? 'vscode' : resolveFilename.call(this, request, ...rest) }

/** The loader, freshly required, as the editor loads it from the extension's folder, with `vscode` the stand-in. */
const load = (stand) => {
    const vscodeModule = new Module('vscode')
    vscodeModule.exports = stand.vscode
    vscodeModule.loaded = true
    Module._cache.vscode = vscodeModule
    for (const file of ['extension.js', 'updates.js']) delete require.cache[path.join(loaderDir, file)]
    return require(path.join(loaderDir, 'extension.js'))
}
const until = async (what, check, ms = 15_000) => {
    for (const by = Date.now() + ms; Date.now() < by; await sleep(25)) { const found = check(); if (found) return found }
    throw new Error(`waited for ${what}`)
}

before(() => {
    if (skip) return
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-loader-')))
    // The loader alone in a folder of its own, as an extension store unpacks it: nothing above it is lanekit.
    loaderDir = path.join(scratch, 'extensions', 'lanekit.lanekit-0.0.0')
    for (const file of ['extension.js', 'updates.js', 'package.json']) write(loaderDir, file, fs.readFileSync(path.join(KIT, 'vscode', file)))
    // lanekit on "GitHub": a host that registers the commands the manifest offers and writes down where it started.
    origin = path.join(scratch, 'lanekit.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    author = path.join(scratch, 'author')
    git(scratch, 'clone', '-q', origin, author)
    git(author, 'switch', '-q', '-c', 'main')
    write(author, 'vscode/host.mjs', `export const activate = async (context, vscode, { root }) => {
    globalThis.__lanekitHost = { root, ran: [] }
    for (const id of ${JSON.stringify(COMMANDS.filter((id) => id !== 'lanekit.update'))}) {
        context.subscriptions.push(vscode.commands.registerCommand(id, () => globalThis.__lanekitHost.ran.push(id)))
    }
    return { dispose: () => { globalThis.__lanekitHost.disposed = true } }
}
`)
    commit(author, 'dev/lane.mjs', '// lane\n', 'Begin lanekit')
    git(author, 'push', '-q', '-u', 'origin', 'main', 'main:stable')
    Object.assign(process.env, { HOME: path.join(scratch, 'home'), LANEKIT: '', LANEKIT_HOME: '', LANEKIT_REPOSITORY: origin })
    fs.mkdirSync(process.env.HOME)
})

after(() => {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    delete Module._cache.vscode
    Module._resolveFilename = resolveFilename
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true })
})

test('with no lanekit on the machine, every command offers to install it, and the window offers it once; Not Now is remembered', { skip }, async () => {
    const stand = editor()
    stand.said.answer = (text, items) => (items.includes('Not Now') ? 'Not Now' : undefined)
    const loader = load(stand)
    await loader.activate(stand.context)
    await until('the offer', () => stand.state.get('lanekit.install') === 'not-now')
    assert.match(stand.seen.messages[0].text, /LaneKit runs from a copy of lanekit on this machine, and there is none yet\. Install it in ~\/\.lanekit/)
    assert.deepEqual(stand.seen.messages[0].items, ['Install', 'Use a Copy I Have…', 'Not Now'])
    assert.deepEqual([...stand.seen.commands.keys()].sort(), [...COMMANDS].sort(), 'every command answers, rather than "command not found"')
    assert.ok(!fs.existsSync(path.join(process.env.HOME, '.lanekit')))
    loader.deactivate()

    // The next window: not offered again by itself.
    const next = editor()
    next.state.set('lanekit.install', 'not-now')
    const again = load(next)
    await again.activate(next.context)
    await sleep(100)
    assert.equal(next.seen.messages.length, 0)
    again.deactivate()
})

test('a command asked for then installs lanekit in ~/.lanekit, following stable, hands over to it, and does what was asked', { skip }, async () => {
    const stand = editor()
    stand.state.set('lanekit.install', 'not-now')
    stand.said.answer = (text, items) => (items.includes('Install') ? 'Install' : undefined)
    const loader = load(stand)
    await loader.activate(stand.context)
    await stand.vscode.commands.executeCommand('lanekit.reveal')
    const home = path.join(process.env.HOME, '.lanekit')
    assert.equal(globalThis.__lanekitHost?.root, home, 'the host started, from the copy just made')
    assert.deepEqual(globalThis.__lanekitHost.ran, ['lanekit.reveal'], 'and the command asked for was done')
    assert.equal(git(home, 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/stable')
    assert.equal(stand.state.get('lanekit.updatesAllowed'), 'yes', 'installing it is the yes to keeping it current')
    assert.ok(stand.seen.progress.some((title) => /installing lanekit in ~\/\.lanekit/.test(title)))
    assert.ok(stand.seen.messages.some((said) => /lanekit is in ~\/\.lanekit, following stable, and kept up to date/.test(said.text)))
    loader.deactivate()
    assert.equal(globalThis.__lanekitHost.disposed, true)
})

test('Use a Copy I Have… takes a folder that is lanekit as lanekit.path, and refuses one that is not', { skip }, async () => {
    const elsewhere = path.join(scratch, 'elsewhere')
    fs.mkdirSync(elsewhere)
    const mine = path.join(scratch, 'my-lanekit')
    git(scratch, 'clone', '-q', origin, mine)
    fs.renameSync(path.join(process.env.HOME, '.lanekit'), path.join(scratch, 'put-away'))
    try {
        const stand = editor()
        stand.said.answer = (text, items) => (items.includes('Use a Copy I Have…') ? 'Use a Copy I Have…' : undefined)
        stand.said.folder = elsewhere
        const loader = load(stand)
        await loader.activate(stand.context)
        await until('the refusal', () => stand.seen.messages.find((said) => said.kind === 'error'))
        assert.match(stand.seen.messages.find((said) => said.kind === 'error').text, /is not a copy of lanekit/)
        stand.said.folder = mine
        await stand.vscode.commands.executeCommand('lanekit.show')
        assert.equal(stand.config.path, mine)
        assert.equal(globalThis.__lanekitHost.root, mine)
        assert.deepEqual(globalThis.__lanekitHost.ran, ['lanekit.show'])
        loader.deactivate()
    } finally {
        fs.renameSync(path.join(scratch, 'put-away'), path.join(process.env.HOME, '.lanekit'))
    }
})

test('a copy behind what it follows is moved on once the person says so, a reload is offered, and Not Now is kept', { skip }, async () => {
    const home = path.join(process.env.HOME, '.lanekit')
    commit(author, 'new.txt', 'new\n', 'Something new')
    git(author, 'push', '-q', 'origin', 'main', 'main:stable')
    const stand = editor()
    stand.said.answer = (text, items) => (items.includes('Keep It Up to Date') ? 'Keep It Up to Date' : items.includes('Reload Window') ? 'Reload Window' : undefined)
    // The first check comes a little after the window opens: its clock run on here.
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const loader = load(stand)
    try {
        await loader.activate(stand.context)
        mock.timers.tick(30_000)
    } finally {
        mock.timers.reset()
    }
    await until('the reload offered', () => stand.seen.executed.includes('workbench.action.reloadWindow'))
    assert.match(stand.seen.messages.find((said) => said.items.includes('Keep It Up to Date')).text, /lanekit in ~\/\.lanekit is 1 new commit behind origin\/stable\. Keep it up to date by itself\?/)
    assert.match(stand.seen.messages.find((said) => said.items.includes('Reload Window')).text, /lanekit took 1 new commit, and is at [0-9a-f]+ Something new\. Reload the window to use them\./)
    assert.equal(git(home, 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'))
    assert.equal(stand.state.get('lanekit.updatesAllowed'), 'yes')
    loader.deactivate()

    // Not Now: remembered, and nothing fetched or moved again by itself.
    commit(author, 'more.txt', 'more\n', 'More')
    git(author, 'push', '-q', 'origin', 'main', 'main:stable')
    const declined = editor()
    declined.said.answer = (text, items) => (items.includes('Not Now') ? 'Not Now' : undefined)
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
    const second = load(declined)
    try {
        await second.activate(declined.context)
        mock.timers.tick(30_000)
    } finally {
        mock.timers.reset()
    }
    await until('Not Now kept', () => declined.state.get('lanekit.updatesAllowed') === 'no')
    assert.notEqual(git(home, 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'), 'left where it was')
    second.deactivate()
})

test('LaneKit: Update lanekit Now moves it on whatever was answered, and says why when it leaves it as it is', { skip }, async () => {
    const home = path.join(process.env.HOME, '.lanekit')
    const stand = editor()
    stand.state.set('lanekit.updatesAllowed', 'no')
    stand.config.updates = 'never'
    const loader = load(stand)
    await loader.activate(stand.context)
    const done = await stand.vscode.commands.executeCommand('lanekit.update')
    assert.equal(done.state, 'updated', 'asked for by name, it is done')
    assert.equal(git(home, 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'))
    const current = await stand.vscode.commands.executeCommand('lanekit.update')
    assert.equal(current.state, 'current')
    assert.match(stand.seen.messages.at(-1).text, /lanekit in ~\/\.lanekit has everything origin\/stable has/)
    write(home, 'dev/lane.mjs', '// a change of somebody\'s own\n')
    commit(author, 'last.txt', 'last\n', 'Last')
    git(author, 'push', '-q', 'origin', 'main', 'main:stable')
    const left = await stand.vscode.commands.executeCommand('lanekit.update')
    assert.equal(left.state, 'left')
    assert.equal(stand.seen.messages.at(-1).kind, 'warning')
    assert.match(stand.seen.messages.at(-1).text, /lanekit in ~\/\.lanekit was left as it is: it has uncommitted changes\./)
    loader.deactivate()
})
