// The Lanes extension's front half: find the lanekit checkout on this machine and hand over
// to its vscode/host.mjs, which does the work.
//
// WHY A LOADER. The page, the service and the commands the page runs are lanekit's, and the
// shims every repository calls find lanekit's checkout (in a workspace, /opt/lanekit). This
// reads the same checkout, so the extension, the page and `lane` are always one version: a
// `git pull` of lanekit reaches the editor at its next window reload, and the .vsix only
// changes when this file or the manifest beside it does (vscode/pack.mjs).
//
// CommonJS, as VS Code loads an extension's entry; host.mjs is an ES module, imported.
'use strict'

const fs = require('fs')
const path = require('path')
const { pathToFileURL } = require('url')
const vscode = require('vscode')

let host = null

const lanekitRoot = () => {
    const set = vscode.workspace.getConfiguration('lanekit').get('path')
    // Last, the checkout this file is in, when it runs from one (a development host).
    const candidates = [set, process.env.LANEKIT_HOME, '/opt/lanekit', path.resolve(__dirname, '..')]
    return candidates.find((dir) => typeof dir === 'string' && dir && fs.existsSync(path.join(dir, 'vscode', 'host.mjs'))) ?? null
}

exports.activate = async (context) => {
    const root = lanekitRoot()
    if (!root) {
        // Every command still answers, with what is missing, rather than "command not found".
        const said = 'Lanes needs lanekit on this machine: set lanekit.path to a checkout of it (there is no /opt/lanekit here).'
        const manifest = require('./package.json')
        for (const { command } of manifest.contributes.commands) {
            context.subscriptions.push(vscode.commands.registerCommand(command, () => vscode.window.showErrorMessage(said)))
        }
        return
    }
    const module = await import(pathToFileURL(path.join(root, 'vscode', 'host.mjs')).href)
    host = await module.activate(context, vscode, { root })
}

exports.deactivate = () => {
    host?.dispose()
    host = null
}
