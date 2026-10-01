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
import { changesOf } from '../lib/state.mjs'
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
    const existing = gitQuiet(['rev-parse', '--verify', `refs/heads/${name}`], mainRepo).ok
    if (existing && !options.existing) {
        fail(`a branch called "${name}" already exists.\n\n` +
            `  lane new ${name} --existing makes a lane of it as it is (a lane dropped earlier, say),\n` +
            `  or pick another name.`)
    }
    if (!existing && options.existing) fail(`there is no branch called "${name}" to make a lane of.`)
    if (existing && options.base) fail('--existing takes the branch as it is: give no --base with it.')
    if (!gitQuiet(['rev-parse', '--verify', base], mainRepo).ok) {
        fail(`the base "${base}" does not resolve in ${mainRepo}.`)
    }

    // A dirty main is not refused — the lane branches from a ref, not from the
    // working tree — but saying so beats the user discovering it in the lane.
    const dirty = git(['status', '--porcelain'], mainRepo)
    if (dirty) {
        log(`${mainRepo} has uncommitted changes; they stay there — this lane branches from ${base}`)
    }

    if (existing) {
        log(`creating ${path.basename(laneDir)} on the branch "${name}" as it is, ${git(['rev-list', '--count', `${config.integrationBranch}..${name}`], mainRepo)} commits of its own`)
        run('git', ['worktree', 'add', laneDir, name], mainRepo, 'git worktree add')
    } else {
        log(`creating ${path.basename(laneDir)} on a new branch "${name}" from ${base}`)
        run('git', ['worktree', 'add', laneDir, '-b', name, base], mainRepo, 'git worktree add')
    }

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

    // Seeding is not provisioning. Provisioning builds what a lane can share with main
    // and is skipped when it is linked instead; seeding fills what the lane must own —
    // its database, its media — and a lane without it serves an empty catalogue that
    // answers every question sensibly and wrongly. So it runs whether or not anything
    // was linked, and only `--no-seed` or `--no-provision` leaves it out.
    if (options.provision && options.seed) {
        for (const step of config.lane.seed ?? []) {
            log(`${step.what}…`)
            const cwd = step.cwd ? path.join(laneDir, expand(step.cwd, vars)) : laneDir
            const args = (step.args ?? []).map((arg) => expand(arg, vars))
            run(expand(step.command, vars), args, cwd, step.what)
        }
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
// rebase, push, pr, pull: what a lane needs between being made and landing
// ---------------------------------------------------------------------------

const laneNamed = (config, name, verb) => {
    if (!name) fail(`lane ${verb} needs a name.`)
    const lane = lanes(process.cwd(), config.integrationBranch).find((candidate) => candidate.name === name)
    if (!lane) fail(`there is no lane called "${name}".`)
    if (!lane.exists) fail(`${name}'s folder is gone: git worktree prune, in the main checkout, clears it away.`)
    return lane
}

const inRebase = (dir) => {
    const gitDir = gitQuiet(['rev-parse', '--git-dir'], dir)
    if (!gitDir.ok) return false
    const at = path.resolve(dir, gitDir.out)
    return fs.existsSync(path.join(at, 'rebase-merge')) || fs.existsSync(path.join(at, 'rebase-apply'))
}

const conflictsIn = (dir) => gitQuiet(['diff', '--name-only', '--diff-filter=U'], dir).out.split('\n').filter(Boolean)

/** Uncommitted paths, less the links to main's rebuildable directories, which nothing counts. */
const dirtIn = (dir, config) => gitQuiet(['status', '--porcelain'], dir).out.split('\n').filter(Boolean)
    .filter((line) => !(config.lane.linkOnCreate ?? []).some((rel) => line.includes(rel)))

const stoppedMidRebase = (name, dir) => {
    const files = conflictsIn(dir)
    fail(`${name} stopped part-way through the rebase: ${files.length} ${files.length === 1 ? 'file conflicts' : 'files conflict'}.\n\n` +
        files.map((file) => `  ${file}`).join('\n') +
        `\n\n  Resolve them (LaneKit opens them in the editor), then carry on:\n    lane rebase ${name} --continue\n` +
        `  or put the lane back as it was before the rebase:\n    lane rebase ${name} --abort`)
}

/**
 * Replay a lane's commits on the integration branch as it is now.
 *
 * STOPS ON A CONFLICT, IT DOES NOT ABORT. The gate aborts a rebase that conflicts, because
 * nobody is there to resolve it; this is asked for by a person, who can. The lane is left
 * part-way through the rebase with the conflicting files named, and `--continue` stages the
 * ones whose conflicts are resolved and carries on, while `--abort` puts the lane back.
 */
const rebase = (config, name, options) => {
    const lane = laneNamed(config, name, 'rebase')
    const dir = lane.path
    const env = { ...process.env, GIT_EDITOR: 'true' }
    const base = config.integrationBranch

    if (options.abort) {
        if (!inRebase(dir)) fail(`${name} is not part-way through a rebase.`)
        const aborted = spawnSync('git', ['rebase', '--abort'], { cwd: dir, stdio: 'inherit' })
        if (aborted.status !== 0) fail('git rebase --abort did not finish (above).')
        log(`${name} is back as it was before the rebase, at ${git(['rev-parse', '--short', 'HEAD'], dir)}`)
        return
    }

    if (options.continue) {
        if (!inRebase(dir)) fail(`${name} is not part-way through a rebase.`)
        const files = conflictsIn(dir)
        const marked = files.filter((file) => {
            try { return /^(<{7}|>{7})( |$)/m.test(fs.readFileSync(path.join(dir, file), 'utf8')) } catch { return false }
        })
        if (marked.length) {
            fail(`${marked.length} ${marked.length === 1 ? 'file still has' : 'files still have'} conflict markers:\n\n` +
                marked.map((file) => `  ${file}`).join('\n') + '\n\n  Resolve them, then carry on again.')
        }
        if (files.length) {
            git(['add', '--', ...files], dir)
            log(`staged ${files.length} resolved ${files.length === 1 ? 'file' : 'files'}`)
        }
        const carried = spawnSync('git', ['rebase', '--continue'], { cwd: dir, stdio: 'inherit', env })
        if (carried.status !== 0) {
            if (inRebase(dir) && conflictsIn(dir).length) stoppedMidRebase(name, dir)
            fail('git rebase --continue did not finish (above).')
        }
    } else {
        if (inRebase(dir)) fail(`${name} is already part-way through a rebase: lane rebase ${name} --continue, or --abort.`)
        const dirt = dirtIn(dir, config)
        if (dirt.length) {
            fail(`${name} has uncommitted changes.\n\n${dirt.map((line) => `  ${line}`).join('\n')}\n\n` +
                '  A rebase replays commits, and these are in none: commit or stash them first.')
        }
        // Onto main's newest commit, or onto another commit of main's line (--onto, a lane dragged there). The
        // lane's own commits are those since it forked, so main's commits between the two are never replayed.
        const onto = options.onto ?? base
        if (options.onto) {
            if (!/^[0-9a-f]{4,40}$/.test(options.onto) || !gitQuiet(['cat-file', '-e', `${options.onto}^{commit}`], dir).ok) fail(`"${options.onto}" is not a commit here.`)
            if (!gitQuiet(['merge-base', '--is-ancestor', options.onto, base], dir).ok) fail(`${options.onto} is not on ${base}: a lane is rebased onto a commit of ${base}.`)
        }
        const fork = gitQuiet(['merge-base', base, 'HEAD'], dir).out
        if (!fork) fail(`${name} shares no history with ${base}.`)
        const ontoSha = git(['rev-parse', onto], dir)
        if (fork === ontoSha) { log(`${name} is on ${options.onto ? options.onto.slice(0, 7) : `top of ${base}`} already`); return }
        const wasAt = git(['rev-parse', '--short', 'HEAD'], dir)
        log(`rebasing ${name} onto ${options.onto ? `${base}'s ${ontoSha.slice(0, 7)}` : base} ${DIM}(was ${wasAt}: git reset --hard ${wasAt} puts it back)${OFF}`)
        const replayed = spawnSync('git', ['rebase', '--onto', ontoSha, fork], { cwd: dir, stdio: 'inherit', env })
        if (replayed.status !== 0) {
            if (inRebase(dir)) stoppedMidRebase(name, dir)
            fail('git rebase did not finish (above).')
        }
    }
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}REBASED${OFF}  ·  ${name}  ·  on ${git(['rev-parse', '--short', `${git(['merge-base', base, 'HEAD'], dir)}`], dir)} of ${base}\n${rule}\n`)
}

/**
 * Commit what is uncommitted in a lane: a commit of its own with the message given, or with `--amend` into the
 * lane's newest commit, keeping its message unless one is given. Every file, or only those named after `--`.
 * `--amend` with a message and nothing uncommitted rewords the newest commit.
 *
 * AMEND ONLY WHAT IS THE LANE'S. A lane with no commits of its own has the integration branch's
 * commit at its head; amending that would rewrite main's history under every other lane.
 */
const commitIn = (config, name, options) => {
    const lane = laneNamed(config, name, 'commit')
    const dir = lane.path
    if (inRebase(dir)) fail(`${name} is part-way through a rebase: resolve and continue it instead.`)
    const message = (options.message ?? '').trim()
    if (!options.amend && !message) fail('a commit needs a message: -m "what it does"')
    const own = Number(gitQuiet(['rev-list', '--count', `${config.integrationBranch}..HEAD`], dir).out || 0)
    if (options.amend && !own) fail(`${name} has no commit of its own to amend: its newest commit is ${config.integrationBranch}'s.`)
    // A new message for the newest commit and nothing else, whatever is uncommitted: git commit --amend --only.
    if (options.reword) {
        if (!own) fail(`${name} has no commit of its own to reword: its newest commit is ${config.integrationBranch}'s.`)
        if (!message) fail('a reword needs the new message: -m "what it does"')
        if ((options.paths ?? []).length) fail('a reword changes the message only: name no files')
        const reworded = spawnSync('git', ['commit', '-q', '--amend', '--only', '-m', message], { cwd: dir, stdio: 'inherit', env: { ...process.env, GIT_EDITOR: 'true' } })
        if (reworded.status !== 0) fail('git commit did not finish (above).')
        const rule = '─'.repeat(64)
        console.log(`\n${rule}\n  ${GREEN}REWORDED${OFF}  ·  ${name}  ·  ${gitQuiet(['log', '-1', '--format=%h %s'], dir).out}\n${rule}\n`)
        return
    }
    const changed = changesOf(dir, config)
    const paths = options.paths ?? []
    const stray = paths.filter((file) => !changed.some((change) => change.path === file))
    if (stray.length) fail(`not uncommitted in ${name}: ${stray.join(', ')}`)
    if (!changed.length && !options.amend) fail(`${name} has nothing uncommitted to commit.`)
    if (!changed.length && options.amend && !message) fail(`${name} has nothing uncommitted to amend with: give a new message with -m to reword its newest commit.`)
    if (paths.length) git(['add', '-A', '--', ...paths], dir)
    else if (changed.length) git(['add', '-A'], dir)
    const args = ['commit', '-q', ...(options.amend ? ['--amend', ...(message ? ['-m', message] : ['--no-edit'])] : ['-m', message]),
        ...(paths.length ? ['--', ...paths] : [])]
    const made = spawnSync('git', args, { cwd: dir, stdio: 'inherit', env: { ...process.env, GIT_EDITOR: 'true' } })
    if (made.status !== 0) fail('git commit did not finish (above).')
    const head = gitQuiet(['log', '-1', '--format=%h %s'], dir).out
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}${options.amend ? 'AMENDED' : 'COMMITTED'}${OFF}  ·  ${name}  ·  ${head}\n${rule}\n`)
}

/**
 * Take a lane's newest commit back out, keeping what it changed as uncommitted work: `git reset --soft HEAD~1`.
 *
 * ONLY THE LANE'S OWN, never a commit of the integration branch. A commit already pushed may be uncommitted
 * too: the next push then asks before replacing origin's copy, as after a rebase.
 */
const uncommit = (config, name) => {
    const lane = laneNamed(config, name, 'uncommit')
    const dir = lane.path
    if (inRebase(dir)) fail(`${name} is part-way through a rebase: resolve and continue it instead.`)
    const own = Number(gitQuiet(['rev-list', '--count', `${config.integrationBranch}..HEAD`], dir).out || 0)
    if (!own) fail(`${name} has no commit of its own to uncommit: its newest commit is ${config.integrationBranch}'s.`)
    const sha = git(['rev-parse', 'HEAD'], dir)
    const was = gitQuiet(['log', '-1', '--format=%h %s'], dir).out
    git(['reset', '-q', '--soft', 'HEAD~1'], dir)
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}UNCOMMITTED${OFF}  ·  ${name}  ·  ${was}\n${rule}\n`)
    log(`what it changed is uncommitted again ${DIM}(git reset --soft ${sha.slice(0, 12)} puts the commit back)${OFF}`)
}

/**
 * Throw away what is uncommitted in the files named, in a lane: a changed or deleted file goes back to the lane's
 * newest commit, and a new one is removed.
 *
 * THE FILES NAMED, and only files that are uncommitted: there is no "discard everything" here, and nothing
 * committed is touched. What is thrown away is gone; nothing keeps a copy.
 */
const discard = (config, name, options) => {
    const lane = laneNamed(config, name, 'discard')
    const dir = lane.path
    const paths = options.paths ?? []
    if (!paths.length) fail(`lane discard needs the files: lane discard ${name} -- <file>…`)
    if (inRebase(dir)) fail(`${name} is part-way through a rebase: resolve and continue it, or abort it, instead.`)
    const changed = changesOf(dir, config)
    const named = paths.map((file) => changed.find((change) => change.path === file) ?? { path: file, status: null })
    const stray = named.filter((change) => !change.status).map((change) => change.path)
    if (stray.length) fail(`not uncommitted in ${name}: ${stray.join(', ')}`)
    const fresh = named.filter((change) => change.status === '?').map((change) => change.path)
    const tracked = named.filter((change) => change.status !== '?').map((change) => change.path)
    if (tracked.length) git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked], dir)
    if (fresh.length) git(['clean', '-q', '-f', '-d', '--', ...fresh], dir)
    const left = changesOf(dir, config).filter((change) => paths.includes(change.path))
    if (left.length) fail(`these are still uncommitted after the discard: ${left.map((change) => change.path).join(', ')}`)
    log(`discarded ${paths.length === 1 ? paths[0] : `${paths.length} files`} in ${name}`)
}

/**
 * Mark files resolved in a lane stopped part-way through a rebase: `git add`, once each has no conflict markers
 * left. `lane rebase <name> --continue` carries on when every file is.
 */
const resolve = (config, name, options) => {
    const lane = laneNamed(config, name, 'resolve')
    const dir = lane.path
    const paths = options.paths ?? []
    if (!paths.length) fail(`lane resolve needs the files: lane resolve ${name} -- <file>…`)
    if (!inRebase(dir)) fail(`${name} is not part-way through a rebase: there is nothing to resolve.`)
    const unmerged = conflictsIn(dir)
    const stray = paths.filter((file) => !unmerged.includes(file))
    if (stray.length) fail(`not in conflict in ${name}: ${stray.join(', ')}`)
    for (const file of paths) {
        const full = path.join(dir, file)
        if (!fs.existsSync(full)) continue   // resolved by deleting it: git add records that
        const lines = fs.readFileSync(full, 'utf8').split('\n')
        const at = lines.findIndex((line) => /^(<{7}|>{7})(\s|$)/.test(line) || /^={7}$/.test(line))
        if (at !== -1) fail(`${file} still has a conflict marker at line ${at + 1}: resolve it there first.`)
    }
    git(['add', '-A', '--', ...paths], dir)
    const left = conflictsIn(dir)
    log(`marked ${paths.join(', ')} resolved in ${name}${left.length ? `; ${left.length} still in conflict` : `: every conflict is resolved, and lane rebase ${name} --continue carries on`}`)
}

/**
 * Set a lane aside, or bring it back: a person's word that it is not being worked on now. Nothing is removed or
 * stopped; the page leaves it out of the landing order and the log, and lists it apart. Kept in the clone's own git
 * settings (branch.<branch>.lanekitAside), so nothing is committed and every lane of the clone reads it.
 */
const ASIDE = (branch) => `branch.${branch}.lanekitAside`
const aside = (config, name) => {
    const lane = laneNamed(config, name, 'aside')
    const mainRepo = mainRepoFrom(process.cwd())
    const branch = lane.branch ?? name
    if (gitQuiet(['config', '--get', ASIDE(branch)], mainRepo).ok) { log(`${name} is set aside already`); return }
    git(['config', ASIDE(branch), new Date().toISOString()], mainRepo)
    log(`set ${name} aside: out of the landing order, listed apart, nothing removed ${DIM}(lane resume ${name} brings it back)${OFF}`)
}
const resume = (config, name) => {
    const lane = laneNamed(config, name, 'resume')
    const mainRepo = mainRepoFrom(process.cwd())
    const branch = lane.branch ?? name
    if (!gitQuiet(['config', '--get', ASIDE(branch)], mainRepo).ok) fail(`${name} is not set aside.`)
    git(['config', '--unset', ASIDE(branch)], mainRepo)
    log(`${name} is back in the landing order`)
}

/**
 * Drop a lane no longer wanted: stop what serves on its port, remove its folder, and keep its branch, so that
 * `lane new <name> --existing` brings it back. The lane's own work is in its branch and nowhere else unless it was
 * pushed, which it says.
 *
 * NOT A LANE WITH WORK IN NO COMMIT. Uncommitted changes would go with the folder, so a lane with any is refused:
 * commit them, or discard them, first. Nor one part-way through a rebase, nor the lane you are standing in. The
 * branch is never deleted here; that is a step of its own, which it names.
 */
const drop = (config, name, options) => {
    const lane = laneNamed(config, name, 'drop')
    const mainRepo = mainRepoFrom(process.cwd())
    const dir = lane.path
    const branch = lane.branch ?? name
    if (isUnder(process.cwd(), dir)) fail(`${name} is the lane you are standing in.\n\n  cd ${mainRepo} first — removing it from inside takes the ground with it.`)
    if (inRebase(dir)) fail(`${name} is part-way through a rebase: lane rebase ${name} --abort (or --continue) first.`)
    const changed = changesOf(dir, config)
    if (changed.length) {
        fail(`${name} has ${changed.length} uncommitted ${changed.length === 1 ? 'change' : 'changes'}, which would go with its folder:\n\n` +
            changed.slice(0, 10).map((change) => `  ${change.status === '?' ? '??' : change.status.padStart(2)} ${change.path}`).join('\n') +
            `\n\n  Commit them, or lane discard ${name} -- <file>… them, first.`)
    }
    const own = Number(gitQuiet(['rev-list', '--count', `${config.integrationBranch}..${branch}`], mainRepo).out || 0)
    const upstream = gitQuiet(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], mainRepo)
    const unpushed = upstream.ok ? Number(gitQuiet(['rev-list', '--count', `${upstream.out}..${branch}`], mainRepo).out || 0) : own
    const where = !own ? 'it has no commits of its own'
        : !upstream.ok ? `its ${own} ${own === 1 ? 'commit is' : 'commits are'} in the branch ${branch} here and nowhere else: it was never pushed`
            : unpushed ? `${upstream.out} has some of it; ${unpushed} ${unpushed === 1 ? 'commit is' : 'commits are'} only in the branch here`
                : `${upstream.out} has all of it as well`
    const port = portOf(lane, config)
    const holders = port ? listenersOn(port) : []
    if (options.dryRun) {
        if (holders.length) log(`${name}: would stop ${holders.length} process on ${port}`)
        log(`${name}: would remove ${dir}, and keep its branch ${branch} (${where})`)
        return
    }
    for (const pid of holders) {
        try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
    }
    if (holders.length) log(`${name}: stopped ${holders.length} process on ${port}`)
    const removed = spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: mainRepo, encoding: 'utf8' })
    if (removed.status !== 0) fail(`could not remove ${dir}: ${(removed.stderr ?? '').trim().split('\n')[0]}`)
    if (fs.existsSync(dir)) fail(`${dir} is still there after git worktree remove; nothing else was done.`)
    gitQuiet(['config', '--unset', ASIDE(branch)], mainRepo)
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}DROPPED${OFF}  ·  ${name}  ·  folder removed, branch ${branch} kept\n${rule}\n`)
    log(`${where}`)
    log(`lane new ${name} --existing brings it back; git branch -D ${branch} deletes the branch, when you are sure`)
}

