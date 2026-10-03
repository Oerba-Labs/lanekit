// LaneKit's copy of lanekit on this machine: made where there is none, and kept current. Part of the loader
// (extension.js), so it travels in the .vsix and is updated by the editor's own extension store, while what it keeps
// current is everything else: the page, the service and the `lane` commands, run from the checkout.
//
// ONLY EVER A FAST-FORWARD. A checkout is moved on only when it is on a branch that follows one, has nothing
// uncommitted in what git tracks, and has no commit of its own: exactly when `git pull --ff-only` would do nothing
// but move it on. Anything else (somebody's working copy of lanekit, a branch of their own, a shared copy they may
// not write) is left as it is, and why is said.
//
// A NEW COPY FOLLOWS `stable`, the branch lanekit's CI moves to each commit of main whose tests pass, where the
// repository has it: an editor that updates itself is never handed a commit nobody tested. One cloned by hand
// follows whatever its branch follows.
//
// No dependency and no editor here: git, and node's own modules, so lanekit's tests run it as it is.
'use strict'

const { execFile } = require('child_process')
const fs = require('fs')
const path = require('path')

const REPOSITORY = 'https://github.com/Oerba-Labs/lanekit.git'
const STABLE = 'stable'

const lastLine = (text) => String(text ?? '').trim().split('\n').filter(Boolean).pop() ?? ''

/** git, waited for: never prompting, never taking a lock it need not. */
const git = (cwd, args, { timeout = 60_000 } = {}) => new Promise((resolve) => {
    execFile('git', args, {
        cwd, timeout, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes' }
    }, (error, stdout, stderr) => resolve({
        ok: !error, out: String(stdout ?? '').trim(), err: String(stderr || (error && error.message) || '').trim(),
        missing: Boolean(error && error.code === 'ENOENT')
    }))
})

/** A folder that holds lanekit: what the loader hands over to, and what the project's shim runs. */
const isLanekit = (dir) => Boolean(dir) && fs.existsSync(path.join(dir, 'vscode', 'host.mjs')) && fs.existsSync(path.join(dir, 'dev', 'lane.mjs'))

/**
 * lanekit cloned into `to` (~/.lanekit, where the project's shim looks too), following `stable` where the repository
 * has it. `{ ok, root, branch }`, or `{ ok: false, why }`. A folder already there is used if it is lanekit, and
 * refused, untouched, if it is anything else.
 */
