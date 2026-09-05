#!/usr/bin/env node
/**
 * Lanes: create one, list them, clear away the ones that have landed.
 *
 * A lane is a git worktree with its own branch and its own copy of whatever a
 * running checkout needs that git does not carry — an environment file, a
 * database, a media directory, a port. The point is that two pieces of work can
 * be in flight without sharing a process, a file or a row.
 *
 * WHAT IS GENERIC AND WHAT IS THE PROJECT'S. Everything here is the former.
 * Which files to copy, which environment keys a lane must own, what to run to
 * provision one and where the port window is are all read from
 * `lane.config.json`, because they are the only parts that differ between two
 * projects — and in the two this package was built against they differ
 * completely: one provisions a Postgres database and migrates it, the other
 * copies nothing and lets a SQLite file be created on first write.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { configFor } from '../lib/config.mjs'
import { planQueue, landBlockers } from '../lib/queue.mjs'
import {
    lanes, laneDirFor, mainRepoFrom, prefixFor,
    nextFreePort, portOf, listenersOn, writeEnv, readEnv, isUnder
} from '../lib/lanes.mjs'

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const OFF = '\x1b[0m'

const log = (message) => console.log(`${DIM}[lane]${OFF} ${message}`)
const fail = (message) => {
    console.error(`\n${RED}  ${message}${OFF}\n`)
    process.exit(1)
}

const run = (command, args, cwd, what) => {
    const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
    if (result.status !== 0) fail(`${what} failed (${command} exited ${result.status ?? 'on a signal'})`)
}

const git = (args, cwd) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const gitQuiet = (args, cwd) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

/**
 * Fill `{lane}`, `{main}`, `{port}` and `{name}` in a configured value.
 *
 * Braces rather than `$VAR` on purpose: these strings sit in a JSON file that a
 * person edits beside real environment variables, and `$CATALOG_DB` in that
 * context reads as "the variable", not "substitute here".
 */
const expand = (value, vars) =>
    value.replace(/\{(lane|main|port|name)\}/g, (whole, key) =>
        vars[key] === undefined ? whole : String(vars[key]))

// ---------------------------------------------------------------------------
// new
// ---------------------------------------------------------------------------

