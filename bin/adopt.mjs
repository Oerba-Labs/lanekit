#!/usr/bin/env node
/**
 * Give an existing repository lanes: the files that are the same for every project,
 * written where they are missing and never over anything that is there.
 *
 *     node <lanekit>/bin/adopt.mjs                     in the repository's main checkout
 *     node <lanekit>/bin/adopt.mjs --check             says what it would write, writes nothing
 *     node <lanekit>/bin/adopt.mjs --name "Piano Sheets" --port-base 8300 --agents claude
 *
 * WHY THIS EXISTS BESIDE init. `init` starts a project from nothing and refuses a folder
 * with anything in it, because an existing repository's roots, environment file and tests
 * are decisions already made. Those decisions still need making for lanes, by somebody who
 * reads the repository — a person, or an agent following INSTALL.md — but the rest is
 * mechanical, and mechanical files written by hand come out subtly different each time.
 * So this writes the mechanical part and prints the decisions.
 *
 * WHAT IT WRITES, each only when missing:
 *   lane.config.json    a starting config: the integration branch git names, the
 *                       environment file the repository keeps out of git, a port window
 *                       above every sibling project's
 *   ./<slug>            the shim, the project's one entrypoint to lanekit
 *   ./check             what the gate runs; it passes and says it checked nothing, until
 *                       the project's tests are put in it
 *   .gitignore          a line for .lanekit/ (the gate's records), and one for the
 *                       environment file when git would otherwise see it
 *   /lane and /land     for Claude Code (.claude/commands) and OpenCode (.opencode/commands)
 *
 * Not the agents' status reporters: those are installed once a machine, not once a repository
 * (bin/agent-reports.mjs, or the editor's extension asking).
 *
 * WHAT IT WILL NOT DO. Overwrite a file, commit anything, touch the application's code, or
 * run in a lane or a folder that is not the top of a repository's main checkout.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_NAME } from '../lib/config.mjs'
import { AGENTS, writeAgentCommands } from './claude-commands.mjs'
import { CHECK, configFor, freeWindowBeside, shimFor, slugFor, WINDOW } from './init.mjs'

// Colour for a person at a terminal; plain words for an agent reading a pipe, or NO_COLOR.
const TINT = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
const [RED, GREEN, YELLOW, DIM, OFF] = TINT ? ['\x1b[31m', '\x1b[32m', '\x1b[33m', '\x1b[2m', '\x1b[0m'] : ['', '', '', '', '']

const git = (dir, ...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim() }
}

/** The branch lanes come from and land on: the remote's default, else main, else master, else this one. */
export const integrationBranchOf = (dir) => {
    const remote = git(dir, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    if (remote.ok && remote.out.includes('/')) return remote.out.slice(remote.out.indexOf('/') + 1)
    for (const candidate of ['main', 'master']) {
        if (git(dir, 'rev-parse', '--verify', '--quiet', `refs/heads/${candidate}`).ok) return candidate
    }
    const current = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD')
    return current.ok && current.out !== 'HEAD' ? current.out : 'main'
}

const ignored = (dir, rel) => git(dir, 'check-ignore', '-q', rel).ok
const tracked = (dir, rel) => git(dir, 'ls-files', '--error-unmatch', rel).ok

/**
 * The environment file a lane writes its port into. It must be one git ignores: a lane
 * writing its own port into a tracked file shows as an uncommitted change in every lane.
 */
export const envFileOf = (dir) => {
    const candidates = ['.env', '.env.local', '.env.development.local']
    const kept = candidates.find((rel) => fs.existsSync(path.join(dir, rel)) && !tracked(dir, rel))
    if (kept) return { file: kept, exists: true }
    const free = candidates.find((rel) => !tracked(dir, rel)) ?? '.env.lane'
    return { file: free, exists: false }
}

/** The name to show: the one given, else package.json's, else the folder's. */
const nameOf = (dir, given) => {
    if (given) return given
    try {
        const name = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).name
        if (typeof name === 'string' && name) return name.replace(/^@[^/]+\//, '')
    } catch {
        // no package.json, or one that says nothing usable
    }
    return path.basename(dir)
}

export const adopt = ({ dir, name: givenName, portBase: givenBase, agents = Object.keys(AGENTS), check = false }) => {
    const said = { wrote: [], kept: [], warnings: [] }
    const top = git(dir, 'rev-parse', '--show-toplevel')
    if (!top.ok) throw new Error(`${dir} is not inside a git repository.`)
    if (fs.realpathSync(top.out) !== fs.realpathSync(dir)) throw new Error(`${dir} is not the top of its repository; run this in ${top.out}.`)
    const dotGit = path.join(dir, '.git')
    if (!fs.existsSync(dotGit) || !fs.statSync(dotGit).isDirectory()) {
        throw new Error(`${dir} is a worktree (a lane, perhaps), not a main checkout: run this in the checkout that owns the repository.`)
    }

    const configFile = path.join(dir, CONFIG_NAME)
    let config
    if (fs.existsSync(configFile)) {
        try {
            config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
        } catch (error) {
            throw new Error(`${configFile} is there and is not valid JSON (${error.message}); fix it, or move it aside, first.`)
        }
        said.kept.push(CONFIG_NAME)
    } else {
        const name = nameOf(dir, givenName)
        const slug = slugFor(name)
        if (!slug) throw new Error(`"${name}" leaves nothing once it is made safe for a file name; give --name.`)
        const portBase = givenBase ?? freeWindowBeside(dir)
        if (!Number.isInteger(portBase) || portBase < 1024 || portBase + WINDOW - 1 > 65535) throw new Error(`a port window starting at ${portBase} does not fit between 1024 and 65535.`)
        const env = envFileOf(dir)
        config = configFor(name, slug, portBase, { integrationBranch: integrationBranchOf(dir), envFile: env.file })
        config.note = [
            `What ${name} is, for the lane tooling. Written by lanekit's adopt as a starting point:`,
            'INSTALL.md in lanekit says what each key decides and how to find the answer in this',
            'repository. Until `roots` and `gate` are filled in, every change earns tier 1, which',
            'runs ./check.'
        ]
        if (!env.exists) said.warnings.push(`no environment file is here yet: a lane writes its port into ${env.file}, which lanekit creates`)
        if (!check) fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n')
        said.wrote.push(CONFIG_NAME)
    }
    if (typeof config.slug !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(config.slug)) throw new Error(`${CONFIG_NAME} has no usable slug.`)
    const { name, slug } = config
    const envFile = config.lane?.env?.file ?? '.env'

    const writeFile = (rel, text, mode) => {
        const to = path.join(dir, rel)
        if (fs.existsSync(to)) { said.kept.push(rel); return false }
        if (!check) {
            fs.writeFileSync(to, text)
            if (mode) fs.chmodSync(to, mode)
        }
        said.wrote.push(rel)
        return true
    }
    const isShim = (file) => fs.statSync(file).isFile() && fs.readFileSync(file, 'utf8').includes('the lane tooling')
    if (!writeFile(slug, shimFor(name, slug), 0o755) && !isShim(path.join(dir, slug))) {
        said.warnings.push(`./${slug} is here already and is not lanekit's shim: choose another name (--name, or "slug" in ${CONFIG_NAME}) so the project's entrypoint can be written`)
    }
    if (!writeFile('check', CHECK, 0o755) && !fs.statSync(path.join(dir, 'check')).isFile()) {
        said.warnings.push('./check is here and is not a file: point tier 1 of the gate at the project\'s own test command instead')
    }

    // .gitignore: the gate's records always, the environment file when git would see it.
    const wanted = []
    if (!ignored(dir, '.lanekit/runs.json')) wanted.push('# What the gate records about its runs. It names absolute paths on one machine.', '.lanekit/')
    if (tracked(dir, envFile)) said.warnings.push(`${envFile} is tracked by git: a lane writes its port into it, so every lane would look uncommitted; move the port to an ignored file and name it in lane.env.file`)
    else if (!ignored(dir, envFile)) wanted.push("# A lane's port and paths live in its environment file, and secrets end up there too.", envFile)
    if (wanted.length) {
        const file = path.join(dir, '.gitignore')
        const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
        if (!check) fs.writeFileSync(file, before + (before && !before.endsWith('\n') ? '\n' : '') + (before ? '\n' : '') + wanted.join('\n') + '\n')
        said.wrote.push('.gitignore (' + wanted.filter((line) => !line.startsWith('#')).join(', ') + ')')
    }

    for (const agent of agents) {
        for (const file of ['lane.md', 'land.md']) {
            const rel = path.join(AGENTS[agent].dir, file)
            if (fs.existsSync(path.join(dir, rel))) said.kept.push(rel)
        }
    }
    const commands = check
        ? agents.flatMap((agent) => ['lane.md', 'land.md'].map((file) => path.join(AGENTS[agent].dir, file))).filter((rel) => !fs.existsSync(path.join(dir, rel)))
        : writeAgentCommands(dir, name, slug, { agents })
    said.wrote.push(...commands)
    return { ...said, name, slug, envFile, integrationBranch: config.integrationBranch, portWindow: [config.lane?.portBase, config.lane?.portCeiling] }
}

const main = () => {
    const argv = process.argv.slice(2)
    const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
    const dir = path.resolve(flag('--dir') ?? '.')
    const rawBase = flag('--port-base')
    if (rawBase !== undefined && !/^\d+$/.test(rawBase)) {
        console.error(`\n${RED}  --port-base "${rawBase}" is not a port number.${OFF}\n`)
        process.exit(1)
    }
    const agents = flag('--agents') ? flag('--agents').split(',').filter(Boolean) : Object.keys(AGENTS)
    const unknown = agents.filter((agent) => !AGENTS[agent])
    if (unknown.length) {
        console.error(`\n${RED}  no agent called ${unknown.join(', ')}: ${Object.keys(AGENTS).join(' or ')}.${OFF}\n`)
        process.exit(1)
    }
    const check = argv.includes('--check')
    let done
    try {
        done = adopt({ dir, name: flag('--name'), portBase: rawBase === undefined ? undefined : Number(rawBase), agents, check })
    } catch (error) {
        console.error(`\n${RED}  ${error.message}${OFF}\n`)
        process.exit(1)
    }
    const verb = check ? 'would write' : 'wrote'
    console.log('')
    for (const rel of done.wrote) console.log(`  ${GREEN}${verb}${OFF}  ${rel}`)
    for (const rel of done.kept) console.log(`  ${DIM}kept   ${rel} (it was here)${OFF}`)
    for (const warning of done.warnings) console.log(`  ${YELLOW}note${OFF}   ${warning}`)
    console.log(`\n  ${done.name}: lanes come from ${done.integrationBranch} and take ports ${done.portWindow[0]}–${done.portWindow[1]}.`)
    console.log(`
  Now decide, by reading the repository (INSTALL.md in lanekit walks through each):
    1. How the app picks its port: it must read ${JSON.stringify('PORT')} from ${done.envFile}, or lanes collide.
    2. What a running checkout needs that git does not carry      lane.copyOnCreate
    3. Big folders every lane can share (node_modules, .venv)       lane.linkOnCreate
    4. What each lane must own: its database, its uploads           lane.env.perLane, makeDirs, seed
    5. The tests                                                    ./check
    6. Which paths are the app and which the server                 gate.sides, gate.seam, tier 2

  Then try it:  ./${done.slug} lane new lanekit-trial
`)
    if (check) console.log('  --check: nothing was written.\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main()