const install = async (to, { url = process.env.LANEKIT_REPOSITORY || REPOSITORY } = {}) => {
    const there = fs.existsSync(to) && fs.readdirSync(to).length > 0
    if (there) return isLanekit(to) ? { ok: true, root: to, already: true } : { ok: false, why: `${to} is there already and is not lanekit: move it, or set lanekit.path to a copy of lanekit` }
    fs.mkdirSync(path.dirname(to), { recursive: true })
    const cloned = await git(path.dirname(to), ['clone', '--quiet', url, to], { timeout: 300_000 })
    if (cloned.missing) return { ok: false, why: 'git is not installed here, and lanekit is fetched with it' }
    if (!cloned.ok) return { ok: false, why: `git clone ${url} did not finish: ${lastLine(cloned.err)}` }
    const stable = await git(to, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${STABLE}`])
    if (stable.ok) await git(to, ['switch', '--quiet', '--track', `origin/${STABLE}`])
    if (!isLanekit(to)) return { ok: false, why: `${url} was cloned into ${to}, but it is not lanekit` }
    return { ok: true, root: to, branch: (await git(to, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).out || null }
}

const left = (why) => ({ state: 'left', why })

/**
 * Where a checkout stands against what it follows, fetched first: `{ state: 'behind', count, upstream }`, `current`,
 * or `left` with why it is not one to move on.
 */
const check = async (root) => {
    if (!isLanekit(root)) return left(`${root} is not lanekit`)
    if (!fs.existsSync(path.join(root, '.git'))) return left('it is not a git checkout')
    try { fs.accessSync(path.join(root, '.git'), fs.constants.W_OK) } catch { return left('it is not yours to change') }
    const branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
    if (!branch.ok) return left('it is not on a branch')
    const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
    if (!upstream.ok) return left(`its branch ${branch.out} follows none`)
    const remote = (await git(root, ['config', '--get', `branch.${branch.out}.remote`])).out || 'origin'
    if (remote !== '.') {
        const fetched = await git(root, ['fetch', '--quiet', remote])
        if (fetched.missing) return left('git is not installed here')
        if (!fetched.ok) return left(`it could not be fetched: ${lastLine(fetched.err)}`)
    }
    const sides = await git(root, ['rev-list', '--left-right', '--count', `${upstream.out}...HEAD`])
    if (!sides.ok) return left(`git could not compare it with ${upstream.out}`)
    const [behind, ahead] = sides.out.split(/\s+/).map(Number)
    if (ahead) return left(`it has ${ahead} ${ahead === 1 ? 'commit' : 'commits'} of its own`)
    if (!behind) return { state: 'current', branch: branch.out, upstream: upstream.out }
    if ((await git(root, ['status', '--porcelain', '--untracked-files=no'])).out) return left('it has uncommitted changes')
    return { state: 'behind', count: behind, branch: branch.out, upstream: upstream.out }
}

/**
 * The checkout fast-forwarded to what it follows, where check says it may be: `{ state: 'updated', count, from, to }`
 * (to: the new commit's hash and words), or what check said.
 */
const update = async (root) => {
    const seen = await check(root)
    if (seen.state !== 'behind') return seen
    const from = (await git(root, ['rev-parse', '--short', 'HEAD'])).out
    const merged = await git(root, ['merge', '--ff-only', '--quiet', seen.upstream])
    if (!merged.ok) return left(`git could not fast-forward it: ${lastLine(merged.err)}`)
    return { state: 'updated', count: seen.count, from, to: (await git(root, ['log', '-1', '--format=%h %s'])).out, upstream: seen.upstream }
}

// ---------------------------------------------------------------------------
// the extension itself, from the copy: no extension store needed to keep it current
// ---------------------------------------------------------------------------

/** x.y.z as three numbers, from a version or an editor range (^1.90.0, >=1.90.0); null for anything else. */
const versionOf = (text) => {
    const found = /^\s*[\^~>=v\s]*(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''))
    return found ? found.slice(1, 4).map(Number) : null
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

/** The extension's manifest as the copy of lanekit holds it, or null. */
const offeredLoader = (root) => {
    try { return JSON.parse(fs.readFileSync(path.join(root, 'vscode', 'package.json'), 'utf8')) } catch { return null }
}

/**
 * Whether the copy holds a newer build of the running extension: `{ newer: true, version }`, or `{ newer: false, why }`.
 * Only the same extension (its publisher and name), only a newer x.y.z, and only one this editor can run (its
 * engines.vscode), so a copy of somebody's fork, or one ahead of the editor, is never installed over it.
 */
const newerLoader = ({ running, offered, editor }) => {
    if (!offered) return { newer: false, why: 'the copy holds no extension' }
    const [want, has] = [`${running?.publisher}.${running?.name}`, `${offered.publisher}.${offered.name}`]
    if (want !== has) return { newer: false, why: `the copy's extension is ${has}, not ${want}` }
    const [mine, theirs] = [versionOf(running.version), versionOf(offered.version)]
    if (!mine || !theirs) return { newer: false, why: 'a version is not x.y.z' }
    if (compare(theirs, mine) <= 0) return { newer: false, why: `the copy's is ${offered.version}, and this is ${running.version}` }
    const [needs, runs] = [versionOf(offered.engines?.vscode), versionOf(editor)]
    if (needs && runs && compare(runs, needs) < 0) return { newer: false, why: `${offered.version} needs the editor at ${needs.join('.')} or later, and this is ${editor}` }
    return { newer: true, version: offered.version }
}

module.exports = { REPOSITORY, STABLE, install, check, update, isLanekit, offeredLoader, newerLoader }
