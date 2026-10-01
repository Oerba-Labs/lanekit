#!/usr/bin/env node
/**
 * Have this machine's agents say which lane they work in and what they are doing, for LaneKit's page
 * and the editor: LaneKit's hooks added to your Claude Code settings, and its plugin to your OpenCode
 * plugins.
 *
 *     node <lanekit>/bin/agent-reports.mjs            adds them, and says where
 *     node <lanekit>/bin/agent-reports.mjs --check    says what it would add, adds nothing
 *     node <lanekit>/bin/agent-reports.mjs --json     says it as { wrote, kept, warnings }, for a
 *                                                     workspace's setup to tell its person
 *
 * WHY ONCE A MACHINE. The hooks and the plugin go where Claude Code and OpenCode look for every project
 * (~/.claude/settings.json, ~/.config/opencode/plugins/), so one install covers every repository with
 * lanes here and nothing is committed to any of them. The editor's extension asks to do the same the
 * first time it finds lanes on a machine; this is for a machine without it, for saying yes later, and
 * for a workspace's own setup, which runs it at every start so its person is never asked.
 *
 * WHAT IT WILL NOT DO. Replace a hook or a plugin that is not LaneKit's, or touch settings that are not
 * valid JSON: it says so and leaves them. LaneKit's own are brought up to date where they name another
 * lanekit. It reports nothing by itself: each agent reports, into the person's own
 * ~/.local/state/lanekit/agents/, once it is started.
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { installForUser } from '../lib/agents.mjs'

const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TINT = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const [GREEN, YELLOW, DIM, OFF] = TINT ? ['\x1b[32m', '\x1b[33m', '\x1b[2m', '\x1b[0m'] : ['', '', '', '']

const check = process.argv.includes('--check')
const said = installForUser(KIT, { check })
if (process.argv.includes('--json')) {
    console.log(JSON.stringify(said))
    process.exit(0)
}
console.log('')
for (const file of said.wrote) console.log(`  ${GREEN}${check ? 'would write' : 'wrote'}${OFF}  ${file}`)
for (const file of said.kept) console.log(`  ${DIM}kept   ${file} (LaneKit's already, up to date)${OFF}`)
for (const warning of said.warnings) console.log(`  ${YELLOW}note${OFF}   ${warning}`)
console.log(`\n  Agents started from now on report to LaneKit; one already running starts reporting when it is started again.${check ? '\n  --check: nothing was written.' : ''}\n`)
