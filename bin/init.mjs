#!/usr/bin/env node
/**
 * Start a project that already has lanes: a repository, its config, its shim and a gate
 * that runs, in one command.
 *
 *     node <lanekit>/bin/init.mjs piano-sheets
 *     node <lanekit>/bin/init.mjs "Piano Sheets" --dir /work/piano-sheets --port-base 8300
 *
 * WHY THIS EXISTS. Installing this package into a repository is "two files, and nothing
 * else", and both were written by hand for the two projects it was built against — which
 * is fine twice and is the reason a third project starts without lanes and grows them
 * late, after the habit of working in main has set. A project begun here can run
 * `./<slug> lane new first-idea` before it has a line of its own code.
 *
 * WHAT IT WRITES, and nothing more: `lane.config.json`, the shim named after the project,
 * a `check` script that is the whole of tier 1, a `.gitignore` that keeps a lane's
 * environment file out of git, a README, and the first commit on `main`. No language is
 * chosen and no dependency enters the tree; what the project is made of is the first
 * thing its author decides, not this.
 *
 * THE CHECK SCRIPT PASSES AND SAYS IT CHECKED NOTHING. A gate with no steps would print
 * READY over a branch nothing looked at, in the same green as a real one. One step that
 * names itself as a placeholder, every run, is the honest version — and it is where the
 * project's tests go, so the config need not change when they arrive.
 *
 * REFUSES A DIRECTORY WITH ANYTHING IN IT. Adopting an existing repository is a different
 * job — its roots, its environment file and its tests are decisions already made, and a
 * scaffold written over them would be wrong in ways that pass. The README says how.
 *
 * A PORT WINDOW OF ITS OWN. Lanes of different projects meet on one loopback the moment
 * two of them are served on one machine, or forwarded to one. The window is taken above
 * the highest any sibling project's config claims, in hundreds, unless `--port-base`
 * says otherwise.
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { CONFIG_NAME } from '../lib/config.mjs'

const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const DIM = '\x1b[2m'
const OFF = '\x1b[0m'

const log = (message) => console.log(`${DIM}[init]${OFF} ${message}`)
const fail = (message) => {
    console.error(`\n${RED}  ${message}${OFF}\n`)
    process.exit(1)
}

const WINDOW = 100
const FIRST_BASE = 8200

/** "Piano Sheets" → piano-sheets: what is safe as a directory, a branch prefix and a command. */
export const slugFor = (name) =>
    name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** The first hundred above every window a sibling project's config claims. */
export const freeWindowBeside = (dir) => {
    let highest = FIRST_BASE - 1
    const parent = path.dirname(dir)
    for (const entry of fs.existsSync(parent) ? fs.readdirSync(parent) : []) {
        const file = path.join(parent, entry, CONFIG_NAME)
        try {
            const ceiling = JSON.parse(fs.readFileSync(file, 'utf8')).lane?.portCeiling
            if (Number.isInteger(ceiling)) highest = Math.max(highest, ceiling)
        } catch {
            // No config, or one this cannot read: it claims nothing this can know about.
        }
    }
    return Math.ceil((highest + 1) / WINDOW) * WINDOW
}

const configFor = (name, slug, portBase) => ({
    note: [
        `What ${name} is, for the lane tooling. Everything the tooling would otherwise have`,
        'to guess about this project is here. Written by `lanekit init`; every value is a',
        'starting point and the README of lanekit says what each one decides.',
        '',
        'When the project grows a server or an app, name their directories in `roots`, put',
        'the paths that make a change expensive in `gate.sides` and `gate.seam`, and give',
        'tier 2 the steps that are worth deferring. Until then everything earns tier 1.'
    ],
    name,
    slug,
    integrationBranch: 'main',
    roots: {},
    gate: {
        sides: {},
        seam: [],
        generated: [],
        tiers: {
            1: {
                label: 'the check script',
                steps: [{ what: 'running ./check', command: '{repo}/check', args: [] }]
            }
        }
    },
    lane: {
        // Main keeps the first port of the hundred; lanes are handed the rest.
        portBase: portBase + 1,
        portCeiling: portBase + WINDOW - 1,
        copyOnCreate: ['.env'],
        linkOnCreate: [],
        env: { file: '.env', portKey: 'PORT', perLane: {} },
        makeDirs: [],
        seed: [],
        provision: []
    }
})

