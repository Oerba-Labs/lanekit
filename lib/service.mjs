/**
 * The lanes, as a service: what the lanes page asks, and what its buttons run, whoever
 * carries the asking. `lane web` carries it over HTTP to a browser (dev/web.mjs); the
 * editor's extension carries it by message to the same page inside VS Code, and asks it
 * besides for the files a commit or a lane changed, which it opens as diffs
 * (vscode/host.mjs). One set of rules for both, so a refusal reads the same in either.
 *
 * EVERY BUTTON IS A COMMAND THAT ALREADY EXISTS. New is `lane new`, Gate is the lane's
 * `gate`, Land is `lane land`, Sweep is `lane sweep`, run exactly as a terminal would run
 * them, their output kept for whoever shows it. Nothing here merges, removes or decides on
 * its own account, so a refusal is the command's own refusal, word for word. Land and
 * Sweep are asked with `--dry-run` first by the page. Nothing pushes but Push, and a push that would
 * replace origin's copy is refused until asked again with `--force-with-lease`. Repositories are fetched
 * by themselves while a page is open (fetchQuietly): origin's refs move, nothing else.
 *
 * WHAT IT WILL NOT DO. Run two commands at once in one repository, because lane commands
 * read the worktrees and the ports and then act on what they read. Sweep a lane that has
 * not landed or that has uncommitted changes, whatever the request says, judged on a
 * fresh reading and not a remembered one: `git worktree remove --force` takes uncommitted
 * work with it. Read a file outside a repository it found, or at anything but a commit.
 *
 * No dependency: node's own modules and the files beside this one.
 */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { PACKAGE_ROOT } from './config.mjs'
import { isUnder } from './lanes.mjs'
import { readRepos } from './read.mjs'

const OUTPUT_CAP = 512 * 1024
const KEEP_JOBS = 30
const SHOW_CAP = 64 * 1024 * 1024
const NAME = /^[a-z0-9][a-z0-9-]*$/
const REF = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/
const SHA = /^[0-9a-f]{4,64}$/

// eslint-disable-next-line no-control-regex
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')

const summary = (job) => ({
    id: job.id, verb: job.verb, repo: job.repo, lane: job.lane, dryRun: job.dryRun,
    command: job.command, state: job.state, code: job.code,
    startedAt: job.startedAt, endedAt: job.endedAt, step: job.step ?? null
})

// A gate says what it is doing in lines of its own ("[gate  12s] running ./check…"): the newest is the step.
// eslint-disable-next-line no-control-regex
const GATE_STEP = /^\[gate\s+\d+s\]\s+(.+)$/gm

const refuse = (status, message) => ({ status, body: { error: message } })

const git = (cwd, args, { buffer = false } = {}) => new Promise((resolve) => {
    execFile('git', args, {
        cwd, encoding: buffer ? 'buffer' : 'utf8', maxBuffer: SHOW_CAP,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
    }, (error, stdout) => resolve({ ok: !error, out: stdout }))
})

/** `git … --name-status -z`, as `{ status, path, from? }`: A, M, D, R (with `from`), C, T. */
export const parseNameStatus = (out) => {
    const parts = out.split('\0')
    const files = []
    for (let i = 0; i < parts.length;) {
        const status = parts[i++]
        if (!status) continue
        const code = status[0]
        if (code === 'R' || code === 'C') {
            const from = parts[i++]
            files.push({ status: code, path: parts[i++], from })
        } else {
            files.push({ status: code, path: parts[i++] })
        }
    }
    return files.filter((file) => file.path)
}

/** A path inside a repository as git names it: relative, forward, never climbing out. */
const safeRel = (rel) => typeof rel === 'string' && rel.length > 0 && !path.isAbsolute(rel) &&
    !rel.split(/[\\/]/).includes('..') && !rel.includes('\0')

