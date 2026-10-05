/**
 * LaneKit's plugin for Claude Code, as Claude Code reads it: its manifest and its marketplace's (.claude-plugin/), its
 * skills (claude/skills), its hooks (claude/hooks.json, the same events lanekit's own hooks report), its MCP server
 * (claude/mcp.json), and its launcher (bin/plugin-run.mjs), which hands over to the machine's lanekit where it has
 * what is asked for, and stays quiet where lanekit's own hooks report already. Where Claude Code is installed, its own
 * validator is asked too.
 *
 *     node --test
 *
 * Needs node; reads files, and a scratch folder for the launcher.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { CLAUDE_EVENTS } from '../lib/agents.mjs'
import { lanekitRoot, reportedAlready } from '../bin/plugin-run.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const json = (file) => JSON.parse(fs.readFileSync(path.join(KIT, file), 'utf8'))
const plugin = json('.claude-plugin/plugin.json')
const skills = fs.readdirSync(path.join(KIT, 'claude', 'skills'))
/** A skill's frontmatter, as key: value lines, and its body. */
const skillOf = (name) => {
    const text = fs.readFileSync(path.join(KIT, 'claude', 'skills', name, 'SKILL.md'), 'utf8')
    const found = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
    assert.ok(found, `${name}'s SKILL.md opens with frontmatter`)
    return { meta: Object.fromEntries(found[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()])), body: found[2] }
}
// The MCP server's tools, read from its source as it declares them.
const TOOLS = [...fs.readFileSync(path.join(KIT, 'bin', 'mcp.mjs'), 'utf8').matchAll(/^\s+name: '([a-z_]+)',$/gm)].map((found) => found[1])

test('the manifest names the plugin, and every part it points at is there', () => {
    assert.equal(plugin.name, 'lanekit')
    assert.equal(plugin.license, 'Apache-2.0')
    for (const part of ['skills', 'hooks', 'mcpServers']) {
        assert.match(plugin[part], /^\.\//, `${part} is a path from the plugin's root`)
        assert.ok(fs.existsSync(path.join(KIT, plugin[part])), `${part}: ${plugin[part]}`)
    }
    assert.equal(plugin.version, undefined, 'no version: it follows stable, rather than waiting on a number')
})

test('the marketplace offers the plugin from lanekit\'s stable branch, the commits whose tests passed', () => {
    const market = json('.claude-plugin/marketplace.json')
    assert.equal(market.name, 'lanekit')
    assert.deepEqual(market.plugins.map((one) => one.name), ['lanekit'])
    assert.deepEqual(market.plugins[0].source, { source: 'github', repo: 'Oerba-Labs/lanekit', ref: 'stable' })
})

test('each skill says when it is for, the ones a person starts are theirs alone, and every tool a skill names is the server\'s', () => {
    assert.deepEqual(skills.sort(), ['land', 'land-ready', 'lane', 'lanes', 'resolve-conflicts', 'review'])
    for (const name of skills) {
        const { meta, body } = skillOf(name)
        assert.equal(meta.name, name, `${name}: its name is its folder's`)
        assert.ok(meta.description.length > 60, `${name}: says when it is for`)
        const started = ['lane', 'land', 'land-ready'].includes(name)
        assert.equal(meta['disable-model-invocation'] === 'true', started, `${name}: ${started ? 'a person starts it' : 'Claude may reach for it'}`)
        for (const allowed of (meta['allowed-tools'] ?? '').split(',').map((one) => one.trim()).filter((one) => one.startsWith('mcp__'))) {
            assert.match(allowed, /^mcp__plugin_lanekit_lanekit__/, `${name}: ${allowed} is the plugin's server`)
            assert.ok(TOOLS.includes(allowed.replace('mcp__plugin_lanekit_lanekit__', '')), `${name}: ${allowed} is a tool the server has`)
            assert.ok(!/land|drop|push|review$/.test(allowed), `${name}: never lets ${allowed} past without asking`)
        }
        for (const [, named] of body.matchAll(/\*\*`([a-z_]+)`\*\*|`([a-z_]+)` with/g)) if (named) assert.ok(TOOLS.includes(named), `${name} names ${named}, which the server has`)
    }
    assert.match(skillOf('review').body, /only on their yes/)
    assert.match(skillOf('lanes').body, /Never change files in the main checkout/)
})

test('its hooks are lanekit\'s own events, each reported through the launcher, in the background but for SessionEnd', () => {
    const { hooks } = json('claude/hooks.json')
    assert.deepEqual(Object.keys(hooks), CLAUDE_EVENTS)
    for (const [event, groups] of Object.entries(hooks)) {
        assert.equal(groups.length, 1)
        const [hook] = groups[0].hooks
        assert.equal(hook.command, 'node "${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.mjs" report claude || true', event)
        if (event === 'SessionEnd') assert.equal(hook.timeout, 5); else assert.equal(hook.async, true, event)
    }
})

test('its MCP server is started through the launcher, told the project it runs in', () => {
    assert.deepEqual(json('claude/mcp.json').mcpServers.lanekit, {
        command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/bin/plugin-run.mjs', 'mcp'], env: { LANEKIT_PROJECT: '${CLAUDE_PROJECT_DIR}' }
    })
})

test('the launcher runs the machine\'s lanekit where it has what is asked for, else the plugin\'s own, and reports once', () => {
    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-plugin-')))
    try {
        const machine = path.join(scratch, 'machine-lanekit')
        fs.mkdirSync(path.join(machine, 'dev'), { recursive: true })
        fs.writeFileSync(path.join(machine, 'dev', 'lane.mjs'), '')
        const home = path.join(scratch, 'home')
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
        assert.equal(lanekitRoot(['dev', 'lane.mjs'], { LANEKIT: machine }, home), machine, 'the machine\'s, as the editor and the shims run it')
        assert.equal(lanekitRoot(['bin', 'mcp.mjs'], { LANEKIT: machine }, home), KIT, 'an older copy without the MCP server: the plugin\'s own')
        assert.equal(lanekitRoot(['dev', 'lane.mjs'], {}, home), fs.existsSync('/opt/lanekit/dev/lane.mjs') ? '/opt/lanekit' : KIT)
        assert.equal(reportedAlready(home), false)
        fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: "node '/x/dev/lane.mjs' report claude || true" }] }] } }))
        assert.equal(reportedAlready(home), true, 'lanekit\'s own hooks report: the plugin\'s stay quiet')
        const usage = spawnSync(process.execPath, [path.join(KIT, 'bin', 'plugin-run.mjs')], { encoding: 'utf8' })
        assert.equal(usage.status, 2)
        assert.match(usage.stderr, /usage: plugin-run\.mjs report <agent> \| mcp/)
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true })
    }
})

const claude = spawnSync('claude', ['--version'], { encoding: 'utf8' })
test('Claude Code\'s own validator passes the plugin and its marketplace', { skip: claude.status === 0 ? false : 'Claude Code is not installed here' }, () => {
    const checked = spawnSync('claude', ['plugin', 'validate', KIT], { encoding: 'utf8', timeout: 60_000 })
    assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`)
    assert.match(`${checked.stdout}`, /Validation passed/)
})
