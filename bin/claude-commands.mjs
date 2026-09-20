#!/usr/bin/env node
/**
 * Write `/lane` and `/land` for Claude Code into a repository that has lanes.
 *
 *     node bin/claude-commands.mjs [--dir <checkout>] [--force]
 *
 * WHY THEY GO IN THE REPOSITORY AND NOT IN A HOME DIRECTORY. A command kept in
 * `~/.claude/commands` exists on the machine somebody set up and nowhere else: not in a
 * fresh workspace, not in an agent's sandbox, not on a second laptop. One committed under
 * `.claude/commands/` is wherever the checkout is, is the same for everybody, and is read
 * in a lane as the lane's own copy. It also names this project's shim in its
 * `allowed-tools`, which a command shared between projects could not.
 *
 * THEY ARE A STARTING POINT, LIKE THE CONFIG. The procedure is the same everywhere, and
 * that is what is written. What a lane of *this* project owns, what is slow, what breaks
 * in a way that does not look like what it is: that belongs in the project's copy, and an
 * existing file is never overwritten without `--force` for that reason.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'claude', 'commands')

/** Writes the commands into `dir`; returns the paths written, relative to it. */
export const writeClaudeCommands = (dir, name, slug, { force = false } = {}) => {
    const written = []
    for (const file of fs.readdirSync(TEMPLATES).filter((entry) => entry.endsWith('.md')).sort()) {
        const rel = path.join('.claude', 'commands', file)
        const to = path.join(dir, rel)
        if (fs.existsSync(to) && !force) continue
        fs.mkdirSync(path.dirname(to), { recursive: true })
        fs.writeFileSync(to, fs.readFileSync(path.join(TEMPLATES, file), 'utf8')
            .replaceAll('{{slug}}', slug).replaceAll('{{name}}', name))
        written.push(rel)
    }
    return written
}

const main = () => {
    const argv = process.argv.slice(2)
    const dir = path.resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : '.')
    const configFile = path.join(dir, 'lane.config.json')
    if (!fs.existsSync(configFile)) {
        console.error(`\n  ${dir} has no lane.config.json: give the repository lanes first.\n`)
        process.exit(1)
    }
    const { name, slug } = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    const written = writeClaudeCommands(dir, name, slug, { force: argv.includes('--force') })
    console.log(written.length
        ? `  wrote ${written.join(' and ')}: commit them, and /lane and /land exist wherever this checkout does`
        : '  /lane and /land are already here; --force replaces them')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