const create = (config, name, options) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const laneDir = laneDirFor(mainRepo, name)
    const base = options.base ?? config.integrationBranch

    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
        fail(`"${name}" cannot be a lane name.\n\n` +
            '  It becomes a directory and a branch, so it is lowercase letters,\n' +
            '  digits and dashes, starting with a letter or digit.')
    }
    if (fs.existsSync(laneDir)) fail(`${laneDir} already exists.`)
    if (gitQuiet(['rev-parse', '--verify', `refs/heads/${name}`], mainRepo).ok) {
        fail(`a branch called "${name}" already exists.\n\n` +
            `  Pick another name, or delete it: git branch -D ${name}`)
    }
    if (!gitQuiet(['rev-parse', '--verify', base], mainRepo).ok) {
        fail(`the base "${base}" does not resolve in ${mainRepo}.`)
    }

    // A dirty main is not refused — the lane branches from a ref, not from the
    // working tree — but saying so beats the user discovering it in the lane.
    const dirty = git(['status', '--porcelain'], mainRepo)
    if (dirty) {
        log(`${mainRepo} has uncommitted changes; they stay there — this lane branches from ${base}`)
    }

    log(`creating ${path.basename(laneDir)} on a new branch "${name}" from ${base}`)
    run('git', ['worktree', 'add', laneDir, '-b', name, base], mainRepo, 'git worktree add')

    // The files a checkout needs and git does not carry. Copied rather than
    // linked: a lane that shares its environment file with main is a lane whose
    // port and database are main's, which is the whole thing this prevents.
    const copied = []
    for (const rel of config.lane.copyOnCreate ?? []) {
        const from = path.join(mainRepo, rel)
        if (!fs.existsSync(from)) continue
        const to = path.join(laneDir, rel)
        fs.mkdirSync(path.dirname(to), { recursive: true })
        const stat = fs.statSync(from)
        if (stat.isDirectory()) fs.cpSync(from, to, { recursive: true })
        else fs.copyFileSync(from, to)
        copied.push(rel)
    }
    if (copied.length) log(`copied ${copied.length} gitignored ${copied.length === 1 ? 'path' : 'paths'} the checkout needs but git does not carry`)

    // Big, rebuildable, and identical between lanes: linked rather than copied.
    // A virtual environment cannot be copied at all — its scripts carry the
    // absolute path they were built for — and building one per lane costs
    // minutes and a few hundred megabytes each. The trade is the one worth
    // naming: lanes share these, so a lane that changes its dependencies
    // changes them for every lane. `--install` opts out and provisions instead.
    const linked = []
    if (!options.install) {
        for (const rel of config.lane.linkOnCreate ?? []) {
            const from = path.join(mainRepo, rel)
            if (!fs.existsSync(from)) continue
            const to = path.join(laneDir, rel)
            if (fs.existsSync(to)) continue
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.symlinkSync(from, to)
            linked.push(rel)
        }
        if (linked.length) log(`linked ${linked.join(', ')} from the main checkout`)
    }

    const port = nextFreePort(config, mainRepo)
    const vars = { lane: laneDir, main: mainRepo, port, name }

    // The environment is written even when nothing will be run in this lane
    // yet. A lane that skipped this is not merely unprovisioned — it carries
    // main's port and main's database, and it is the copy that makes it lie.
    const envFile = path.join(laneDir, config.lane.env.file)
    const updates = {}
    for (const [key, template] of Object.entries(config.lane.env.perLane ?? {})) {
        updates[key] = expand(template, vars)
    }
    updates[config.lane.env.portKey] = String(port)
    fs.mkdirSync(path.dirname(envFile), { recursive: true })
    writeEnv(envFile, updates)
    log(`this lane serves on ${port}`)
    for (const [key, value] of Object.entries(updates)) {
        if (key !== config.lane.env.portKey) log(`  ${key} = ${value.replace(laneDir, '.')}`)
    }

    // Directories the environment now points at. Created here rather than left
    // to the app: a path that does not exist fails at the first write, which is
    // minutes into a run rather than now.
    for (const template of config.lane.makeDirs ?? []) {
        fs.mkdirSync(expand(template, vars), { recursive: true })
    }

    if (!options.provision) {
        log('skipped provisioning — the worktree is ready, the stack is not')
    } else if (options.install || !(config.lane.linkOnCreate ?? []).length) {
        for (const step of config.lane.provision ?? []) {
            log(`${step.what}…`)
            const cwd = step.cwd ? path.join(laneDir, expand(step.cwd, vars)) : laneDir
            const args = (step.args ?? []).map((arg) => expand(arg, vars))
            run(expand(step.command, vars), args, cwd, step.what)
        }
    }

    const rule = '─'.repeat(64)
    console.log(`\n${rule}`)
    console.log(`  ${GREEN}lane "${name}" ready${OFF}`)
    console.log(`${rule}\n`)
    console.log(`  cd ${laneDir}\n`)
    console.log(`  port     ${port}`)
    console.log(`  branch   ${name} (from ${base})`)
    if (config.lane.runHint) console.log(`  serve    ${expand(config.lane.runHint, vars)}`)
    console.log('')
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