/**
 * Push a lane's branch to origin.
 *
 * A BRANCH REBASED AFTER IT WAS PUSHED is refused until asked again with
 * `--force-with-lease`, which replaces origin's copy only if nobody pushed to it since this
 * lane last fetched: the question is the person's, and the lease keeps anybody else's work.
 */
const push = (config, name, options) => {
    const lane = laneNamed(config, name, 'push')
    const dir = lane.path
    const branch = lane.branch ?? name
    if (!gitQuiet(['remote'], dir).out.split('\n').includes('origin')) fail('there is no remote called origin to push to.')
    const upstream = gitQuiet(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], dir)
    if (upstream.ok) {
        const [behind, ahead] = gitQuiet(['rev-list', '--left-right', '--count', `${upstream.out}...${branch}`], dir).out.split(/\s+/).map(Number)
        if (!ahead && !behind) { log(`${branch} is pushed already: origin has what this lane has`); return }
        if (behind && !options.forceWithLease) {
            fail(`${upstream.out} has ${behind} ${behind === 1 ? 'commit' : 'commits'} this lane does not: it was rebased since it was pushed.\n\n` +
                `  lane push ${name} --force-with-lease replaces them, unless somebody pushed to it since this lane last fetched.`)
        }
    }
    const args = ['push', ...(options.forceWithLease ? ['--force-with-lease'] : []), ...(upstream.ok ? [] : ['-u']), 'origin', branch]
    log(`git ${args.join(' ')}`)
    const pushed = spawnSync('git', args, { cwd: dir, stdio: 'inherit' })
    if (pushed.status !== 0) fail('origin refused the push (above).')
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}PUSHED${OFF}  ·  ${name}  ·  origin/${branch} at ${git(['rev-parse', '--short', 'HEAD'], dir)}\n${rule}\n`)
}

/** Open a pull request for a lane's pushed branch, through `gh`, from its commits' own words. */
const pr = (config, name) => {
    const lane = laneNamed(config, name, 'pr')
    const dir = lane.path
    const branch = lane.branch ?? name
    const gh = (args, stdio = 'pipe') => spawnSync('gh', args, { cwd: dir, encoding: 'utf8', stdio: stdio === 'pipe' ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } })
    const version = gh(['--version'])
    if (version.error) fail('gh is not installed here, and a pull request is made through it.')
    const upstream = gitQuiet(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], dir)
    if (!upstream.ok) fail(`${branch} is not pushed yet: lane push ${name} first.`)
    const ahead = gitQuiet(['rev-list', '--count', `${upstream.out}..${branch}`], dir).out
    if (ahead !== '0') fail(`${branch} has ${ahead} ${ahead === '1' ? 'commit' : 'commits'} origin does not: lane push ${name} first.`)
    const existing = gh(['pr', 'view', branch, '--json', 'url,state', '--jq', 'select(.state == "OPEN") | .url'])
    if (existing.status === 0 && existing.stdout.trim()) { log(`${branch} has an open pull request already: ${existing.stdout.trim()}`); return }
    log(`gh pr create --base ${config.integrationBranch} --head ${branch} --fill`)
    const made = gh(['pr', 'create', '--base', config.integrationBranch, '--head', branch, '--fill'], 'inherit')
    if (made.status !== 0) fail('gh did not make the pull request (above). gh auth status says whether it is signed in.')
}

/**
 * Fast-forward the integration branch in the main checkout to what origin has, as of the
 * last fetch. Only a fast-forward: a main that has diverged from origin needs a person.
 */
const pull = (config) => {
    const mainRepo = mainRepoFrom(process.cwd())
    const base = config.integrationBranch
    const current = gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD'], mainRepo).out
    if (current !== base) fail(`${mainRepo} is on "${current}", not ${base}: a pull brings ${base}.`)
    const dirt = dirtIn(mainRepo, config)
    if (dirt.length) fail(`${base} has uncommitted changes.\n\n${dirt.map((line) => `  ${line}`).join('\n')}\n\n  Commit or stash them first.`)
    const upstream = gitQuiet(['rev-parse', '--abbrev-ref', `${base}@{upstream}`], mainRepo)
    if (!upstream.ok) fail(`${base} has no upstream to pull from.`)
    const [behind, ahead] = gitQuiet(['rev-list', '--left-right', '--count', `${upstream.out}...${base}`], mainRepo).out.split(/\s+/).map(Number)
    if (!behind) { log(`${base} has everything ${upstream.out} has, as of the last fetch`); return }
    if (ahead) fail(`${base} and ${upstream.out} have diverged: ${ahead} here, ${behind} there. That needs a person, not a fast-forward.`)
    const was = git(['rev-parse', '--short', 'HEAD'], mainRepo)
    const merged = spawnSync('git', ['merge', '--ff-only', upstream.out], { cwd: mainRepo, stdio: 'inherit' })
    if (merged.status !== 0) fail('git merge --ff-only did not finish (above).')
    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}PULLED${OFF}  ·  ${base}  ·  ${was} -> ${git(['rev-parse', '--short', 'HEAD'], mainRepo)}, ${behind} ${behind === 1 ? 'commit' : 'commits'}\n${rule}\n`)
}

