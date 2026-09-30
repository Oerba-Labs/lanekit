/**
 * `lane web`: a page of every lane, and the buttons that make, gate, land and sweep them.
 *
 *     ./<slug> lane web                       this repository, on 127.0.0.1:13338
 *     node <lanekit>/dev/lane.mjs web --scan /work --port 13338 --ssh-host orpheus.coder \
 *         --browser-editor '../code/?folder='
 *
 * WHAT IT IS FOR. `lane list` and `lane queue` answer in a terminal for one repository at a
 * time; this answers for every repository in a workspace at once, on one page, and keeps
 * answering. Each lane is drawn above the commit of the integration branch it forked from,
 * with its own commits, its port, its gate and the queue's verdict, the way a smartlog
 * draws a stack.
 *
 * EVERY BUTTON IS A COMMAND THAT ALREADY EXISTS. New is `lane new`, Gate is the lane's
 * `gate`, Land is `lane land`, Sweep is `lane sweep`, run exactly as a terminal would run
 * them, and their output comes back to the page. Nothing here merges, removes or decides
 * on its own account, so a refusal on the page is the command's own refusal, word for word.
 * Land and Sweep run their `--dry-run` first and ask; nothing here pushes.
 *
 * WHAT IT WILL NOT DO. Listen anywhere but the loopback: the page is reached through
 * Coder's proxy, which admits only the workspace's owner, or through a forward. Run two
 * commands at once in one repository, because lane commands read the worktrees and the
 * ports and then act on what they read. Sweep a lane that has not landed or that has
 * uncommitted changes, whatever the request says: `git worktree remove --force` takes
 * uncommitted work with it.
 *
 * No dependency: `node:http` and the files in web/.
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { PACKAGE_ROOT } from '../lib/config.mjs'
import { githubFor } from '../lib/github.mjs'
import { findRepos, repoState } from '../lib/state.mjs'

const WEB = path.join(PACKAGE_ROOT, 'web')
const LANE = path.join(PACKAGE_ROOT, 'dev', 'lane.mjs')
const GATE = path.join(PACKAGE_ROOT, 'dev', 'gate.mjs')

const DEFAULT_PORT = 13338
const OUTPUT_CAP = 512 * 1024
const KEEP_JOBS = 30
const BODY_CAP = 16 * 1024
const NAME = /^[a-z0-9][a-z0-9-]*$/
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/

const FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/lanes.css': ['lanes.css', 'text/css; charset=utf-8'],
    '/lanes.js': ['lanes.js', 'text/javascript; charset=utf-8']
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

// lanekit's own commit, for the page's header. A copy shared between users (one checkout, mounted
// read-only into every workspace) belongs to somebody else, which git refuses to read without being
// told this one folder is safe.
const kitVersion = () => {
    const result = spawnSync('git', ['-c', `safe.directory=${PACKAGE_ROOT}`, 'rev-parse', '--short', 'HEAD'], { cwd: PACKAGE_ROOT, encoding: 'utf8' })
    return result.status === 0 ? result.stdout.trim() : null
}

// ---------------------------------------------------------------------------
// jobs: one command at a time per repository, its output kept for the page
// ---------------------------------------------------------------------------

const jobs = new Map()
const busy = new Map()
let sequence = 0

const summary = (job) => ({
    id: job.id, verb: job.verb, repo: job.repo, lane: job.lane, dryRun: job.dryRun,
    command: job.command, state: job.state, code: job.code,
    startedAt: job.startedAt, endedAt: job.endedAt
})

const startJob = ({ repo, verb, lane, dryRun, cwd, command, args }) => {
    const id = `${Date.now().toString(36)}-${++sequence}`
    const shown = [command === process.execPath ? 'node' : command,
        ...args.map((arg) => arg.startsWith(PACKAGE_ROOT) ? path.relative(PACKAGE_ROOT, arg) : arg)].join(' ')
    const job = {
        id, verb, repo: repo.id, lane: lane ?? null, dryRun: Boolean(dryRun),
        command: shown, cwd, state: 'running', code: null,
        startedAt: Date.now(), endedAt: null, text: '', dropped: 0
    }
    jobs.set(id, job)
    busy.set(repo.path, id)
    const finished = [...jobs.values()].filter((kept) => kept.state !== 'running')
    for (const old of finished.slice(0, Math.max(0, jobs.size - KEEP_JOBS))) jobs.delete(old.id)

    const append = (chunk) => {
        job.text += stripAnsi(chunk.toString('utf8'))
        if (job.text.length > OUTPUT_CAP) {
            const cut = job.text.length - OUTPUT_CAP
            job.text = job.text.slice(cut)
            job.dropped += cut
        }
    }
    append(`$ ${shown}\n  in ${cwd}\n\n`)

    const child = spawn(command, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            // Nothing on this page has a terminal to answer a question: fail, never wait.
            GIT_TERMINAL_PROMPT: '0',
            GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes'
        }
    })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const finish = (code, note) => {
        if (job.state !== 'running') return
        if (note) append(`\n${note}\n`)
        job.state = 'done'
        job.code = code
        job.endedAt = Date.now()
        if (busy.get(repo.path) === id) busy.delete(repo.path)
    }
    child.on('error', (error) => finish(-1, `could not start: ${error.message}`))
    child.on('close', (code, signal) => finish(code ?? -1, signal ? `ended by ${signal}` : null))
    return job
}

// ---------------------------------------------------------------------------
// what each button runs, and what it must be true of before it runs
// ---------------------------------------------------------------------------

const refuse = (status, message) => ({ status, body: { error: message } })

const plan = (request, repos) => {
    const repo = repos.find((candidate) => candidate.id === request.repo)
    if (!repo) return refuse(404, `there is no repository "${String(request.repo)}" here`)
    if (repo.error) return refuse(409, repo.error)
    if (busy.has(repo.path)) return refuse(409, `${repo.id} is already running something; wait for it to finish`)

    const dryRun = request.dryRun === true
    const laneNamed = () => repo.lanes.find((candidate) => candidate.name === request.lane)

    switch (request.verb) {
        case 'new': {
            const name = String(request.name ?? '')
            if (!NAME.test(name)) return refuse(400, 'a lane name is lowercase letters, digits and dashes, starting with a letter or digit')
            const args = [LANE, 'new', name]
            if (request.base) {
                const base = String(request.base)
                if (!REF.test(base) || base.includes('..')) return refuse(400, `"${base}" is not a branch or commit name`)
                const resolves = spawnSync('git', ['rev-parse', '--verify', '--quiet', `${base}^{commit}`], { cwd: repo.path })
                if (resolves.status !== 0) return refuse(400, `"${base}" does not name a commit in ${repo.id}`)
                args.push('--base', base)
            }
            return { job: { repo, verb: 'new', lane: name, cwd: repo.path, command: process.execPath, args } }
        }
        case 'gate': {
            const lane = laneNamed()
            if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
            if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
            return { job: { repo, verb: 'gate', lane: lane.name, cwd: lane.path, command: process.execPath, args: [GATE] } }
        }
        case 'land': {
            const lane = laneNamed()
            if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
            return {
                job: {
                    repo, verb: 'land', lane: lane.name, dryRun, cwd: repo.path, command: process.execPath,
                    args: [LANE, 'land', lane.name, ...(dryRun ? ['--dry-run'] : [])]
                }
            }
        }
        case 'sweep': {
            const lane = laneNamed()
            if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
            if (lane.kind !== 'landed') return refuse(409, `${lane.name} has not landed, so there is nothing to sweep`)
            if (lane.dirty) return refuse(409, `${lane.name} has ${lane.dirty} uncommitted ${lane.dirty === 1 ? 'change' : 'changes'}, which a sweep would delete; commit or move them first`)
            return {
                job: {
                    repo, verb: 'sweep', lane: lane.name, dryRun, cwd: repo.path, command: process.execPath,
                    args: [LANE, 'sweep', lane.name, ...(dryRun ? ['--dry-run'] : [])]
                }
            }
        }
        case 'fetch':
            return { job: { repo, verb: 'fetch', cwd: repo.path, command: 'git', args: ['fetch', '--prune'] } }
        default:
            return refuse(400, `"${String(request.verb)}" is not something this page does`)
    }
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

const send = (response, status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // The page's own files and its own API, nothing else: no inline script, no other origin.
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    })
    response.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
}

const readBody = (request) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_CAP) { reject(new Error('too large')); request.destroy() } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
})

/**
 * The route a request is for, from the END of its path.
 *
 * Coder's proxy may hand the path on with its `/@owner/workspace/apps/lanes` prefix or
 * without it, and a forward hands it on bare; matching the tail serves all three, and the
 * page only ever asks for addresses relative to where it was served.
 */
