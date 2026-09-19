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
    return config
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
