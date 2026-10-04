/**
 * LaneKit's MCP server (bin/mcp.mjs), spoken to as an agent's client speaks to it: newline-delimited JSON-RPC on its
 * stdin and stdout. Its handshake, its tools and what each says it does (only reads, reaches GitHub, removes
 * something), and a lane's afternoon through it on a scratch repository: made, committed, refused a land before its
 * gate, gated, landed; work begun in the main checkout carried into a lane; and a repository it cannot find said so.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { after, before, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)

let scratch, repo, server, next = 0
const waiting = new Map()
/** One request, and its answer. */
const ask = (method, params) => new Promise((resolve) => {
    const id = ++next
    waiting.set(id, resolve)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
})
const tool = async (name, args = {}) => {
    const answer = await ask('tools/call', { name, arguments: args })
    return { text: answer.result.content.map((part) => part.text).join('\n'), isError: answer.result.isError }
}

before(() => {
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-mcp-')))
    repo = path.join(scratch, 'work', 'demo')
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: { portBase: 19001, portCeiling: 19099, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    write(repo, 'app.txt', 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    // Started as a client starts it: in a folder of its own, told the project by LANEKIT_PROJECT.
    server = spawn(process.execPath, [path.join(KIT, 'bin', 'mcp.mjs')], { cwd: os.tmpdir(), env: { ...env, LANEKIT_PROJECT: repo }, stdio: ['pipe', 'pipe', 'inherit'] })
    readline.createInterface({ input: server.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message)
        waiting.delete(message.id)
    })
})

after(() => {
    server?.stdin.end()
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('it answers the handshake in the version asked, with its tools and what each may do', async () => {
    const hello = await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
    assert.equal(hello.result.protocolVersion, '2025-06-18')
    assert.deepEqual(hello.result.capabilities, { tools: { listChanged: false } })
    assert.equal(hello.result.serverInfo.name, 'lanekit')
    assert.match(hello.result.instructions, /Call lanes first/)
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    assert.deepEqual((await ask('ping')).result, {})
    const unknown = await ask('initialize', { protocolVersion: '1999-01-01' })
    assert.equal(unknown.result.protocolVersion, '2025-06-18', 'a version it does not speak is answered with one it does')

    const { tools } = (await ask('tools/list')).result
    const named = Object.fromEntries(tools.map((one) => [one.name, one]))
    assert.deepEqual(Object.keys(named).sort(), ['commit', 'drop', 'gate', 'land', 'lanes', 'new_lane', 'pull', 'pull_request', 'push', 'rebase', 'resolve', 'review'])
    assert.equal(named.lanes.annotations.readOnlyHint, true)
    for (const removes of ['land', 'drop']) assert.equal(named[removes].annotations.destructiveHint, true, removes)
    for (const reaches of ['push', 'pull_request', 'review', 'pull']) assert.equal(named[reaches].annotations.openWorldHint, true, reaches)
    for (const one of tools) assert.equal(one.inputSchema.type, 'object', one.name)
    assert.deepEqual(named.review.inputSchema.properties.verdict.enum, ['approve', 'request-changes', 'comment'])
    assert.equal((await ask('no/such')).error.code, -32601)
})

test('a lane through its tools: made, committed, refused a land before its gate, gated, landed', async () => {
    let said = await tool('lanes')
    assert.match(said.text, /^Demo at .*demo: main at [0-9a-f]+ "Begin"/)
    assert.match(said.text, /No lanes yet: new_lane makes one/)

    said = await tool('new_lane', { name: 'idea' })
    assert.equal(said.isError, false, said.text)
    const folder = path.join(scratch, 'work', 'demo-idea')
    assert.match(said.text, new RegExp(`Made idea, at ${folder}, port 190\\d\\d: work there, in that folder`))
    write(folder, 'idea.txt', 'an idea\n')
    said = await tool('lanes')
    assert.match(said.text, /- idea \(commit first\) at .*demo-idea, branch idea, port 190\d\d/)
    assert.match(said.text, /uncommitted: new idea\.txt/)

    said = await tool('commit', { lane: 'idea', message: 'Have an idea' })
    assert.equal(said.isError, false, said.text)
    assert.match(said.text, /^Committed in idea\./)
    said = await tool('land', { lane: 'idea' })
    assert.equal(said.isError, true, 'not gated yet')
    assert.match(said.text, /cannot land yet/)
    assert.ok(fs.existsSync(folder), 'and nothing removed')

    said = await tool('gate', { lane: 'idea' })
    assert.equal(said.isError, false, said.text)
    assert.match(said.text, /READY/)
    assert.match((await tool('lanes')).text, /- idea \(ready to land\)/)
    said = await tool('land', { lane: 'idea' })
    assert.equal(said.isError, false, said.text)
    assert.match(said.text, /LANDED/)
    assert.ok(!fs.existsSync(folder))
    assert.equal(git(repo, 'show', 'main:idea.txt'), 'an idea')
})

test('work begun in the main checkout is carried into a lane, and what the service refuses comes back as an error, in its words', async () => {
    write(repo, 'begun.txt', 'begun in main\n')
    assert.match((await tool('lanes')).text, /The main checkout has 1 uncommitted file: begun\.txt \(new_lane with carry moves them into a lane/)
    const carried = await tool('new_lane', { name: 'begun', carry: true })
    assert.equal(carried.isError, false, carried.text)
    assert.equal(fs.readFileSync(path.join(scratch, 'work', 'demo-begun', 'begun.txt'), 'utf8'), 'begun in main\n')
    assert.equal(git(repo, 'status', '--porcelain'), '')

    const twice = await tool('new_lane', { name: 'begun' })
    assert.deepEqual([twice.isError, twice.text], [true, 'Refused: there is a lane called begun already.'])
    assert.match((await tool('new_lane', {})).text, /needs a name \(or a pr to review\)/)
    const review = await tool('review', { lane: 'begun', verdict: 'approve' })
    assert.equal(review.isError, true)
    assert.match(review.text, /begun is not a review of a pull request/)
    const nowhere = await tool('lanes', { repo: os.tmpdir() })
    assert.equal(nowhere.isError, true)
    assert.match(nowhere.text, /there is no repository with lanes at/)
    assert.match((await tool('no_such_tool')).text, /There is no tool called no_such_tool/)
})
