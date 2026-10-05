#!/usr/bin/env node
/**
 * LaneKit's tools for an agent, over the Model Context Protocol: what the lanes page shows and what its buttons do,
 * as tools an agent calls instead of typing commands. Claude Code starts it from LaneKit's plugin
 * (.claude-plugin/plugin.json, claude/mcp.json); any client that speaks MCP over stdio can.
 *
 *     node <lanekit>/bin/mcp.mjs        newline-delimited JSON-RPC 2.0 on stdin and stdout; nothing else on stdout
 *
 * THE PAGE'S RULES, NOT ITS OWN. Every tool that changes anything is a press of lanekit's service (lib/service.mjs),
 * which runs lanekit's own commands and refuses what the page refuses, in the same words: a land without a green gate,
 * a push over somebody's commits, a commit into a pull request already merged. Land and drop are checked with
 * --dry-run first. The client is told which tools only read, which reach GitHub and which remove something
 * (annotations), so it can ask its person before those.
 *
 * WHICH REPOSITORY. The one the tool names (`repo`, any folder in it), else the project the client runs in:
 * LANEKIT_PROJECT, CLAUDE_PROJECT_DIR, then the folder it was started in.
 *
 * No dependency: node's own modules and lanekit's.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

import { PACKAGE_ROOT } from '../lib/config.mjs'
import { createService } from '../lib/service.mjs'
import { findRepos } from '../lib/state.mjs'

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
// lanekit's own commit, as the server's version: which lanekit answers is what a person asks first.
const KIT = (() => {
    const asked = spawnSync('git', ['-c', `safe.directory=${PACKAGE_ROOT}`, 'rev-parse', '--short', 'HEAD'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    return asked.status === 0 ? asked.stdout.trim() : 'unknown'
})()
const OUTPUT_KEPT = 6000

// ---------------------------------------------------------------------------
// which repository, and its service
// ---------------------------------------------------------------------------

/** A folder named by an environment variable, where it names one: a client that does not expand ${…} leaves it so. */
const folderIn = (value) => (value && !value.includes('${') && fs.existsSync(value) ? value : null)
const projectDir = () => folderIn(process.env.LANEKIT_PROJECT) ?? folderIn(process.env.CLAUDE_PROJECT_DIR) ?? folderIn(process.env.PWD) ?? process.cwd()

const services = new Map()   // main checkout -> { service, warm }
/** The repository with lanes a tool is about, and lanekit's service over it: `{ repo, service, warm }`, or `{ error }`. */
const repositoryFor = (asked) => {
    const dir = path.resolve(asked ? String(asked) : projectDir())
    const found = findRepos(dir)
    if (!found.length) return { error: `there is no repository with lanes at ${dir}: \`lane adopt --commit\` there gives it lanes` }
    if (found.length > 1) return { error: `${dir} holds ${found.length} repositories with lanes (${found.map((one) => path.basename(one)).join(', ')}): name one as repo` }
    const root = found[0]
    if (!services.has(root)) services.set(root, { service: createService({ dirs: [root] }), warm: false })
    return { root, ...services.get(root) }
}

/** The repository's state, as the page reads it. Its pull requests come from GitHub in the background, so the first
    reading of a repository asks again a moment later, when they are there. */
const stateOf = async (held) => {
    let state = await held.service.state()
    if (!held.warm) {
        held.warm = true
        await new Promise((resolve) => setTimeout(resolve, 1500))
        state = await held.service.state()
    }
    return state.repos.find((repo) => repo.path === held.root) ?? state.repos[0]
}

// ---------------------------------------------------------------------------
// a press, and waiting for what it ran
// ---------------------------------------------------------------------------

const done = (text, isError = false) => ({ content: [{ type: 'text', text }], isError })
const tail = (text) => (text.length > OUTPUT_KEPT ? `… (the start is cut)\n${text.slice(-OUTPUT_KEPT)}` : text)

