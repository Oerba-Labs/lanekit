#!/usr/bin/env node
/**
 * Write `/lane` and `/land` into a repository that has lanes, for Claude Code and OpenCode.
 *
 *     node bin/claude-commands.mjs [--dir <checkout>] [--agents claude,opencode] [--force]
 *
 * WHY THEY GO IN THE REPOSITORY AND NOT IN A HOME DIRECTORY. A command kept in
 * `~/.claude/commands` exists on the machine somebody set up and nowhere else: not in a
 * fresh workspace, not in an agent's sandbox, not on a second laptop. One committed under
 * `.claude/commands/` (Claude Code) or `.opencode/commands/` (OpenCode) is wherever the
 * checkout is, is the same for everybody, and is read in a lane as the lane's own copy.
 *
 * ONE PROCEDURE, TWO HEADERS. Both agents read a markdown file whose body is the prompt
 * and whose `$ARGUMENTS` is what was typed after the command. Claude Code's header also
 * carries `argument-hint` and `allowed-tools`, which name this project's shim; OpenCode's
 * understands `description`, so its copy carries that alone.
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

export const AGENTS = {
    claude: { dir: path.join('.claude', 'commands'), header: (fields) => fields },
    opencode: { dir: path.join('.opencode', 'commands'), header: (fields) => fields.filter(([key]) => key === 'description') }
}

/** A command file for one agent: the template, filled in, its header cut to what that agent reads. */
export const commandFor = (template, agent, name, slug) => {
    const text = template.replaceAll('{{slug}}', slug).replaceAll('{{name}}', name)
    const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
    if (!match) return text
    const fields = match[1].split('\n').filter(Boolean).map((line) => {
        const at = line.indexOf(':')
        return [line.slice(0, at).trim(), line.slice(at + 1).trim()]
    })
    const header = AGENTS[agent].header(fields).map(([key, value]) => `${key}: ${value}`).join('\n')
    return `---\n${header}\n---\n${text.slice(match[0].length)}`
}

/** Writes the commands into `dir` for each agent named; returns the paths written, relative to it. */
export const writeAgentCommands = (dir, name, slug, { force = false, agents = ['claude', 'opencode'] } = {}) => {
    const written = []
    for (const agent of agents) {
        if (!AGENTS[agent]) throw new Error(`no agent called "${agent}": ${Object.keys(AGENTS).join(' or ')}`)
        for (const file of fs.readdirSync(TEMPLATES).filter((entry) => entry.endsWith('.md')).sort()) {
            const rel = path.join(AGENTS[agent].dir, file)
            const to = path.join(dir, rel)
            if (fs.existsSync(to) && !force) continue
            fs.mkdirSync(path.dirname(to), { recursive: true })
            fs.writeFileSync(to, commandFor(fs.readFileSync(path.join(TEMPLATES, file), 'utf8'), agent, name, slug))
            written.push(rel)
        }
    }
    return written
}

/** Claude Code's alone, as before OpenCode's were written too. */
export const writeClaudeCommands = (dir, name, slug, options = {}) =>
    writeAgentCommands(dir, name, slug, { ...options, agents: ['claude'] })

const main = () => {
    const argv = process.argv.slice(2)
    const dir = path.resolve(argv.includes('--dir') ? argv[argv.indexOf('--dir') + 1] : '.')
    const agents = argv.includes('--agents') ? String(argv[argv.indexOf('--agents') + 1] ?? '').split(',').filter(Boolean) : ['claude']
    const configFile = path.join(dir, 'lane.config.json')
    if (!fs.existsSync(configFile)) {
        console.error(`\n  ${dir} has no lane.config.json: give the repository lanes first.\n`)
        process.exit(1)
    }
    const { name, slug } = JSON.parse(fs.readFileSync(configFile, 'utf8'))
    let written
    try {
        written = writeAgentCommands(dir, name, slug, { force: argv.includes('--force'), agents })
    } catch (error) {
        console.error(`\n  ${error.message}\n`)
        process.exit(2)
    }
    console.log(written.length
        ? `  wrote ${written.join(', ')}: commit them, and /lane and /land exist wherever this checkout does`
        : '  /lane and /land are already here; --force replaces them')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