const routeOf = (pathname) => {
    if (pathname.endsWith('/healthz')) return { name: 'health' }
    if (pathname.endsWith('/api/state')) return { name: 'state' }
    if (pathname.endsWith('/api/jobs')) return { name: 'jobs' }
    const job = /\/api\/jobs\/([a-z0-9-]+)$/.exec(pathname)
    if (job) return { name: 'job', id: job[1] }
    for (const [tail, file] of Object.entries(FILES)) {
        if (tail !== '/' && pathname.endsWith(tail)) return { name: 'file', file }
    }
    if (pathname.endsWith('/')) return { name: 'file', file: FILES['/'] }
    return { name: 'missing' }
}

export const startServer = ({ scan, port = DEFAULT_PORT, sshHost = null, browserEditor = null }) => {
    const version = kitVersion()
    const reposNow = () => findRepos(scan).map((repo) => {
        const state = repoState(repo)
        if (state.error) return { ...state, github: { state: 'unknown', error: null } }
        const github = githubFor(repo)
        return {
            ...state,
            github: { state: github.state, error: github.error },
            lanes: state.lanes.map((lane) => ({ ...lane, pull: github.pullFor(lane.branch) }))
        }
    })

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://lanes.invalid')
        const route = routeOf(url.pathname)
        try {
            if (request.method === 'GET' && route.name === 'health') return send(response, 200, 'ok\n', 'text/plain; charset=utf-8')
            if (request.method === 'GET' && route.name === 'file') {
                const [file, type] = route.file
                return send(response, 200, fs.readFileSync(path.join(WEB, file)), type)
            }
            if (request.method === 'GET' && route.name === 'state') {
                return send(response, 200, {
                    at: Date.now(),
                    kit: version,
                    scan,
                    open: { sshHost, browserEditor },
                    repos: reposNow(),
                    jobs: [...jobs.values()].reverse().slice(0, 10).map(summary)
                })
            }
            if (request.method === 'GET' && route.name === 'job') {
                const job = jobs.get(route.id)
                if (!job) return send(response, 404, { error: 'no such job' })
                const from = Math.max(Number(url.searchParams.get('from')) || 0, job.dropped)
                return send(response, 200, {
                    ...summary(job),
                    gap: Number(url.searchParams.get('from')) < job.dropped,
                    output: job.text.slice(from - job.dropped),
                    next: job.dropped + job.text.length
                })
            }
            if (request.method === 'POST' && route.name === 'jobs') {
                // A header a form cannot set and a type a form cannot send: another page cannot
                // press these buttons by posting at this address.
                if (request.headers['x-lanes'] !== '1' || !String(request.headers['content-type']).startsWith('application/json')) {
                    return send(response, 403, { error: 'this address takes presses from the lanes page only' })
                }
                let body
                try {
                    body = JSON.parse(await readBody(request))
                } catch {
                    return send(response, 400, { error: 'the request was not JSON this page understands' })
                }
                const decided = plan(body ?? {}, reposNow())
                if (!decided.job) return send(response, decided.status, decided.body)
                return send(response, 202, summary(startJob(decided.job)))
            }
            return send(response, route.name === 'missing' ? 404 : 405, { error: 'not here' })
        } catch (error) {
            return send(response, 500, { error: error.message })
        }
    })

    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port }))
    })
}

const usage = () => {
    console.error('\n  usage: lane web [--scan <dir>] [--port <port>] [--ssh-host <host>] [--browser-editor <url prefix>]\n')
    process.exit(2)
}

export const main = async (argv) => {
    const value = (flag) => {
        if (!argv.includes(flag)) return undefined
        const given = argv[argv.indexOf(flag) + 1]
        if (given === undefined || given.startsWith('--')) usage()
        return given
    }
    const port = value('--port') === undefined ? DEFAULT_PORT : Number(value('--port'))
    if (!Number.isInteger(port) || port < 0 || port > 65535) usage()
    const scan = path.resolve(value('--scan') ?? process.cwd())
    if (!findRepos(scan).length) {
        console.error(`\n  no repository with lanes in ${scan}, or directly under it; the page will say so until one appears\n`)
    }
    try {
        const started = await startServer({ scan, port, sshHost: value('--ssh-host') ?? null, browserEditor: value('--browser-editor') ?? null })
        console.log(`\n  lanes of ${scan} on http://127.0.0.1:${started.port}/\n`)
    } catch (error) {
        console.error(`\n  could not listen on 127.0.0.1:${port}: ${error.message}\n`)
        process.exit(1)
    }
}
