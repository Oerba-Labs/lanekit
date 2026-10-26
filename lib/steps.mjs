/**
 * A list of configured steps, run one after another in a checkout, the way verifying runs a tier's: each with its output
 * shown as it comes, its seconds kept, and the last lines of a failing one written down; then what the tests' JUnit said.
 *
 * ONE RUNNER, TWO CALLERS (26 Oct 2026). It was dev/gate.mjs's own until the full suite (lib/full.mjs) needed to run steps
 * too: in a lane as part of verifying (before-land), and in a scratch copy of main after a land or at night. A second
 * runner would have been a second idea of what a step's `cwd`, `{repo}`, LAB_RESULTS and a failure's tail mean, and the
 * page and `lanes` read one record shape for both.
 *
 * NOTHING HERE DECIDES A RESULT. The steps' exit codes are the verdict; what the JUnit says is counted and kept, and a
 * folder or a file that cannot be read is said and passed over.
 */

import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'

import { prepareResults, readResults, resultsFolderFor, secondsSaid, slowestLines, testsLines } from './results.mjs'

const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const OFF = '\x1b[0m'

/**
 * `{repo}`, `{app}` and `{server}` filled in a step's command or argument, for the checkout it runs in, so a project can
 * point a step at a script of its own (`{repo}/check`) rather than at a program that happens to be installed.
 */
export const expanderFor = (repo, config) => (value) => value
    .replace(/\{repo\}/g, repo)
    .replace(/\{app\}/g, path.join(repo, config.roots?.app ?? ''))
    .replace(/\{server\}/g, path.join(repo, config.roots?.server ?? ''))

/**
 * A step, run with its output shown as it comes, and the last lines of it kept.
 *
 * THE TAIL IS WRITTEN DOWN WITH A FAILURE, so a page can show why a gate failed — the step and its last lines, with the
 * file names in them — after the output itself is gone. At a terminal the step writes to it directly, colours and all,
 * and the person reads it there.
 */
export const TAIL_LINES = 40
// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
export const runStep = (step, { repo, expand, env }) => new Promise((resolve) => {
    const cwd = step.cwd ? path.join(repo, step.cwd) : repo
    const command = expand(step.command)
    const args = (step.args ?? []).map(expand)
    if (process.stdout.isTTY) {
        const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' })
        resolve({ status: result.status ?? -1, tail: '' })
        return
    }
    let tail = ''
    let settled = false
    const keep = (chunk, to) => {
        to.write(chunk)
        tail = (tail + chunk.toString('utf8')).split('\n').slice(-(TAIL_LINES + 1)).join('\n')
    }
    const child = spawn(command, args, { cwd, env, stdio: ['inherit', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => keep(chunk, process.stdout))
    child.stderr.on('data', (chunk) => keep(chunk, process.stderr))
    const end = (status, note) => { if (settled) return; settled = true; resolve({ status, tail: plain(note ?? tail).trimEnd() }) }
    child.on('error', (error) => end(-1, `could not start ${command}: ${error.message}`))
    child.on('close', (code) => end(code ?? -1))
})

/**
 * Run `steps` in `repo` (a checkout with `config`), saying each with `log`: `{ steps, failures, tests }`, `steps` each
 * `{ what, seconds }`, `failures` each `{ what, status, tail }`, and `tests` what the JUnit they wrote said, or null.
 *
 * Where the steps may leave JUnit XML: the folder the environment names as LAB_RESULTS, else one of this checkout's own,
 * emptied first, so what is counted afterwards is this run's. Nothing here can fail a run: a folder that cannot be made
 * is said, and the steps run as they would have. Every step runs, after a failing one too, as verifying always has.
 */
export const runSteps = async (steps, { repo, config, log }) => {
    const expand = expanderFor(repo, config)
    let results = null
    let before = null
    try {
        results = resultsFolderFor(repo)
        before = prepareResults(results)
    } catch (error) {
        log(`${YELLOW}could not ready a folder for the tests' JUnit: ${error.message}${OFF}`)
    }
    const env = results ? { ...process.env, LAB_RESULTS: results.dir } : process.env

    // Each step's own seconds, to the tenth: with several steps, which of them a slow run spent its time in.
    const failures = []
    const timed = []
    for (const step of steps ?? []) {
        log(`${step.what}…`)
        const began = Date.now()
        const { status, tail } = await runStep(step, { repo, expand, env })
        timed.push({ what: step.what, seconds: Math.round((Date.now() - began) / 100) / 10 })
        if (status !== 0) failures.push({ what: step.what, status, tail })
    }
    if (timed.length > 1) log(`the steps took ${timed.map((step) => `${secondsSaid(step.seconds)} ${step.what}`).join(', ')}`)

    let tests = null
    try {
        if (results) tests = readResults(results.dir, { before })
    } catch (error) {
        log(`${YELLOW}could not read the tests' JUnit in ${results.dir}: ${error.message}${OFF}`)
    }
    if (tests) {
        const [first, ...rest] = testsLines(tests)
        log(first)
        for (const line of rest) console.log(/^ {2}(failed|errored) /.test(line) ? line.replace(/^( {2})(\w+)/, `$1${RED}$2${OFF}`) : line)
        const [slowest, ...slow] = slowestLines(tests)
        if (slowest) log(slowest)
        for (const line of slow) console.log(line)
    }
    return { steps: timed, failures, tests }
}