// ---------------------------------------------------------------------------

const COMMANDS = { new: create, list, sweep, queue, land, rebase, push, pr, pull, commit: commitIn, uncommit, discard, resolve, aside, resume, drop }

const main = () => {
    const argv = process.argv.slice(2)
    const command = argv[0]
    // The page reads every repository it is pointed at, each with its own config, so it
    // is started before this one's is looked for: /work above the checkouts has none.
    if (command === 'web') return import('./web.mjs').then((web) => web.main(argv.slice(1)))
    // An agent's hook saying what it is doing: it needs no config, and never fails the agent.
    if (command === 'report') return import('../lib/agents.mjs').then((agents) => agents.reportMain(argv.slice(1)))
    if (!command || !(command in COMMANDS)) {
        console.error(`\n  usage: lane <new|list|sweep|queue|land|rebase|push|pr|pull|commit|uncommit|discard|resolve|aside|resume|drop|web> [name] [--base <ref>] [--install] [--existing] [--no-provision] [--no-seed] [--no-sweep] [--force] [--dry-run] [--continue|--abort] [--onto <commit>] [--force-with-lease] [-m <message>] [--amend|--reword] [-- <file>…]\n`)
        process.exit(2)
    }

    const options = {
        base: argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : undefined,
        provision: !argv.includes('--no-provision'),
        install: argv.includes('--install'),
        existing: argv.includes('--existing'),
        seed: !argv.includes('--no-seed'),
        dryRun: argv.includes('--dry-run'),
        sweep: !argv.includes('--no-sweep'),
        force: argv.includes('--force'),
        continue: argv.includes('--continue'),
        abort: argv.includes('--abort'),
        forceWithLease: argv.includes('--force-with-lease'),
        onto: argv.includes('--onto') ? argv[argv.indexOf('--onto') + 1] : undefined,
        amend: argv.includes('--amend'),
        reword: argv.includes('--reword'),
        message: argv.includes('-m') ? argv[argv.indexOf('-m') + 1] : undefined,
        // The files a commit, a discard or a resolve is about: everything after `--`.
        paths: argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : []
    }
    // What follows a flag that takes a value is the value, not a name; what follows `--` is a file.
    const valued = new Set(['--base', '--onto', '-m'])
    const flags = argv.includes('--') ? argv.slice(1, argv.indexOf('--')) : argv.slice(1)
    const positional = flags.filter((arg, i, all) => !arg.startsWith('-') && !valued.has(all[i - 1]))
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
    if (command === 'rebase') return rebase(config, name, options)
    if (command === 'push') return push(config, name, options)
    if (command === 'pr') return pr(config, name, options)
    if (command === 'pull') return pull(config, options)
    if (command === 'commit') return commitIn(config, name, options)
    if (command === 'uncommit') return uncommit(config, name, options)
    if (command === 'discard') return discard(config, name, options)
    if (command === 'resolve') return resolve(config, name, options)
    if (command === 'aside') return aside(config, name, options)
    if (command === 'resume') return resume(config, name, options)
    if (command === 'drop') return drop(config, name, options)
    return sweep(config, name, options)
}

main()
