#!/usr/bin/env node
/**
 * Run a project's full suite on main, in a scratch copy, and record it in the main checkout (lib/full.mjs).
 *
 *     node <lanekit>/dev/full.mjs [--sha <commit>] [--why nightly|after-land] [--landed <lane>] [--wait] [--force] [--log <file>]
 *
 * WHO RUNS THIS. `lane nightly`, typed or started by its LaunchAgent or crontab line at `gate.full.at`; and `lane land`,
 * for a project whose full suite runs after-land, detached, once the land has merged (`--why after-land`). An after-land
 * run tests main's newest commit, and runs once more when main moved while it ran; a run already under way is left to
 * do that, and this one ends (lib/full.mjs, followMain; the owner, 26 Oct). `lane nightly` in such a project follows main
 * the same way once its own run ends. `--wait` waits for a run under way instead of leaving it be. A person types
 * `lane nightly`; this file is what it and the schedule run.
 *
 * Run from anywhere in the repository, a lane included: the main checkout is found from it, and its config is read.
 * It exits 0 when the suite passed, or there was nothing to run (main's commit passed already, or another run holds the
 * scratch copy); 1 when it failed or could not start.
 */

import path from 'node:path'

import { loadConfig } from '../lib/config.mjs'
import { followMain, fullOf, fullResultLines, runFullOnMain } from '../lib/full.mjs'
import { mainRepoFrom } from '../lib/lanes.mjs'

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const OFF = '\x1b[0m'

const started = Date.now()
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`
const log = (message) => console.log(`${DIM}[full ${elapsed().padStart(4)}]${OFF} ${message}`)

const argv = process.argv.slice(2)
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
const why = flag('--why') ?? 'nightly'
if (!['nightly', 'after-land'].includes(why)) {
    console.error(`\n${RED}  --why is nightly or after-land, not "${why}"${OFF}\n`)
    process.exit(2)
}

let mainRepo
let config
try {
    mainRepo = mainRepoFrom(process.cwd())
    config = loadConfig(mainRepo)
} catch (error) {
    console.error(`\n${RED}  ${error.message.split('\n')[0]}${OFF}\n`)
    process.exit(1)
}
const base = config.integrationBranch

// A log file is read later, by somebody who was not there: each run in it begins with when, why and where.
if (flag('--log')) console.log(`\n── ${new Date().toISOString()}  ${why}${flag('--landed') ? ` of ${flag('--landed')}` : ''}  ${mainRepo}`)

const banner = (word, colour, detail) => {
    const rule = '─'.repeat(68)
    console.log(`\n${rule}\n  ${colour}${word}${OFF}  ·  ${detail}\n${rule}\n`)
}

/** A run's banner, as it ends: passed, or failed and what to do. */
const said = (record) => {
    const [first, ...rest] = fullResultLines(record, base)
    for (const line of rest) console.log(line)
    if (record.result === 'passed') return banner('FULL SUITE PASSED', GREEN, `${first}  ·  ${elapsed()}`)
    banner('FULL SUITE FAILED', RED, `${first}  ·  ${elapsed()}`)
    console.log(`  Nothing was changed: ${base} is as it was${record.why === 'after-land' ? `, ${landedSaid(record)} and all` : ''}. Fix it in a lane; lane nightly runs it again.\n`)
}
const landedSaid = (record) => {
    const names = [...(record.coalesced ?? []), record.landed].filter(Boolean)
    return names.length ? `${names.join(' and ')} landed` : 'the land'
}
const exitWith = (record) => process.exit(record && record.result !== 'passed' ? 1 : 0)
const followsMain = fullOf(config)?.when === 'after-land'
const following = () => followMain({
    mainRepo, config, landed: flag('--landed') ?? null, landedSha: flag('--sha') ?? null,
    logFile: flag('--log') ? path.resolve(flag('--log')) : null, log, ended: said
})
const busySaid = (busy, what) => log(`${YELLOW}a full run is under way already${busy ? ` (process ${busy.pid}, on ${String(busy.sha).slice(0, 10)}, ${busy.why})` : ''}: ${what}${OFF}`)

// After a land: main's newest commit, and again while main moves on; a run under way is left to do that.
if (why === 'after-land' && !argv.includes('--wait')) {
    const followed = await following()
    if (followed.refused) {
        console.error(`\n${RED}  ${followed.refused}${OFF}\n`)
        process.exit(1)
    }
    if (followed.busy) busySaid(followed.busy, `it runs ${base}'s newest commit when it ends, and this land's with it`)
    else if (!followed.records.length) log(`${base}'s newest commit has had its full run already: nothing to run`)
    exitWith(followed.records.at(-1))
}

const done = await runFullOnMain({
    mainRepo, config, why,
    sha: flag('--sha'),
    landed: flag('--landed') ?? null,
    force: argv.includes('--force'),
    wait: argv.includes('--wait'),
    logFile: flag('--log') ? path.resolve(flag('--log')) : null,
    log
})

if (done.refused) {
    console.error(`\n${RED}  ${done.refused}${OFF}\n`)
    process.exit(1)
}
if (done.skipped) {
    log(`${base} at ${done.skipped.sha.slice(0, 10)} passed ${done.skipped.label} already (${done.skipped.startedAt}): not run again; --force runs it anyway`)
    process.exit(0)
}
if (done.busy) {
    busySaid(done.busy, 'not starting another')
    process.exit(0)
}

const { record } = done
said(record)
// In a project whose full suite runs after each land, a land made while this ran left its commit to this run: followed.
if (followsMain) {
    const followed = await following()
    exitWith(followed.records.at(-1) ?? record)
}
exitWith(record)
