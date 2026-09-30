// LaneKit's editor extension, its front half: find the lanekit checkout on this machine and hand over
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
    // The shim's places, in the shim's order, so the editor runs the lanekit the `lane` commands
    // run; last, the checkout this file is in, when it runs from one (a development host).
    const home = require('os').homedir()
    const candidates = [set, process.env.LANEKIT, process.env.LANEKIT_HOME, '/opt/lanekit', path.join(home, '.lanekit'), path.resolve(__dirname, '..')]
    return candidates.find((dir) => typeof dir === 'string' && dir && fs.existsSync(path.join(dir, 'vscode', 'host.mjs'))) ?? null
}

exports.activate = async (context) => {
    const root = lanekitRoot()
    if (!root) {
        // Every command still answers, with what is missing, rather than "command not found".
        const said = 'LaneKit needs a checkout of lanekit on this machine: git clone https://github.com/Oerba-Labs/lanekit.git ~/.lanekit, or set lanekit.path to one.'
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