const list = (config) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const found = lanes(process.cwd(), config.integrationBranch)

    const rows = [{
        name: 'main', path: mainRepo, branch: config.integrationBranch,
        port: null, note: 'the integration branch'
    }]

    for (const lane of found) {
        const port = portOf(lane, config)
        const serving = port ? listenersOn(port).length > 0 : false
        let note = ''
        if (!lane.exists) note = 'directory is gone — git worktree prune'
        else {
            const contained = gitQuiet(
                ['merge-base', '--is-ancestor', lane.branch ?? lane.name, config.integrationBranch],
                mainRepo)
            if (contained.ok) note = `contained in ${config.integrationBranch}`
            else {
                const ahead = gitQuiet(
                    ['rev-list', '--count', `${config.integrationBranch}..${lane.branch ?? lane.name}`],
                    mainRepo)
                note = ahead.ok ? `${ahead.out} ahead` : ''
            }
        }
        rows.push({ ...lane, port, serving, note })
    }

    const width = Math.max(...rows.map((row) => row.name.length), 4)
    console.log('')
    console.log(`  ${'LANE'.padEnd(width)}  PORT  SERVER     `)
    for (const row of rows) {
        const port = row.port ? String(row.port) : '—'
        const server = row.name === 'main' ? '' : (row.serving ? `${GREEN}● up${OFF}  ` : `${DIM}○ down${OFF}`)
        console.log(`  ${row.name.padEnd(width)}  ${port.padEnd(4)}  ${server.padEnd(10)} ${DIM}${row.note}${OFF}`)
    }
    console.log('')
}

// ---------------------------------------------------------------------------
// queue
// ---------------------------------------------------------------------------

const VERDICT_COLOUR = {
    'land now': GREEN,
    'gate now': '',
    'hold the gate': YELLOW,
    'commit first': YELLOW,
    'rebase first': YELLOW,
    parked: DIM
}

const queue = (config, only) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const found = lanes(process.cwd(), config.integrationBranch)
    if (!found.length) {
        console.log('\n  no lanes\n')
        return 0
    }

    const plan = planQueue(mainRepo, found, config)

    if (only) {
        const blockers = landBlockers(plan, only)
        if (!blockers.length) {
            console.log(`\n  ${GREEN}${only} is clear to land.${OFF}\n`)
            return 0
        }
        console.log(`\n  ${YELLOW}${only} is not clear to land:${OFF}\n`)
        for (const blocker of blockers) {
            console.log(`    ${blocker.id.padEnd(8)} ${blocker.why}${blocker.overridable ? `  ${DIM}(--force overrides this one)${OFF}` : ''}`)
        }
        console.log('')
        return 1
    }

    const width = Math.max(...plan.entries.map((entry) => entry.name.length), 4)
    console.log('')
    console.log(`  ${'LANE'.padEnd(width)}  TIER  VERDICT`)
    const ordered = [...plan.entries].sort((a, b) =>
        (a.position ?? 99) - (b.position ?? 99) || a.name.localeCompare(b.name))
    for (const entry of ordered) {
        const colour = VERDICT_COLOUR[entry.verdict] ?? ''
        const tier = entry.tier ? `${entry.tier}` : '—'
        console.log(`  ${entry.name.padEnd(width)}  ${tier.padEnd(4)}  ${colour}${entry.verdict}${OFF}  ${DIM}${entry.why ?? ''}${OFF}`)
        for (const collision of entry.collisions ?? []) {
            console.log(`  ${' '.repeat(width)}        ${DIM}collides with ${collision.lane}: ${collision.paths.slice(0, 3).join(', ')}${OFF}`)
        }
    }
    console.log('')
    return 0
}

// ---------------------------------------------------------------------------
// land
// ---------------------------------------------------------------------------

/**
 * Merge a lane into the integration branch, then clear it away.
 *
 * THE PLAN IS RE-READ, never taken from a previous command. A plan read a
 * minute ago predates the merge about to be made, and the thing it is most
 * likely to be wrong about is whether somebody else just landed.
 *
 * CONTAINMENT IS READ PLAINLY rather than inferred from the merge's exit code,
 * because everything after it acts on the answer — the sweep removes a worktree
 * on the strength of "this landed", and a merge that reported success without
 * landing would take the work with it.
 */