/** A press of the service, waited for: what it ran and printed, or why it was refused. */
const pressed = async (held, request, { minutes = 10 } = {}) => {
    const answer = await held.service.press(request)
    if (answer.status >= 400) return { refused: answer.body.error }
    const id = answer.body.id
    const until = Date.now() + minutes * 60 * 1000
    let job = held.service.job(id)
    while (job && job.state !== 'done' && Date.now() < until) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        job = held.service.job(id)
    }
    if (!job) return { refused: 'LaneKit kept nothing of what it ran' }
    if (job.state !== 'done') return { refused: `it is still running after ${minutes} minutes: \`${job.command}\`; lanes shows it when it ends` }
    return { code: job.code, command: job.command, output: job.output }
}
const said = (result, words) => (result.refused
    ? done(`Refused: ${result.refused}.`, true)
    : done(`${result.code === 0 ? words : `It failed (exit ${result.code})`}.\n\n$ ${result.command}\n${tail(result.output)}`, result.code !== 0))

// ---------------------------------------------------------------------------
// what a repository's lanes are, in words an agent reads
// ---------------------------------------------------------------------------

const VERDICTS = { 'land now': 'ready to land', 'gate now': 'needs a gate', 'commit first': 'commit first', 'hold the gate': 'waits for another lane to land', 'rebase first': 'conflicts with main: rebase it', parked: 'part-way' }
const laneWords = (repo, lane) => {
    const base = repo.integrationBranch
    const out = []
    if (lane.kind === 'missing') return `${lane.name}: its folder is gone`
    const state = lane.review ? `reviewing #${lane.review}${lane.pull?.author ? ` by ${lane.pull.author}` : ''}`
        : lane.aside ? 'set aside' : lane.kind === 'landed' ? 'landed' : lane.operation ? `part-way through a ${lane.operation}`
            : lane.pull?.state === 'MERGED' ? `#${lane.pull.number} merged on GitHub` : lane.queue ? VERDICTS[lane.queue.verdict] ?? lane.queue.verdict
                : lane.kind === 'fresh' && !lane.dirty ? 'nothing committed yet' : 'not in the landing order'
    out.push(`- ${lane.name} (${state}) at ${lane.path}, branch ${lane.branch}${lane.port ? `, port ${lane.port}` : ''}`)
    const facts = []
    if (lane.ahead) facts.push(`${lane.ahead} commit${lane.ahead === 1 ? '' : 's'} of its own`)
    if (lane.behind) facts.push(`${lane.behind} behind ${base}`)
    if (lane.upstream) facts.push(lane.upstream.ahead || lane.upstream.behind ? `${lane.upstream.name}: ${lane.upstream.ahead} here not there, ${lane.upstream.behind} there not here${lane.upstream.foreign ? ` (${lane.upstream.foreign} of somebody else's)` : ''}` : `pushed to ${lane.upstream.name}`)
    else if (lane.kind === 'working' && !lane.review) facts.push('not pushed')
    if (lane.gate) facts.push(`gate ${lane.gate.result} at tier ${lane.gate.tier}${lane.gate.current ? '' : ', on an older commit'}`)
    if (lane.pull) facts.push(`#${lane.pull.number} ${lane.pull.draft && lane.pull.state === 'OPEN' ? 'draft' : String(lane.pull.state).toLowerCase()}${lane.pull.review ? `, ${lane.pull.review.toLowerCase().replaceAll('_', ' ')}` : ''}${lane.pull.checks && lane.pull.checks !== 'none' ? `, checks ${lane.pull.checks}` : ''}`)
    if (lane.sinceMerge) facts.push(`${lane.sinceMerge} commit${lane.sinceMerge === 1 ? '' : 's'} made since it was merged`)
    if (facts.length) out.push(`  ${facts.join('; ')}`)
    if (lane.dirty) out.push(`  uncommitted: ${(lane.changes ?? []).slice(0, 12).map((change) => `${change.status === '?' ? 'new' : change.status} ${change.path}`).join(', ')}${lane.dirty > 12 ? `, and ${lane.dirty - 12} more` : ''}`)
    if (lane.conflicts?.length) out.push(`  conflicts in: ${lane.conflicts.join(', ')}`)
    for (const collision of lane.queue?.collisions ?? []) out.push(`  collides with ${collision.lane} in ${collision.paths.slice(0, 5).join(', ')}`)
    return out.join('\n')
}
const repoWords = (repo) => {
    if (repo.error) return `${repo.id}: ${repo.error}`
    const main = repo.main
    const up = main.upstream
    const live = repo.lanes.filter((lane) => lane.kind !== 'landed' && lane.kind !== 'missing' && !lane.aside)
    const set = repo.lanes.filter((lane) => !live.includes(lane))
    const order = live.filter((lane) => lane.queue).sort((a, b) => (a.queue.position ?? 0) - (b.queue.position ?? 0))
    return [
        `${repo.name ?? repo.id} at ${repo.path}: ${repo.integrationBranch} at ${main.head?.short ?? '?'} "${main.head?.subject ?? ''}"` +
            `${up ? `, ${up.ahead} ahead and ${up.behind} behind ${up.name}` : ', no upstream'}`,
        main.dirty ? `The main checkout has ${main.dirty} uncommitted file${main.dirty === 1 ? '' : 's'}: ${(main.changes ?? []).slice(0, 12).map((change) => change.path).join(', ')} (new_lane with carry moves them into a lane; a land and a pull wait until it is clean)` : null,
        main.onIntegration === false ? `The main checkout is on ${main.branch}, not ${repo.integrationBranch}.` : null,
        '',
        live.length ? 'Lanes:' : 'No lanes yet: new_lane makes one.',
        ...live.map((lane) => laneWords(repo, lane)),
        set.length ? `\nSet aside or finished: ${set.map((lane) => `${lane.name} (${lane.aside ? 'set aside' : lane.kind})`).join(', ')}` : null,
        order.length ? `\nLanding order: ${order.map((lane) => `${lane.name} ${VERDICTS[lane.queue.verdict] ?? lane.queue.verdict}`).join('; ')}` : null
    ].filter((line) => line !== null).join('\n')
}

// ---------------------------------------------------------------------------
// the tools
// ---------------------------------------------------------------------------

const REPO = { type: 'string', description: 'Any folder in the repository; the project the client runs in when left out.' }
const LANE = { type: 'string', description: 'The lane\'s name, as lanes lists it.' }
const schema = (properties, required = []) => ({ type: 'object', properties: { ...properties, repo: REPO }, required, additionalProperties: false })

const TOOLS = [
    {
        name: 'lanes',
        description: 'Every lane of the repository and what each needs: its state (ready to land, needs a gate, reviewing a pull request…), its commits, uncommitted files, gate, pull request, collisions, and the landing order; and the main checkout. Read this first, and again after anything changes.',
        inputSchema: schema({}), annotations: { title: 'Lanes', readOnlyHint: true, openWorldHint: false },
        run: async (held) => done(repoWords(await stateOf(held)))
    },
    {
        name: 'new_lane',
        description: 'Start a lane: a folder of its own beside the repository, on its own branch, with its own port and environment. From main by default, or `base`. With `pr`, somebody\'s pull request checked out to review (named review-<number> unless named). With `carry`, the main checkout\'s uncommitted files (or `files` of them) moved into it; with `carry` and `from`, a lane\'s uncommitted work, and with `after`, its commits after that one (a lane whose pull request was merged).',
        inputSchema: schema({
            name: { type: 'string', description: 'Lowercase letters, digits and dashes: it becomes the folder and the branch.' },
            base: { type: 'string', description: 'A commit or branch to start from, instead of main.' },
            pr: { type: 'integer', description: 'A pull request\'s number, to review in the lane.' },
            carry: { type: 'boolean', description: 'Move uncommitted work into the new lane.' },
            from: { type: 'string', description: 'With carry: the lane whose work is moved, instead of the main checkout.' },
            after: { type: 'string', description: 'With carry and from: the commit after which that lane\'s commits are moved too.' },
            files: { type: 'array', items: { type: 'string' }, description: 'With carry: only these uncommitted files.' }
        }),
        annotations: { title: 'New lane', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: async (held, args) => {
            const name = args.name ?? (args.pr ? `review-${args.pr}` : null)
            if (!name) return done('A new lane needs a name (or a pr to review).', true)
            const request = { repo: path.basename(held.root), verb: 'new', name, base: args.base, pr: args.pr, carry: args.carry === true || undefined, from: args.from, after: args.after, paths: args.files }
            const result = await pressed(held, request)
            const lane = !result.refused && result.code === 0 ? (await stateOf(held)).lanes.find((candidate) => candidate.name === name) : null
            return lane ? done(`Made ${name}, at ${lane.path}${lane.port ? `, port ${lane.port}` : ''}: work there, in that folder.\n\n${laneWords(await stateOf(held), lane)}`) : said(result, `Made ${name}`)
        }
    },
    {
        name: 'gate',
        description: 'Gate a lane: rebase it onto main as it is now and run the tests its changes earn, recording the result against its commit. It never merges. Commit first: a gate names a commit. It may take minutes.',
        inputSchema: schema({ lane: LANE }, ['lane']), annotations: { title: 'Gate', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'gate', lane: args.lane }, { minutes: 60 }), `${args.lane} was gated`)
    },
    {
        name: 'commit',
        description: 'Commit what is uncommitted in a lane: every file, or `files`; with `amend`, folded into its newest commit (keeping its message unless one is given). Refused for a lane whose pull request was merged.',
        inputSchema: schema({ lane: LANE, message: { type: 'string', description: 'A title, a blank line, then a description if it needs one.' }, files: { type: 'array', items: { type: 'string' } }, amend: { type: 'boolean' } }, ['lane']),
        annotations: { title: 'Commit', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'commit', lane: args.lane, message: args.message ?? '', amend: args.amend === true, paths: args.files }), `Committed in ${args.lane}`)
    },
    {
        name: 'pull',
        description: 'Fast-forward, fetched first: a lane to what somebody pushed to its branch (for a review lane, what the pull request\'s author pushed), or, with no lane, main to origin\'s.',
        inputSchema: schema({ lane: LANE }), annotations: { title: 'Pull', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'pull', lane: args.lane }), `Pulled ${args.lane ?? 'main'}`)
    },
    {
        name: 'rebase',
        description: 'Replay a lane onto main as it is now (or `onto` a commit of main). A conflict stops it with the files named: resolve them, mark them with resolve, then call again with continue; or abort to put it back.',
        inputSchema: schema({ lane: LANE, onto: { type: 'string' }, continue: { type: 'boolean' }, abort: { type: 'boolean' } }, ['lane']),
        annotations: { title: 'Rebase', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'rebase', lane: args.lane, onto: args.onto, continue: args.continue === true || undefined, abort: args.abort === true || undefined }), `${args.lane} was rebased`)
    },
    {
        name: 'resolve',
        description: 'Mark files of a rebase stopped on a conflict resolved, once no conflict marker is left in them.',
        inputSchema: schema({ lane: LANE, files: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['lane', 'files']),
        annotations: { title: 'Resolve', readOnlyHint: false, destructiveHint: false, openWorldHint: false },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'resolve', lane: args.lane, paths: args.files }), 'Marked resolved')
    },
    {
        name: 'push',
        description: 'Send a lane\'s branch to origin. `replace` once it was rebased since it was pushed (--force-with-lease); never over somebody else\'s commits there. Refused for a review lane.',
        inputSchema: schema({ lane: LANE, replace: { type: 'boolean' } }, ['lane']),
        annotations: { title: 'Push', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'push', lane: args.lane, force: args.replace === true || undefined }), `Pushed ${args.lane}`)
    },
    {
        name: 'pull_request',
        description: 'Open a pull request for a lane, from its commits\' own words (`draft`, `reviewers`, `push` to push it first); on one open already, ask `reviewers`, or `ready` to take it out of draft.',
        inputSchema: schema({ lane: LANE, draft: { type: 'boolean' }, reviewers: { type: 'array', items: { type: 'string' } }, ready: { type: 'boolean' }, push: { type: 'boolean' } }, ['lane']),
        annotations: { title: 'Pull request', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'pr', lane: args.lane, draft: args.draft === true, reviewers: args.reviewers ?? [], ready: args.ready === true, push: args.push === true }), `Done for ${args.lane}'s pull request`)
    },
    {
        name: 'review',
        description: 'Say on GitHub, as its person, what they make of the pull request a review lane holds: approve, request-changes, or comment, with `body` (needed for the last two). Show the person the review and have their yes first: it is theirs, said in their name.',
        inputSchema: schema({ lane: LANE, verdict: { type: 'string', enum: ['approve', 'request-changes', 'comment'] }, body: { type: 'string' } }, ['lane', 'verdict']),
        annotations: { title: 'Review', readOnlyHint: false, destructiveHint: false, openWorldHint: true },
        run: async (held, args) => said(await pressed(held, { repo: path.basename(held.root), verb: 'review', lane: args.lane, verdict: args.verdict, body: args.body ?? '' }), `Reviewed ${args.lane}'s pull request`)
    },
    {
        name: 'land',
        description: 'Merge a lane into main (--no-ff) once its gate is green on its newest commit and it is first among those it collides with, then remove its folder and keep its branch. Checked with --dry-run first. Nothing is pushed. Ask the person before landing.',
        inputSchema: schema({ lane: LANE }, ['lane']), annotations: { title: 'Land', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        run: async (held, args) => {
            const repo = path.basename(held.root)
            const checked = await pressed(held, { repo, verb: 'land', lane: args.lane, dryRun: true })
            if (checked.refused || checked.code !== 0) return said(checked, 'Checked')
            return said(await pressed(held, { repo, verb: 'land', lane: args.lane }), `Landed ${args.lane}`)
        }
    },
    {
        name: 'drop',
        description: 'Remove a lane no longer wanted: what serves on its port stops and its folder goes; its branch is kept (`lane new <name> --existing` brings it back). Refused while it has uncommitted work. Checked with --dry-run first. Ask the person first.',
        inputSchema: schema({ lane: LANE }, ['lane']), annotations: { title: 'Drop', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        run: async (held, args) => {
            const repo = path.basename(held.root)
            const checked = await pressed(held, { repo, verb: 'drop', lane: args.lane, dryRun: true })
            if (checked.refused || checked.code !== 0) return said(checked, 'Checked')
            return said(await pressed(held, { repo, verb: 'drop', lane: args.lane }), `Dropped ${args.lane}`)
        }
    }
]

const call = async (name, args = {}) => {
    const tool = TOOLS.find((candidate) => candidate.name === name)
    if (!tool) return done(`There is no tool called ${name}.`, true)
    const held = repositoryFor(args.repo)
    if (held.error) return done(`${held.error}.`, true)
    try {
        return await tool.run(held, args)
    } catch (error) {
        return done(`LaneKit could not do it: ${error.message}`, true)
    }
}

// ---------------------------------------------------------------------------
// the protocol: JSON-RPC 2.0, one message a line
// ---------------------------------------------------------------------------

const INSTRUCTIONS = 'LaneKit gives each piece of work a lane: a folder of its own beside the repository, on its own branch and port. ' +
    'Call lanes first. Do work in a lane\'s folder, never in the main checkout; commit, gate, and ask the person before land, drop, push or review. ' +
    'What a tool refuses, it says why: follow that rather than working around it.'

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const answer = async (message) => {
    const { id, method, params } = message
    if (id === undefined || id === null) return   // a notification: initialized, cancelled; nothing is owed
    switch (method) {
        case 'initialize': {
            const asked = params?.protocolVersion
            return send({ jsonrpc: '2.0', id, result: {
                protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[1],
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: 'lanekit', version: KIT },
                instructions: INSTRUCTIONS
            } })
        }
        case 'ping': return send({ jsonrpc: '2.0', id, result: {} })
        case 'tools/list': return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ run, ...tool }) => tool) } })
        case 'tools/call': return send({ jsonrpc: '2.0', id, result: await call(params?.name, params?.arguments ?? {}) })
        default: return send({ jsonrpc: '2.0', id, error: { code: -32601, message: `LaneKit does not answer ${method}` } })
    }
}

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', (line) => {
    if (!line.trim()) return
    let message
    try { message = JSON.parse(line) } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'that line is not JSON' } }); return }
    answer(message).catch((error) => send({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32603, message: error.message } }))
})
lines.on('close', () => { for (const { service } of services.values()) service.dispose(); process.exit(0) })