/** Readings in a worker thread, one at a time; a worker that dies is replaced at the next ask. */
const workerReader = () => {
    let worker = null
    let sequence = 0
    const waiting = new Map()
    const start = () => {
        worker = new Worker(new URL('./read-worker.mjs', import.meta.url))
        worker.unref()
        worker.on('message', ({ id, repos, error }) => {
            const ask = waiting.get(id)
            if (!ask) return
            waiting.delete(id)
            if (error) ask.reject(new Error(error)); else ask.resolve(repos)
        })
        const lost = (why) => {
            for (const ask of waiting.values()) ask.reject(new Error(`the lanes reader stopped: ${why}`))
            waiting.clear()
            worker = null
        }
        worker.on('error', (error) => lost(error.message))
        worker.on('exit', (code) => lost(`exit ${code}`))
    }
    return {
        read: (dirs, forget = []) => new Promise((resolve, reject) => {
            if (!worker) start()
            const id = ++sequence
            waiting.set(id, { resolve, reject })
            worker.postMessage({ id, dirs, forget })
        }),
        dispose: () => { worker?.terminate(); worker = null }
    }
}

/**
 * A service over the repositories in `dirs` (see state.mjs, findRepos, for what is found).
 *
 *   reader   'inline' reads in this thread; 'worker' in a worker thread, for a host that
 *            must never wait (the editor's).
 *   node     what runs lane.mjs and gate.mjs. Inside an editor's own process that binary is
 *            Electron, which runs a script as node only when told to.
 */