const land = (config, name, options) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const here = process.cwd()

    if (!name) fail('lane land needs a name.')

    const found = lanes(here, config.integrationBranch)
    const lane = found.find((candidate) => candidate.name === name)
    if (!lane) fail(`there is no lane called "${name}".`)

    if (isUnder(here, lane.path)) {
        fail(`${name} is the lane you are standing in.\n\n` +
            `  cd ${mainRepo} first — landing removes this worktree, and that would take\n` +
            '  the ground out from under the command doing it.')
    }

    const current = gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepo)
    if (current.out !== config.integrationBranch) {
        fail(`${mainRepo} is on "${current.out}", not ${config.integrationBranch}.\n\n` +
            `  A land merges into ${config.integrationBranch}; switch to it first.`)
    }

    const dirtyMain = gitQuiet(['status', '--porcelain'], mainRepo).out
        .split('\n').filter(Boolean)
        .filter((line) => !(config.lane.linkOnCreate ?? []).some((rel) => line.includes(rel)))
    if (dirtyMain.length) {
        fail(`${config.integrationBranch} has uncommitted changes.\n\n` +
            dirtyMain.map((line) => `  ${line}`).join('\n') +
            '\n\n  A merge into a dirty branch mixes them into what landed.')
    }

    const plan = planQueue(mainRepo, found, config)
    const blockers = landBlockers(plan, name)
    const fatal = blockers.filter((blocker) => !(blocker.overridable && options.force))
    if (fatal.length) {
        const waived = blockers.length - fatal.length
        fail(`${name} cannot land yet.\n\n` +
            fatal.map((blocker) => `  ${blocker.id.padEnd(8)} ${blocker.why}`).join('\n') +
            (waived ? `\n\n  ${waived} overridden by --force.` : '') +
            '\n\n  `lane queue` shows the whole picture.')
    }
    if (blockers.length) log(`${blockers.length} blocker overridden by --force`)

    const entry = plan.entries.find((candidate) => candidate.name === name)
    const branch = lane.branch ?? name

    if (options.dryRun) {
        log(`would merge ${branch} into ${config.integrationBranch} (--no-ff), then sweep it`)
        log(`green: tier ${entry.tier} run on ${String(entry.snapshot).slice(0, 10)}`)
        return
    }

    log(`merging ${branch} into ${config.integrationBranch} at ${mainRepo}`)
    const merge = spawnSync('git', ['merge', '--no-ff', '--no-edit', branch],
        { cwd: mainRepo, encoding: 'utf8' })
    if (merge.status !== 0) {
        spawnSync('git', ['merge', '--abort'], { cwd: mainRepo })
        fail(`the merge conflicted and was aborted — ${config.integrationBranch} is as it was.\n\n` +
            `${(merge.stdout ?? '').trim().split('\n').slice(0, 8).map((l) => `  ${l}`).join('\n')}\n\n` +
            `  Resolve it deliberately from ${mainRepo}:\n` +
            `    git merge --no-ff ${branch}`)
    }

    // Read, not inferred. Everything below acts on this answer.
    const landed = gitQuiet(['merge-base', '--is-ancestor', branch, config.integrationBranch], mainRepo)
    if (!landed.ok) {
        fail(`the merge reported success but ${branch} is not contained in ${config.integrationBranch}.\n\n` +
            '  Nothing has been swept. Look before doing anything else.')
    }
    const at = gitQuiet(['rev-parse', '--short', 'HEAD'], mainRepo).out
    log(`merged — ${config.integrationBranch} is at ${at}`)

    if (options.sweep) sweep(config, name, { dryRun: false })
    else log('left the lane in place (--no-sweep)')

    const rule = '─'.repeat(64)
    console.log(`\n${rule}`)
    console.log(`  ${GREEN}LANDED${OFF}  ·  ${name}  ·  ${config.integrationBranch} at ${at}`)
    console.log(`${rule}\n`)
}