const shimFor = (name, slug) => `#!/bin/sh
# ${name}'s one entrypoint: \`./${slug} lane new <name>\`, \`./${slug} gate\`, \`./${slug} check\`.
#
# WHICH COPY YOU RUN DECIDES WHICH CHECKOUT IS ACTED ON. This finds its own directory and
# works from there, so a lane's ./${slug} gates the lane and reads the lane's port.
#
# No dependency enters the repository: the lane tooling is found on the machine, in the
# order below, and the project carries only this file and lane.config.json.
here=$(cd "$(dirname "$0")" && pwd)
cd "$here" || exit 1

kit=
for candidate in "$LANEKIT" "$here/../lanekit" /opt/lanekit "$HOME/Documents/Programming/lanekit"; do
    if [ -n "$candidate" ] && [ -d "$candidate/dev" ]; then kit=$candidate; break; fi
done

command=$1
[ $# -gt 0 ] && shift

case "$command" in
    lane|gate)
        if [ -z "$kit" ]; then
            echo "  the lane tooling is not on this machine." >&2
            echo "  Point at it with LANEKIT=/path/to/lanekit, or clone it beside this repository." >&2
            exit 1
        fi
        exec node "$kit/dev/$command.mjs" "$@" ;;
    check)
        exec "$here/check" "$@" ;;
    *)
        echo
        echo "  ./${slug} lane new <name>    start a lane: a worktree, a branch, a port of its own"
        echo "  ./${slug} lane list          what exists and what is serving"
        echo "  ./${slug} gate               from inside a lane: is this branch ready to merge?"
        echo "  ./${slug} lane land <name>   from main: merge a lane whose gate is green"
        echo "  ./${slug} lane sweep         remove lanes that have landed"
        echo "  ./${slug} check              what the gate runs"
        echo ;;
esac
`

const CHECK = `#!/bin/sh
# What the gate runs. Tier 1 of lane.config.json is this script and nothing else, so the
# project's tests go here and the config does not change when they arrive.
#
# It passes, and says every time that it looked at nothing: a green that checked nothing
# should not read like one that did. Replace the two lines below with the real thing —
#   exec npm test        exec .venv/bin/python -m pytest -q        exec go test ./...
echo "  check: nothing is checked yet. Put this project's tests in ./check."
exit 0
`

const GITIGNORE = `# A lane's port and paths live in its environment file, and secrets end up there too.
.env

# What the gate records about its runs. It names absolute paths on one machine.
.lanekit/
`

const readmeFor = (name, slug) => `# ${name}

Work happens in lanes: a worktree with its own branch and its own port, so two pieces of
work can be in flight without sharing a process or a file.

    ./${slug} lane new first-idea     then: cd ../${slug}-first-idea
    ./${slug} gate                    from inside the lane, when it is ready
    ./${slug} lane land first-idea    from here, once the gate is green

\`./check\` is what the gate runs, and today it checks nothing. \`lane.config.json\` says
what the project is; start there when it grows a server, an app, or a database a lane
must have its own copy of.
`

const main = () => {
    const argv = process.argv.slice(2)
    const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined)
    const valued = ['--dir', '--port-base']
    const positional = argv.filter((arg, i) => !arg.startsWith('--') && !valued.includes(argv[i - 1]))

    const name = positional[0]
    if (!name) {
        console.error('\n  usage: init <name> [--dir <path>] [--port-base <port>]\n')
        process.exit(1)
    }
    const slug = slugFor(name)
    if (!slug) fail(`"${name}" leaves nothing once it is made safe for a directory name.`)

    const dir = path.resolve(flag('--dir') ?? slug)
    if (fs.existsSync(dir) && fs.readdirSync(dir).length) {
        fail(`${dir} already has something in it.\n` +
            '  This starts a project from nothing. To give an existing repository lanes, write\n' +
            '  its lane.config.json and shim by hand: the README of lanekit says what each key decides.')
    }

    const rawBase = flag('--port-base')
    if (rawBase !== undefined && !/^\d+$/.test(rawBase)) fail(`--port-base "${rawBase}" is not a port number.`)
    const portBase = rawBase !== undefined ? Number(rawBase) : freeWindowBeside(dir)
    if (portBase < 1024 || portBase + WINDOW - 1 > 65535) fail(`a window starting at ${portBase} does not fit between 1024 and 65535.`)

    fs.mkdirSync(dir, { recursive: true })
    const write = (rel, text, mode) => {
        fs.writeFileSync(path.join(dir, rel), text)
        if (mode) fs.chmodSync(path.join(dir, rel), mode)
    }
    write(CONFIG_NAME, JSON.stringify(configFor(name, slug, portBase), null, 2) + '\n')
    write(slug, shimFor(name, slug), 0o755)
    write('check', CHECK, 0o755)
    write('.gitignore', GITIGNORE)
    write('README.md', readmeFor(name, slug))
    // The environment file a lane copies and then writes its own port into. Main's says
    // the first port of the window, so main and its first lane never serve on one.
    write('.env', `PORT=${portBase}\n`)
    log(`wrote ${CONFIG_NAME}, ./${slug}, ./check, .gitignore and README.md`)

    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
    try {
        git('init', '-q', '-b', 'main')
        git('add', '-A')
        git('commit', '-q', '-m', `Begin ${name}, with lanes from the first commit`)
    } catch (error) {
        fail(`the files are written, but git could not make the first commit in ${dir}:\n  ` +
            `${(error.stderr ?? error.message).toString().trim()}`)
    }
    log(`lanes take ports ${portBase + 1}–${portBase + WINDOW - 1}; main keeps ${portBase}`)

    const rule = '─'.repeat(64)
    console.log(`\n${rule}\n  ${GREEN}${name} is ready${OFF}\n${rule}\n`)
    console.log(`  cd ${dir}`)
    console.log(`  ./${slug} lane new first-idea\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) main()