export const createService = ({ dirs = [], reader = 'inline', packageRoot = PACKAGE_ROOT, node = process.execPath } = {}) => {
    const LANE = path.join(packageRoot, 'dev', 'lane.mjs')
    const GATE = path.join(packageRoot, 'dev', 'gate.mjs')
    // lanekit's own commit. A copy shared between users (one checkout, mounted read-only into every
    // workspace) belongs to somebody else, which git refuses to read unless told this folder is safe.
    const kitResult = spawnSync('git', ['-c', `safe.directory=${packageRoot}`, 'rev-parse', '--short', 'HEAD'], { cwd: packageRoot, encoding: 'utf8' })
    const kit = kitResult.status === 0 ? kitResult.stdout.trim() : null
    const electron = node === process.execPath && Boolean(process.versions.electron)

    const events = new EventEmitter()
    const jobs = new Map()
    const busy = new Map()
    let sequence = 0
    let roots = [...dirs]
    let last = { at: 0, repos: [] }

    const worker = reader === 'worker' ? workerReader() : null
    // Asks that arrive while a reading is out share it: the second asker wants what is
    // there now, and the reading under way is about now.
    let inFlight = null
    // Repositories whose GitHub answers went stale here (a push, a pull request): asked again at the next reading.
    const forget = new Set()
    const readNow = () => {
        if (inFlight) return inFlight
        const asked = roots.slice()
        const stale = [...forget]
        forget.clear()
        inFlight = (worker ? worker.read(asked, stale) : Promise.resolve().then(() => readRepos(asked, stale)))
            .then((repos) => { last = { at: Date.now(), repos }; return repos })
            .finally(() => { inFlight = null })
        return inFlight
    }

    // -----------------------------------------------------------------------
    // jobs: one command at a time per repository, its output kept
    // -----------------------------------------------------------------------

    const startJob = ({ repo, verb, lane, dryRun, cwd, command, args }) => {
        const id = `${Date.now().toString(36)}-${++sequence}`
        const shown = [command === node ? 'node' : command,
            ...args.map((arg) => arg.startsWith(packageRoot) ? path.relative(packageRoot, arg) : arg)].join(' ')
        const job = {
            id, verb, repo: repo.id, repoPath: repo.path, lane: lane ?? null, dryRun: Boolean(dryRun),
            command: shown, cwd, state: 'running', code: null,
            startedAt: Date.now(), endedAt: null, text: '', dropped: 0
        }
        jobs.set(id, job)
        busy.set(repo.path, id)
        const finished = [...jobs.values()].filter((kept) => kept.state !== 'running')
        for (const old of finished.slice(0, Math.max(0, jobs.size - KEEP_JOBS))) jobs.delete(old.id)

        const append = (chunk) => {
            const text = stripAnsi(chunk.toString('utf8'))
            job.text += text
            if (verb === 'gate') for (const match of text.matchAll(GATE_STEP)) job.step = match[1].trim()
            if (job.text.length > OUTPUT_CAP) {
                const cut = job.text.length - OUTPUT_CAP
                job.text = job.text.slice(cut)
                job.dropped += cut
            }
            events.emit('output', summary(job), text)
        }
        append(`$ ${shown}\n  in ${cwd}\n\n`)

        const child = spawn(command, args, {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                ...(electron && command === node ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
                // Nothing here has a terminal to answer a question: fail, never wait.
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
            if (verb === 'push' || verb === 'pr') forget.add(repo.path)
            events.emit('done', summary(job))
        }
        child.on('error', (error) => finish(-1, `could not start: ${error.message}`))
        child.on('close', (code, signal) => finish(code ?? -1, signal ? `ended by ${signal}` : null))
        events.emit('started', summary(job))
        return job
    }

    /** What a press would run, or why it may not. */
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
                return { job: { repo, verb: 'new', lane: name, cwd: repo.path, command: node, args } }
            }
            case 'gate': {
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
                return { job: { repo, verb: 'gate', lane: lane.name, cwd: lane.path, command: node, args: [GATE] } }
            }
            case 'land': {
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                return {
                    job: {
                        repo, verb: 'land', lane: lane.name, dryRun, cwd: repo.path, command: node,
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
                        repo, verb: 'sweep', lane: lane.name, dryRun, cwd: repo.path, command: node,
                        args: [LANE, 'sweep', lane.name, ...(dryRun ? ['--dry-run'] : [])]
                    }
                }
            }
            case 'rebase': {
                // A lane onto the integration branch; `continue` or `abort` a rebase that stopped on a conflict.
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
                const step = request.continue === true ? '--continue' : request.abort === true ? '--abort' : null
                if (step && lane.operation !== 'rebase') return refuse(409, `${lane.name} is not part-way through a rebase`)
                if (!step && lane.operation) return refuse(409, `${lane.name} is part-way through a ${lane.operation}: finish or abort it first`)
                if (!step && lane.dirty) return refuse(409, `${lane.name} has ${lane.dirty} uncommitted ${lane.dirty === 1 ? 'change' : 'changes'}: a rebase replays commits, and these are in none`)
                // Onto a commit of the integration branch's line: a lane dragged onto one on the page.
                const onto = request.onto ? String(request.onto) : null
                if (onto && (step || !SHA.test(onto))) return refuse(400, `"${onto}" is not a commit to rebase onto`)
                if (onto && !repo.spine.some((commit) => commit.sha === onto || commit.short === onto)) return refuse(400, `${onto.slice(0, 7)} is not one of ${repo.integrationBranch}'s commits shown`)
                return { job: { repo, verb: 'rebase', lane: lane.name, cwd: repo.path, command: node, args: [LANE, 'rebase', lane.name, ...(step ? [step] : []), ...(onto ? ['--onto', onto] : [])] } }
            }
            case 'push': {
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
                if (lane.operation) return refuse(409, `${lane.name} is part-way through a ${lane.operation}: finish or abort it first`)
                return { job: { repo, verb: 'push', lane: lane.name, cwd: repo.path, command: node, args: [LANE, 'push', lane.name, ...(request.force === true ? ['--force-with-lease'] : [])] } }
            }
            case 'pr': {
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
                return { job: { repo, verb: 'pr', lane: lane.name, cwd: repo.path, command: node, args: [LANE, 'pr', lane.name] } }
            }
            case 'pull':
                return { job: { repo, verb: 'pull', cwd: repo.path, command: node, args: [LANE, 'pull'] } }
            case 'commit': {
                // Everything uncommitted in a lane, as a commit of its own, or into its newest (`amend`).
                const lane = laneNamed()
                if (!lane) return refuse(404, `there is no lane "${String(request.lane)}" in ${repo.id}`)
                if (!lane.exists) return refuse(409, `${lane.name}'s folder is gone`)
                if (lane.operation) return refuse(409, `${lane.name} is part-way through a ${lane.operation}: resolve and continue it instead`)
                const amend = request.amend === true
                const message = String(request.message ?? '').trim()
                if (!amend && !message) return refuse(400, 'a commit needs a message')
                if (message.length > 5000 || message.includes('\0')) return refuse(400, 'that message is not one git can take')
                if (amend && !lane.ahead) return refuse(409, `${lane.name} has no commit of its own to amend`)
                if (!amend && !lane.dirty) return refuse(409, `${lane.name} has nothing uncommitted`)
                return {
                    job: {
                        repo, verb: 'commit', lane: lane.name, cwd: repo.path, command: node,
                        args: [LANE, 'commit', lane.name, ...(amend ? ['--amend'] : []), ...(message ? ['-m', message] : [])]
                    }
                }
            }
            case 'fetch':
                return { job: { repo, verb: 'fetch', cwd: repo.path, command: 'git', args: ['fetch', '--prune'] } }
            default:
                return refuse(400, `"${String(request.verb)}" is not something this page does`)
        }
    }

    // -----------------------------------------------------------------------
    // what a commit, a lane or a checkout changed, for the editor's diffs
    // -----------------------------------------------------------------------

    // A diff reopened with the window can ask before anything has been read: read first.
    const repoAt = async (repoPath) => {
        if (!last.at) await readNow().catch(() => null)
        return last.repos.find((repo) => repo.path === repoPath && !repo.error) ?? null
    }
    const checkoutsOf = (repo) => [repo.main?.path ?? repo.path, ...repo.lanes.filter((lane) => lane.exists).map((lane) => lane.path)]

    // -----------------------------------------------------------------------
    // fetching by itself, while somebody is looking
    // -----------------------------------------------------------------------

    const fetched = new Map()   // repo path -> { at, error }
    let fetching = false
    /**
     * `git fetch --prune` in each repository not fetched for `every`, one at a time and never
     * while a press is running in it: what a person reads as "behind origin" stays true without
     * them asking. It moves only origin's refs: nothing is pulled, merged or pushed. A fetch that
     * fails (no network, no key for the remote) is kept and said, and asked again next time.
     */
    const fetchQuietly = async ({ every = 5 * 60 * 1000 } = {}) => {
        if (fetching) return false
        fetching = true
        let any = false
        try {
            for (const repo of last.repos) {
                if (repo.error || busy.has(repo.path)) continue
                const kept = fetched.get(repo.path)
                if (kept && Date.now() - kept.at < every) continue
                const result = await new Promise((resolve) => execFile('git', ['fetch', '--prune', '--quiet'], {
                    cwd: repo.path, timeout: 60_000,
                    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' }
                }, (error, stdout, stderr) => resolve(error ? String(stderr || error.message).trim().split('\n').pop().slice(0, 200) : null)))
                fetched.set(repo.path, { at: Date.now(), error: result })
                any = true
            }
        } finally {
            fetching = false
        }
        if (any) events.emit('fetched')
        return any
    }

    const untracked = async (cwd) => {
        const result = await git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])
        return result.ok ? result.out.split('\0').filter(Boolean).map((rel) => ({ status: 'A', path: rel, untracked: true })) : []
    }

    return {
        events,
        kit,
        roots: () => roots.slice(),
        setRoots: (dirs) => { roots = [...dirs] },

        /** Everything the page draws, read now, with what the last quiet fetch of each repository said. */
        state: async () => ({
            at: Date.now(),
            kit,
            roots: roots.slice(),
            repos: (await readNow()).map((repo) => ({ ...repo, fetchError: fetched.get(repo.path)?.error ?? null })),
            jobs: [...jobs.values()].reverse().slice(0, 10).map(summary)
        }),

        fetchQuietly,

        /** The last reading, without asking again: what a status bar or a lookup needs. */
        known: () => last,

        /** A button. `{ status, body }`: 202 and the job, or the refusal and why. */
        press: async (request) => {
            const decided = plan(request ?? {}, await readNow())
            if (!decided.job) return { status: decided.status, body: decided.body }
            return { status: 202, body: summary(startJob(decided.job)) }
        },

        /** A job's output from `from` on; null for a job not kept. */
        job: (id, from = 0) => {
            const job = jobs.get(id)
            if (!job) return null
            const asked = Number(from) || 0
            const start = Math.max(asked, job.dropped)
            return {
                ...summary(job),
                gap: asked < job.dropped,
                output: job.text.slice(start - job.dropped),
                next: job.dropped + job.text.length
            }
        },

        /** The repository and lane a file is in, from the last reading: the lane, or null in the main checkout. */
        laneAt: (file) => {
            for (const repo of last.repos) {
                if (repo.error) continue
                const lane = repo.lanes.find((candidate) => candidate.exists && isUnder(file, candidate.path))
                if (lane) return { repo, lane }
                if (isUnder(file, repo.path)) return { repo, lane: null }
            }
            return null
        },

        /** The files a commit changed against its first parent (every file, for a first commit). */
        commitChanges: async (repoPath, sha) => {
            const repo = await repoAt(repoPath)
            if (!repo || !SHA.test(String(sha))) return null
            const parents = await git(repo.path, ['rev-list', '--parents', '-n', '1', sha])
            if (!parents.ok) return null
            const [full, parent] = parents.out.trim().split(/\s+/)
            const args = parent
                ? ['diff-tree', '-r', '-M', '-z', '--name-status', parent, full]
                : ['diff-tree', '--no-commit-id', '--root', '-r', '-z', '--name-status', full]
            const result = await git(repo.path, args)
            return result.ok ? { sha: full, parent: parent ?? null, files: parseNameStatus(result.out) } : null
        },

        /**
         * Everything a lane holds that its integration branch does not, committed or not: its
         * files as they are in the lane now, against where it forked.
         */
        laneChanges: async (repoPath, laneName) => {
            const repo = await repoAt(repoPath)
            const lane = repo?.lanes.find((candidate) => candidate.name === laneName && candidate.exists)
            if (!lane) return null
            const fork = await git(repo.path, ['merge-base', repo.integrationBranch, lane.branch])
            if (!fork.ok) return null
            const base = fork.out.trim()
            const diff = await git(lane.path, ['diff', '-M', '-z', '--name-status', base])
            if (!diff.ok) return null
            return { base, checkout: lane.path, files: [...parseNameStatus(diff.out), ...await untracked(lane.path)] }
        },

        /** What is uncommitted in a checkout (a lane's, or the main one), against its own commit. */
        uncommitted: async (repoPath, checkout) => {
            const repo = await repoAt(repoPath)
            if (!repo || !checkoutsOf(repo).includes(checkout)) return null
            const head = await git(checkout, ['rev-parse', 'HEAD'])
            if (!head.ok) return null
            const diff = await git(checkout, ['diff', '-M', '-z', '--name-status', 'HEAD'])
            if (!diff.ok) return null
            return { head: head.out.trim(), checkout, files: [...parseNameStatus(diff.out), ...await untracked(checkout)] }
        },

        /** The files git knows in a lane whose path ends with `tail`, for a reference a step printed from a sub-folder. */
        filesEndingWith: async (repoPath, laneName, tail) => {
            const repo = await repoAt(repoPath)
            const lane = repo?.lanes.find((candidate) => candidate.name === laneName && candidate.exists)
            if (!lane || !safeRel(tail)) return []
            const listed = await git(lane.path, ['ls-files', '-z'])
            if (!listed.ok) return []
            return listed.out.split('\0').filter((file) => file === tail || file.endsWith(`/${tail}`))
        },

        /** A file as it was at a commit, as bytes; empty when the commit has no such file. */
        show: async (repoPath, sha, rel) => {
            const repo = await repoAt(repoPath)
            if (!repo || !SHA.test(String(sha)) || !safeRel(rel)) return null
            const result = await git(repo.path, ['show', `${sha}:${rel.split(path.sep).join('/')}`], { buffer: true })
            return result.ok ? result.out : Buffer.alloc(0)
        },

        dispose: () => worker?.dispose()
    }
}