// ---------------------------------------------------------------------------
// sweep
// ---------------------------------------------------------------------------

/**
 * Clear away lanes whose branch is already contained in the integration branch.
 *
 * CONTAINMENT, NOT A GUESS. `merge-base --is-ancestor` is the only test — a
 * lane is finished when its commits are reachable from the branch it landed on,
 * whatever its name or date says. A ref is trivially contained in itself, so
 * sweeping toward a branch would find that branch's own lane "merged"; the
 * integration branch is therefore never a lane and never swept.
 *
 * THE BRANCH IS KEPT. The worktree, the port and the lane's files go; the
 * branch stays as the record of what landed.
 */
const sweep = (config, only, options) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const here = process.cwd()
    const candidates = lanes(here, config.integrationBranch).filter((lane) => !only || lane.name === only)

    if (!candidates.length) {
        console.log(only ? `\n  no lane called "${only}"\n` : '\n  no lanes\n')
        return
    }

    let swept = 0
    for (const lane of candidates) {
        const branch = lane.branch ?? lane.name
        const contained = gitQuiet(
            ['merge-base', '--is-ancestor', branch, config.integrationBranch], mainRepo)
        if (!contained.ok) {
            if (only) fail(`${lane.name} is not contained in ${config.integrationBranch} — it has not landed.`)
            continue
        }
        if (isUnder(here, lane.path)) {
            fail(`${lane.name} is the lane you are standing in.\n\n` +
                `  cd ${mainRepo} first — removing it from inside takes the ground with it.`)
        }

        const port = portOf(lane, config)
        const holders = port ? listenersOn(port) : []
        if (holders.length) {
            if (options.dryRun) log(`${lane.name}: would stop ${holders.length} process on ${port}`)
            else {
                for (const pid of holders) {
                    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
                }
                log(`${lane.name}: stopped ${holders.length} process on ${port}`)
            }
        }

        if (options.dryRun) {
            log(`${lane.name}: would remove ${lane.path} (branch kept)`)
            swept++
            continue
        }

        const removed = spawnSync('git', ['worktree', 'remove', '--force', lane.path],
            { cwd: mainRepo, encoding: 'utf8' })
        if (removed.status !== 0) {
            log(`${RED}${lane.name}: could not remove the worktree${OFF} — ${(removed.stderr ?? '').trim().split('\n')[0]}`)
            continue
        }
        log(`removed ${lane.name} — branch "${branch}" kept`)
        swept++
    }

    if (!swept) console.log(`\n  nothing to sweep — no lane is contained in ${config.integrationBranch}\n`)
}

// ---------------------------------------------------------------------------

const COMMANDS = { new: create, list, sweep, queue, land }

const main = () => {
    const argv = process.argv.slice(2)
    const command = argv[0]
    if (!command || !(command in COMMANDS)) {
        console.error(`\n  usage: lane <new|list|sweep|queue|land> [name] [--base <ref>] [--install] [--no-provision] [--no-sweep] [--force] [--dry-run]\n`)
        process.exit(2)
    }

    const options = {
        base: argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined,
        provision: !argv.includes('--no-provision'),
        install: argv.includes('--install'),
        dryRun: argv.includes('--dry-run'),
        sweep: !argv.includes('--no-sweep'),
        force: argv.includes('--force')
    }
    const positional = argv.slice(1).filter((arg) => !arg.startsWith('--'))
    const name = positional[0] !== options.base ? positional[0] : positional[1]

    let config
    try {
        config = configFor(process.cwd())
    } catch (error) {
        fail(error.message)
    }

    if (command === 'new' && !name) fail('lane new needs a name.')
    if (command === 'new') return create(config, name, options)
    if (command === 'list') return list(config)
    if (command === 'queue') return process.exit(queue(config, name))
    if (command === 'land') return land(config, name, options)
    return sweep(config, name, options)
}

main()
