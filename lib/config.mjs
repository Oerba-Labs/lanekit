/**
 * A project's `lane.config.json`, found and validated once.
 *
 * THE WHOLE POINT OF THIS FILE. The tooling this package came from named one
 * repository in about nine hundred places — its directory name, its server and
 * app roots, its Postgres credentials, its simulator prefix, the seven path
 * lists that decide which tier a diff earns. Most of that was a string constant
 * rather than a decision, and the ones that were decisions are here, where a
 * second project can answer them differently.
 *
 * FOUND BY WALKING UP, not passed in. Every command runs from somewhere inside
 * a checkout — often a lane's, which is a different directory from the one that
 * created it — so the config is located the way git locates itself. That is
 * what makes a lane's own copy of the tooling read the lane's own config
 * without anything having to tell it which checkout it is in.
 *
 * REFUSES RATHER THAN DEFAULTS. A missing root or an unparseable file stops the
 * command with the path it looked at. The alternative — filling in a plausible
 * default — produces a lane provisioned against the wrong directory, which is
 * discovered at the point something writes to it.
 */

import fs from 'node:fs'
import path from 'node:path'

export const CONFIG_NAME = 'lane.config.json'

/** Where this package is, derived from this file rather than written down. */
export const PACKAGE_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

/**
 * The checkout `from` is inside, identified by its config file.
 *
 * Walks up to the filesystem root. Returns null rather than throwing so the
 * caller can say something useful about the directory the user is actually in.
 */
export const findCheckout = (from = process.cwd()) => {
    let dir = path.resolve(from)
    for (;;) {
        if (fs.existsSync(path.join(dir, CONFIG_NAME))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) return null
        dir = parent
    }
}

/**
 * The fields a config must carry, and what each is for.
 *
 * `slug` is spliced into a home directory and temp filenames, so it is
 * restricted to what is safe in a path segment. `name` is only ever displayed.
 */
const REQUIRED = ['name', 'slug', 'integrationBranch', 'roots', 'lane']

const validate = (config, file) => {
    const missing = REQUIRED.filter((key) => config[key] === undefined)
    if (missing.length) {
        throw new Error(`${file} is missing ${missing.join(', ')}`)
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(config.slug)) {
        throw new Error(`${file}: slug "${config.slug}" must be lowercase letters, digits and dashes — it becomes a directory name`)
    }
    const lane = config.lane
    if (typeof lane.portBase !== 'number' || typeof lane.portCeiling !== 'number') {
        throw new Error(`${file}: lane.portBase and lane.portCeiling must be numbers`)
    }
    if (lane.portCeiling < lane.portBase) {
        throw new Error(`${file}: lane.portCeiling (${lane.portCeiling}) is below lane.portBase (${lane.portBase})`)
    }
    // After how many days with nothing done in it a lane is called quiet: optional, fourteen when left out.
    if (lane.staleAfterDays !== undefined && !(Number.isInteger(lane.staleAfterDays) && lane.staleAfterDays > 0)) {
        throw new Error(`${file}: lane.staleAfterDays must be a whole number of days above nought, or left out for fourteen`)
    }
    return config
}

/**
 * When a project's whole test suite runs, if it says (`gate.full`; the owner, 26 Oct 2026), checked as the rest is.
 *
 * WHY THERE IS ONE. A gate runs the tier a change earns, and a project may make that tier cheap by running only what the
 * change touches (homelab's `./check`, from 26 Oct, runs only the selftests a change reaches, plus those not already
 * passed with identical inputs). Then nothing runs everything on main, unless this says when:
 *
 *   nightly       `lane nightly` at `at` (local time, HH:MM), on main's newest commit, in a scratch copy
 *   after-land    after each `lane land`, on the commit it made, in a scratch copy, in the background
 *   before-land   verifying runs it too, in the lane, and a land needs it passed on the lane's commit
 *
 * Left out, nothing is different, which is every project before this. Wrong, it is refused here with the key it is
 * about, rather than discovered at three in the morning by a job that runs nothing.
 */
export const FULL_WHENS = ['nightly', 'after-land', 'before-land']
const validateFull = (full, file, key) => {
    if (full === undefined) return
    const at = `${file}: ${key}.full`
    if (!full || typeof full !== 'object' || Array.isArray(full)) throw new Error(`${at} must be an object: { "when": "nightly", "at": "03:00", "steps": [...] }, or left out`)
    if (!FULL_WHENS.includes(full.when)) {
        throw new Error(`${at}.when is ${full.when === undefined ? 'missing' : JSON.stringify(full.when)}: it says when the full suite runs, ${FULL_WHENS.map((when) => `"${when}"`).join(', ').replace(/, ([^,]*)$/, ' or $1')}`)
    }
    if (full.when === 'nightly') {
        const time = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(full.at ?? ''))
        if (!time) throw new Error(`${at}.at is ${full.at === undefined ? 'missing' : JSON.stringify(full.at)}: a nightly run needs the local time it starts, as "HH:MM" from "00:00" to "23:59", such as "03:00"`)
    } else if (full.at !== undefined) {
        throw new Error(`${at}.at is for "nightly" only: a full suite run ${full.when === 'after-land' ? 'after each land' : 'before each land'} has no time of day; take it out`)
    }
    if (full.label !== undefined && (typeof full.label !== 'string' || !full.label.trim())) throw new Error(`${at}.label must be words, such as "every selftest", or left out`)
    if (!Array.isArray(full.steps) || !full.steps.length) {
        throw new Error(`${at}.steps must list what the full suite runs, at least one step: { "what": "running ./check --all", "command": "{repo}/check", "args": ["--all"] }`)
    }
    full.steps.forEach((step, i) => {
        const where = `${at}.steps[${i}]`
        if (!step || typeof step !== 'object') throw new Error(`${where} must be { "what", "command", "args" }`)
        if (typeof step.what !== 'string' || !step.what.trim()) throw new Error(`${where}.what must say what the step does, in words: it is how the step is named when it fails`)
        if (typeof step.command !== 'string' || !step.command.trim()) throw new Error(`${where}.command must name what to run, such as "{repo}/check"`)
        if (step.args !== undefined && !(Array.isArray(step.args) && step.args.every((arg) => typeof arg === 'string'))) throw new Error(`${where}.args must be a list of strings, or left out`)
        if (step.cwd !== undefined && typeof step.cwd !== 'string') throw new Error(`${where}.cwd must be a folder in the checkout, or left out`)
    })
}

