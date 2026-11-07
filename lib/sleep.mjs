/**
 * Whether the machine slept during a run, what powers it, and holding it awake while a full run goes (macOS).
 *
 * WHY. A MacBook on battery that launchd wakes at 03:00 for a nightly run is woken for two seconds (a DarkWake) and goes
 * back to sleep at once, for a quarter of an hour at a time, for hours. Every test that times itself counted the sleep
 * and failed (cases failing at 903 to 1063 seconds beside sleeps of 921 to 1064), and the run was recorded `failed` on a
 * night when nothing was wrong with main: the same suite passed in 378 seconds on a night the Mac stayed awake on AC.
 *
 * NOT TOLD BY A CLOCK. The obvious test, a monotonic clock against the wall clock, is false here: Node's `process.hrtime`
 * keeps counting through sleep on macOS (it matched the time since boot to 0.01 hours over 110 hours with hundreds of
 * sleeps in them). What does not lie is the system's own counter: `pmset -g stats` prints `Sleep Count:475`, and a run
 * during which it rose slept. `sysctl -n kern.sleeptime` (the last sleep's time) is a second witness for when.
 *
 * UNKNOWN IS NOT NO. Off macOS, or when a reader fails or prints what is not understood, the answer is null, and a run is
 * judged exactly as it was before this existed: a failed run stays failed. Everything here is a program run by its
 * absolute path, with no shell, and each reader is replaceable (`machineOf`'s `exec`; LANEKIT_SLEEP_COUNT_FILE and
 * LANEKIT_CAFFEINATE for a process the tests start), so the tests simulate a sleep without one.
 *
 * KEEPING IT AWAKE IS A HELP, NOT A PROMISE. `caffeinate -i -s` holds the machine awake against idle sleep, and against
 * system sleep only while it is on AC power (its man page). On battery macOS may sleep anyway, and a shut lid is not
 * something caffeinate is known to prevent either; so a run says which it is on, and the sleep count is what decides.
 */

import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'

const PMSET = '/usr/bin/pmset'
const IOREG = '/usr/sbin/ioreg'
const SYSCTL = '/usr/sbin/sysctl'
const CAFFEINATE = '/usr/bin/caffeinate'

/** "Sleep Count:475" in `pmset -g stats`: the number, or null where it is not there. */
export const parseSleepCount = (text) => {
    const found = /^\s*Sleep Count:\s*(\d+)\s*$/m.exec(String(text ?? ''))
    return found ? Number(found[1]) : null
}

/** `pmset -g ps`' first line, "Now drawing from 'AC Power'": `{ source: 'ac'|'battery'|'other', said }`, or null. */
export const parsePower = (text) => {
    const found = /^Now drawing from '([^']+)'/m.exec(String(text ?? ''))
    if (!found) return null
    const said = found[1]
    return { source: /^AC\b/i.test(said) ? 'ac' : /^Battery\b/i.test(said) ? 'battery' : 'other', said }
}

/** `"AppleClamshellState" = Yes` in ioreg's output: 'shut', 'open', or null where it is not there (a desktop). */
export const parseLid = (text) => {
    const found = /"AppleClamshellState"\s*=\s*(Yes|No)\b/.exec(String(text ?? ''))
    return found ? (found[1] === 'Yes' ? 'shut' : 'open') : null
}

/** `{ sec = 1794020323, usec = 675919 } …` from `sysctl -n kern.sleeptime`: the last sleep's time in ms, or null. */
export const parseSleepTime = (text) => {
    const found = /\bsec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)/.exec(String(text ?? ''))
    return found && Number(found[1]) > 0 ? Number(found[1]) * 1000 + Math.floor(Number(found[2]) / 1000) : null
}

const runText = (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * What this machine can say about its sleep and its power, and how to hold it awake: `{ known, sleepCount(), lastSleep(),
 * power(), lid(), keepAwake(pid, log) }`. Every reader answers null rather than throwing. `known` is false off macOS,
 * and then nothing is read or started. `exec(file, args)` returns a program's output, or throws.
 */
export const machineOf = ({ platform = process.platform, env = process.env, exec = runText } = {}) => {
    const standIn = env.LANEKIT_SLEEP_COUNT_FILE
    const darwin = platform === 'darwin'
    const asked = (parse, file, args) => {
        if (!darwin) return null
        try { return parse(exec(file, args)) } catch { return null }
    }
    return {
        known: darwin || Boolean(standIn),
        standIn: standIn || null,
        darwin,
        sleepCount: () => {
            if (standIn) {
                try { return parseSleepCount(`Sleep Count:${fs.readFileSync(standIn, 'utf8').trim()}`) } catch { return null }
            }
            return asked(parseSleepCount, PMSET, ['-g', 'stats'])
        },
        lastSleep: () => asked(parseSleepTime, SYSCTL, ['-n', 'kern.sleeptime']),
        power: () => asked(parsePower, PMSET, ['-g', 'ps']),
        lid: () => asked(parseLid, IOREG, ['-r', '-k', 'AppleClamshellState', '-d', '1']),
        keepAwake: (pid, log) => keepAwake({ pid, log, darwin, file: env.LANEKIT_CAFFEINATE || CAFFEINATE })
    }
}

/**
 * `caffeinate -i -s -w <pid>`: no idle sleep, and no system sleep on AC power, until that process ends (so if this one
 * is killed, it lets go too). `{ stop() }`; where it cannot be started the reason is logged and `stop` does nothing: a
 * run is never failed for want of it.
 */
const keepAwake = ({ pid, log, darwin, file }) => {
    if (!darwin) return { stop: () => {} }
    let child = null
    try {
        child = spawn(file, ['-i', '-s', '-w', String(pid)], { stdio: 'ignore' })
        child.on('error', (error) => log(`could not hold the machine awake (${file}: ${error.message}): the run goes on`))
        child.unref()
    } catch (error) {
        log(`could not hold the machine awake (${file}: ${error.message}): the run goes on`)
        child = null
    }
    return { stop: () => { try { child?.kill() } catch { /* already gone */ } } }
}

/** The words a run begins with about power and lid, one line each; none where the machine is not a Mac. */
export const powerLines = (machine) => {
    if (!machine.darwin) return []
    const lines = []
    const power = machine.power()
    const lid = machine.lid()
    if (power) {
        lines.push(`power: ${power.said}${power.source === 'ac' ? '' : '; macOS may sleep this machine during the run anyway (caffeinate holds it awake on AC power only)'}`)
    } else {
        lines.push('power: could not be read; macOS may sleep this machine during the run (caffeinate holds it awake on AC power only)')
    }
    if (lid) lines.push(`lid: ${lid}${lid === 'shut' ? '; a shut lid may sleep it too, which holding it awake is not known to prevent' : ''}`)
    return lines
}

/** How many times a run slept, from the counts before and after: `{ count, lastAt? }`, or null (no sleep, or not known). */
export const sleptDuring = (before, after, lastSleep = () => null) => {
    if (!Number.isInteger(before) || !Number.isInteger(after) || after <= before) return null
    const last = lastSleep()
    return { count: after - before, ...(last ? { lastAt: new Date(last).toISOString() } : {}) }
}

/** "once", "3 times". */
export const timesSaid = (count) => (count === 1 ? 'once' : `${count} times`)
