#!/usr/bin/env node
/**
 * LaneKit's plugin for Claude Code, handing over to lanekit: the copy on this machine where there is one, found where
 * the editor's extension and every project's shim find it ($LANEKIT, $LANEKIT_HOME, /opt/lanekit, ~/.lanekit), so the
 * agent, the editor and `lane` run one lanekit; else the plugin's own copy, which Claude Code keeps.
 *
 *     node bin/plugin-run.mjs report claude     a hook: the event on stdin, as lanekit's own hooks get it
 *     node bin/plugin-run.mjs mcp               the MCP server (bin/mcp.mjs), its stdin and stdout passed through
 *
 * ONE REPORT, NOT TWO. Where lanekit's own hooks are in ~/.claude/settings.json already (bin/agent-reports.mjs put
 * them there), they report each event, and the plugin's say nothing. A reporter never fails Claude Code.
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Which lanekit to run `script` from (its path inside lanekit): the machine's, where there is one that has it, else
 * this plugin's own. A machine's copy older than the plugin, from before the script was written, is passed over.
 */
export const lanekitRoot = (script = ['dev', 'lane.mjs'], env = process.env, home = os.homedir()) =>
    [env.LANEKIT, env.LANEKIT_HOME, '/opt/lanekit', path.join(home, '.lanekit'), OWN]
        .find((dir) => typeof dir === 'string' && dir && fs.existsSync(path.join(dir, 'dev', 'lane.mjs')) && fs.existsSync(path.join(dir, ...script))) ?? OWN

/** Whether lanekit's own hooks report Claude Code's events here already: then the plugin's stay quiet. */
export const reportedAlready = (home = os.homedir()) => {
    try {
        return /lane(\.mjs'?"?)? report claude/.test(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'))
    } catch {
        return false
    }
}

const main = () => {
    const [what, ...rest] = process.argv.slice(2)
    const script = { report: ['dev', 'lane.mjs'], mcp: ['bin', 'mcp.mjs'] }[what]
    if (!script) { process.stderr.write('usage: plugin-run.mjs report <agent> | mcp\n'); process.exit(2) }
    if (what === 'report' && reportedAlready()) process.exit(0)
    const args = what === 'report' ? ['report', ...rest] : rest
    const child = spawn(process.execPath, [path.join(lanekitRoot(script), ...script), ...args], { stdio: 'inherit' })
    child.on('error', (error) => { process.stderr.write(`lanekit: ${error.message}\n`); process.exit(what === 'report' ? 0 : 1) })
    child.on('exit', (code, signal) => process.exit(what === 'report' ? 0 : code ?? (signal ? 1 : 0)))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