/**
 * The port window, as this machine is allowed to use it.
 *
 * THE WINDOW IS THE PROJECT'S; A SHARE OF IT IS THE MACHINE'S. Lanes of one project can
 * live on more than one machine, and a port on another machine arrives on this one's
 * loopback the moment somebody forwards it to aim a simulator at it. Each machine checks
 * a port is free with its own `lsof`, which cannot see the other's lanes, so two of them
 * left to themselves hand out the same port and the forward lands on the wrong server.
 * `LANEKIT_PORTS="orpheus=8100-8149 skyride=8300-8349"` gives a machine its shares.
 *
 * THE SHARE NAMES ITS PROJECT. The first cut was two bare variables, a base and a
 * ceiling, and it lasted until the machine that set them met a second project: a share
 * of one project's window is outside every other project's, so each of them was refused
 * by a line in a shell profile that had nothing to do with it. A machine has one
 * environment and many projects; the variable has to say which one it is talking about.
 *
 * NARROWS, NEVER WIDENS. A share outside the project's own window is refused rather than
 * honoured: the window is committed and reviewed, an environment variable is neither.
 * An entry this cannot read is refused too, whoever it was for — skipping it would hand
 * out the full window on the one machine where somebody tried to prevent exactly that.
 */
const portWindow = (config, file) => {
    const { portBase, portCeiling } = config.lane
    const raw = (process.env.LANEKIT_PORTS ?? '').trim()
    if (!raw) return { portBase, portCeiling }

    let share = null
    for (const entry of raw.split(/[\s,]+/).filter(Boolean)) {
        const match = /^([a-z0-9][a-z0-9-]*)=(\d+)-(\d+)$/.exec(entry)
        if (!match) {
            throw new Error(`LANEKIT_PORTS: "${entry}" is not <slug>=<first>-<last>, as in orpheus=8100-8149`)
        }
        if (match[1] === config.slug) share = { portBase: Number(match[2]), portCeiling: Number(match[3]) }
    }
    if (!share) return { portBase, portCeiling }

    if (share.portCeiling < share.portBase) {
        throw new Error(`LANEKIT_PORTS: ${config.slug}=${share.portBase}-${share.portCeiling} ends before it starts`)
    }
    if (share.portBase < portBase || share.portCeiling > portCeiling) {
        throw new Error(
            `LANEKIT_PORTS gives ${config.slug} ${share.portBase}–${share.portCeiling}, outside the window ` +
            `${file} allows (${portBase}–${portCeiling}). It can narrow the window, not move it.`)
    }
    return share
}

/**
 * Read the config for a checkout.
 *
 * The roots are resolved against the checkout and checked to exist, because a
 * root that names nothing is the failure this package is most likely to hit on
 * a new project and the least likely to explain itself later: every derived
 * path is simply wrong, and the first symptom is a lane whose server cannot
 * start.
 */
export const loadConfig = (checkout) => {
    const file = path.join(checkout, CONFIG_NAME)
    let raw
    try {
        raw = fs.readFileSync(file, 'utf8')
    } catch (error) {
        throw new Error(`could not read ${file}: ${error.message}`)
    }

    let parsed
    try {
        parsed = JSON.parse(raw)
    } catch (error) {
        throw new Error(`${file} is not valid JSON: ${error.message}`)
    }

    const config = validate(parsed, file)
    // What verifying runs is `verify`, its name since the owner chose the word (21 Oct); `gate`, its old name, is read
    // as it always was. Everything past here reads it as config.gate.
    const gateKey = config.verify !== undefined ? 'verify' : 'gate'
    if (config.verify !== undefined) {
        if (config.gate !== undefined) throw new Error(`${file} has both "verify" and "gate", the old name for it: keep one`)
        config.gate = config.verify
        delete config.verify
    }
    validateFull(config.gate?.full, file, gateKey)

    const roots = {}
    for (const [key, rel] of Object.entries(config.roots)) {
        const abs = path.join(checkout, rel)
        if (!fs.existsSync(abs)) {
            throw new Error(`${file}: roots.${key} names "${rel}", which is not in ${checkout}`)
        }
        roots[key] = rel
    }

    const lane = { ...config.lane, ...portWindow(config, file) }

    return { ...config, lane, roots, checkout, file }
}

/** The config for wherever the caller is, or a refusal naming where it looked. */
export const configFor = (from = process.cwd()) => {
    const checkout = findCheckout(from)
    if (!checkout) {
        throw new Error(
            `no ${CONFIG_NAME} in ${path.resolve(from)} or any directory above it.\n` +
            `  This command runs inside a project that has one.`)
    }
    return loadConfig(checkout)
}
