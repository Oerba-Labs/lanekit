/**
 * The page itself, end to end: `lane web` serving scratch repositories, and the page driven in a real Chrome as a
 * person drives it, pointer and keyboard, over the DevTools protocol (node's own WebSocket: no dependency). Once as a
 * browser shows it, and once as the editor does, with a stand-in for the extension that answers from the same server
 * and writes down what the page asked it to open. GitHub is lanekit's stand-in for gh (test/fake-gh).
 *
 *     node --test test/e2e.test.mjs
 *
 * Needs git, node and Chrome or Chromium (LANEKIT_CHROME names one elsewhere); skipped, and said, without one. Leaves
 * nothing. Each test goes on from where the one before left the repository, as a person's afternoon would.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const chromeAt = () => {
    const named = (name) => { const found = spawnSync('which', [name], { encoding: 'utf8' }); return found.status === 0 ? found.stdout.trim() : null }
    return [process.env.LANEKIT_CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
        ...['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(named)].find((candidate) => candidate && fs.existsSync(candidate)) ?? null
}
const CHROME = chromeAt()
// A CI runner is slower than a desk, and runs every test file at once on few cores: everything waits longer there.
const SLOW = process.env.CI ? 3 : 1
const skip = !CHROME ? 'no Chrome or Chromium here (LANEKIT_CHROME names one)' : typeof WebSocket !== 'function' ? 'this node has no WebSocket (node 22 or newer has)' : false

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-e2e-')))
const work = path.join(scratch, 'work')
const repo = path.join(work, 'demo')
const origin = path.join(scratch, 'origin.git')
const other = path.join(scratch, 'other')
const bin = path.join(scratch, 'bin')
const ghState = path.join(scratch, 'gh-state.json')
// The stand-in for gh first on the PATH, in this process too, before lanekit's modules load: they read the PATH then.
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: ghState })
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
Object.assign(process.env, env)
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const lane = (...args) => execFileSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)
const commit = (cwd, file, text, message) => { write(cwd, file, text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }
const laneDir = (name) => path.join(work, `demo-${name}`)
const status = (cwd) => execFileSync('git', ['status', '--porcelain'], { cwd, env, encoding: 'utf8' }).split('\n').filter(Boolean).sort()

// ---------------------------------------------------------------------------
// Chrome, over the DevTools protocol
// ---------------------------------------------------------------------------

const launch = async () => {
    const profile = fs.mkdtempSync(path.join(scratch, 'chrome-'))
    const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
        '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync',
        '--use-mock-keychain', '--password-store=basic', '--window-size=1400,1000',
        // A CI runner on Linux gives Chrome no user namespaces for its sandbox; the page it opens is our own, on the loopback.
        ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' })
    const portFile = path.join(profile, 'DevToolsActivePort')
    let lines = []
    for (let i = 0; i < 300 && !lines[1]; i++) {
        await sleep(50)
        if (fs.existsSync(portFile)) lines = fs.readFileSync(portFile, 'utf8').split('\n')
    }
    if (!lines[1]) { child.kill(); throw new Error('Chrome did not say where its DevTools listen') }
    const socket = new WebSocket(`ws://127.0.0.1:${lines[0]}${lines[1]}`)
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }) })
    let sequence = 0
    const waiting = new Map()
    socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data)
        const asked = message.id && waiting.get(message.id)
        if (!asked) return
        waiting.delete(message.id)
        if (message.error) asked.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`)); else asked.resolve(message.result)
    })
    // Every ask answered or refused in time: a Chrome that stops answering is said, with what it was asked, rather
    // than left to the test's own timeout, which says nothing of where it stood.
    const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
        const id = ++sequence
        const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`Chrome did not answer ${method} in 20 s`)) }, 20_000)
        waiting.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) }, reject: (error) => { clearTimeout(timer); reject(error) } })
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
    })
    const gone = new Promise((resolve) => child.once('exit', resolve))
    return { send, close: async () => { try { socket.close() } catch { /* gone */ } child.kill(); await Promise.race([gone, sleep(5000)]) } }
}

/**
 * The extension, as far as the page knows it: acquireVsCodeApi, answering the page's asks from the same server a browser
 * asks, telling the page the state every second as the extension does when anything changes, and writing down each
 * thing the page asks to open (a diff, a terminal) in window.__opened, where the editor would open it.
 */
const EDITOR = `
window.__opened = []
window.acquireVsCodeApi = () => {
    let kept = { only: 'demo' }
    const asJson = (response) => response.json()
    const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lanes': '1' }, body: JSON.stringify(body) })
    const methods = {
        state: () => fetch('api/state', { cache: 'no-store' }).then(asJson),
        press: async (body) => { const response = await post('api/jobs', body); return { status: response.status, body: await response.json() } },
        job: ({ id, from }) => fetch('api/jobs/' + id + '?from=' + from).then((response) => (response.ok ? response.json() : null)),
        cancel: ({ id }) => fetch('api/jobs/' + id + '/cancel', { method: 'POST', headers: { 'x-lanes': '1' } }).then((response) => response.ok),
        commit: ({ repo, sha }) => fetch('api/commit?repo=' + encodeURIComponent(repo) + '&sha=' + sha).then(asJson),
        history: ({ repo, way, lane }) => post('api/history', { repo, way, lane }).then(asJson),
        open: (params) => { window.__opened.push(params); return {} },
        copy: () => true,
        tab: () => true
    }
    let reading = false
    setInterval(async () => {
        if (reading) return
        reading = true
        try { window.postMessage({ type: 'state', state: await methods.state() }, '*') } catch {} finally { reading = false }
    }, 1000)
    return {
        postMessage: (message) => {
            if (message?.type !== 'request') return
            Promise.resolve().then(() => methods[message.method](message.params ?? {}))
                .then((value) => window.postMessage({ type: 'reply', id: message.id, ok: true, value }, '*'),
                    (error) => window.postMessage({ type: 'reply', id: message.id, ok: false, error: String(error) }, '*'))
        },
        setState: (value) => { kept = value },
        getState: () => kept
    }
}`

/** A tab on `url`, and what a test does with it: run a function in the page, wait for one to be true, point, click, type. */
const open = async (browser, url, { editor = false } = {}) => {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    const send = (method, params) => browser.send(method, params, sessionId)
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Page.setBypassCSP', { enabled: true })
    await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false })
    if (editor) await send('Page.addScriptToEvaluateOnNewDocument', { source: EDITOR })
    await send('Page.navigate', { url })
    // Each function is run with the finders below in its scope.
    const run = async (fn, ...args) => {
        const result = await send('Runtime.evaluate', { expression: `(() => { ${FINDERS} return (${fn})(...${JSON.stringify(args)}) })()`, awaitPromise: true, returnByValue: true })
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
        return result.result.value
    }
    const until = async (fn, args = [], { timeout = 30_000 * SLOW, what = String(fn).slice(0, 160) } = {}) => {
        const by = Date.now() + timeout
        let last
        for (let i = 0; Date.now() < by; i++) {
            try { last = await run(fn, ...args); if (last) return last } catch (error) { last = error.message }
            // Asked again now and then rather than at the page's own pace (every four seconds in a browser).
            if (i % 6 === 5) await run(() => (typeof refresh === 'function' ? refresh() : null)).catch(() => {})
            await sleep(150)
        }
        const shown = await run(() => `${location.href}: ${document.body?.innerText.replace(/\s+/g, ' ').slice(0, 600)}`).catch((error) => error.message)
        // And what LaneKit ran meanwhile, the newest's output's end with it: where a press went wrong, it says why.
        const ran = await run(async () => {
            const jobs = (await (await fetch('api/state', { cache: 'no-store' })).json()).jobs ?? []
            const newest = jobs[0] ? await (await fetch(`api/jobs/${jobs[0].id}`)).json() : null
            return `${jobs.slice(0, 4).map((job) => `${job.verb}${job.lane ? ` ${job.lane}` : ''} ${job.state}${job.code === null ? '' : ` (exit ${job.code})`}`).join(', ') || 'nothing'}` +
                (newest ? `; the newest printed: ${String(newest.output).slice(-800)}` : '')
        }).catch((error) => error.message)
        throw new Error(`waited ${timeout} ms for ${what}; last said ${JSON.stringify(last)}; the page showed ${shown}; LaneKit ran ${ran}`)
    }
    /** The pointer onto the middle of what `find` finds in the page (a function there that returns an element). */
    const pointAt = async (find, ...args) => {
        const at = await until(`(...args) => { const node = (${find})(...args); if (!node) return null; node.scrollIntoView({ block: 'center' });
            const box = node.getBoundingClientRect(); return box.width && box.height ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null }`, args, { what: `${find}` })
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
        return at
    }
    // The pointer goes to it first, as a person's would (what shows only under the pointer shows), and then it is
    // clicked as it is found at that moment: a page that redrew in between (an answer from GitHub coming in, and a
    // line drawn above) would otherwise take the press somewhere else. Its click bubbles as a person's does.
    const click = async (find, ...args) => {
        await pointAt(find, ...args)
        await until(`(...args) => { const node = (${find})(...args); if (!node) return false; node.click(); return true }`, args, { what: `${find}, clicked` })
    }
    const type = (text) => send('Input.insertText', { text })
    // Closing a tab never holds a test past what it found: a failure's own words are what it reports.
    const close = () => Promise.race([browser.send('Target.closeTarget', { targetId }).catch(() => null), sleep(5000)])
    return { run, until, pointAt, click, type, close }
}

// Finders, run in the page: each is a function there.
const card = (name) => document.querySelector(`li.lane[data-key="demo/${name}"]`)
const buttonIn = (selector, label) => [...(document.querySelector(selector)?.querySelectorAll('button') ?? [])]
    .find((button) => (button.getAttribute('aria-label') || button.textContent).trim().startsWith(label))
const laneButton = (name, label) => [...(document.querySelector(`li.lane[data-key="demo/${name}"]`)?.querySelectorAll('button') ?? [])]
    .find((button) => (button.getAttribute('aria-label') || button.textContent).trim().startsWith(label))
/** The finders above, put in the scope of every function a test runs in the page. */
const FINDERS = `const card = ${card}; const buttonIn = ${buttonIn}; const laneButton = ${laneButton};`

// ---------------------------------------------------------------------------
// the repositories, the server and the browser
// ---------------------------------------------------------------------------

let browser, server, base, page

before(async () => {
    if (skip) return
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(KIT, 'test', 'fake-gh')}" "$@"\n`, { mode: 0o755 })
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    const config = (portBase) => JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'the checks', command: 'true', args: [] }] } } },
        lane: { portBase, portCeiling: portBase + 98, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    })
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', config(19201))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    write(repo, 'app.txt', 'one\ntwo\nthree\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    // Named as GitHub names it, sent to the bare repository here.
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git')
    git(repo, 'config', `url.${origin}.insteadOf`, 'git@github.com:acme/demo.git')
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    git(scratch, 'clone', '-q', origin, other)

    // A second repository with lanes set up and none made.
    const quiet = path.join(work, 'quiet')
    fs.mkdirSync(quiet)
    write(quiet, 'lane.config.json', config(19301).replace('"Demo"', '"Quiet"').replace('"demo"', '"quiet"'))
    write(quiet, 'readme.txt', 'quiet\n')
    git(quiet, 'init', '-q', '-b', 'main')
    git(quiet, 'add', '-A')
    git(quiet, 'commit', '-qm', 'Begin quietly')

    // feature: a commit, and two files not committed. ready: a commit, not gated yet.
    lane('new', 'feature')
    commit(laneDir('feature'), 'feature.txt', 'feature\n', 'Start the feature')
    write(laneDir('feature'), 'feature.txt', 'feature, better\n')
    write(laneDir('feature'), 'notes.txt', 'notes\n')
    lane('new', 'ready')
    commit(laneDir('ready'), 'ready.txt', 'ready\n', 'Make it ready')
    // shared: pushed, so somebody else can push to it.
    lane('new', 'shared')
    commit(laneDir('shared'), 'shared.txt', 'shared\n', 'Share it')
    lane('push', 'shared')
    // shipped: its pull request merged on GitHub (squashed there), and work carried on in it after.
    lane('new', 'shipped')
    commit(laneDir('shipped'), 'shipped.txt', 'shipped\n', 'Ship it')
    const shippedAt = git(laneDir('shipped'), 'rev-parse', 'HEAD')
    commit(laneDir('shipped'), 'after.txt', 'after\n', 'After the merge')
    write(laneDir('shipped'), 'wip.txt', 'wip\n')
    fs.writeFileSync(ghState, JSON.stringify({
        owner: 'acme', name: 'demo', origin, repo: { mergeCommitAllowed: true },
        prs: [{ number: 4, title: 'Ship it', state: 'MERGED', isDraft: false, headRefName: 'shipped', headRefOid: shippedAt, url: 'https://github.com/acme/demo/pull/4' }]
    }))

    const { startServer } = await import('../dev/web.mjs')
    const started = await startServer({ scan: work, port: 0 })
    server = started.server
    base = `http://127.0.0.1:${started.port}/`
    browser = await launch()
    page = await open(browser, `${base}?repo=demo`)
    await page.until((() => card('feature') && card('ready') && card('shared') && card('shipped')), [], { what: 'the four lanes drawn' })
})

after(async () => {
    await browser?.close()
    server?.close()
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

// ---------------------------------------------------------------------------

test('the page says nothing of where you are, nor Goto, nor that a repository has no lanes, nor how many files a lane changed', { skip, timeout: 60_000 * SLOW }, async () => {
    const text = await page.run(() => document.body.innerText)
    assert.doesNotMatch(text, /You are here/)
    assert.doesNotMatch(text, /\bGoto\b/)
    assert.equal(await page.run((() => [...card('feature').querySelectorAll('.facts button')].filter((button) => /files? changed/.test(button.textContent)).length)), 0)

    const quiet = await open(browser, `${base}?repo=quiet`)
    try {
        await quiet.until(() => document.querySelector('.repo-head h2')?.textContent === 'Quiet' && document.querySelector('li.commit.tip'))
        assert.equal(await quiet.run(() => document.querySelectorAll('.empty-lanes').length), 0)
        assert.doesNotMatch(await quiet.run(() => document.body.innerText), /No lanes yet/)
        // A lane is started from a commit, as from any: the pointer on main's commit offers it.
        await quiet.pointAt(() => document.querySelector('li.commit.tip .subject'))
        assert.ok(await quiet.until(() => document.querySelector('li.commit.tip button[aria-label="New lane here"]')?.checkVisibility({ visibilityProperty: true })), 'New lane here, on main\'s commit')
    } finally {
        await quiet.close()
    }
})

test('a lane is drawn from where it forked up: its uncommitted files on top, its commits under them, its name at its base', { skip, timeout: 60_000 * SLOW }, async () => {
    const layout = await page.run((() => {
        const lane = card('feature')
        const kids = [...lane.children]
        const at = (selector) => kids.findIndex((kid) => kid.matches(selector))
        const box = (node) => node.getBoundingClientRect()
        const commits = [...lane.querySelectorAll(':scope > .stack > .stack-commit')]
        return {
            order: [at('.changes'), at('.stack'), at('.lane-head')],
            filesAboveCommits: box(lane.querySelector(':scope > .changes')).bottom <= box(commits[0]).top + 1,
            nameBelowCommits: box(lane.querySelector(':scope > .lane-head')).top >= box(commits.at(-1)).bottom - 1,
            name: lane.querySelector('.lane-head .lane-name').textContent
        }
    }))
    assert.ok(layout.order[0] < layout.order[1] && layout.order[1] < layout.order[2], JSON.stringify(layout.order))
    assert.ok(layout.filesAboveCommits)
    assert.ok(layout.nameBelowCommits)
    assert.equal(layout.name, 'feature')
})

test('a lane\'s buttons sit beside its name and state, and are held until what they need is there, saying what that is', { skip, timeout: 120_000 * SLOW }, async () => {
    await page.pointAt((() => card('ready').querySelector('.lane-name')))
    const placed = await page.until((() => {
        const head = card('ready').querySelector('.lane-title')
        const actions = head.querySelector(':scope > .hover-actions')
        if (getComputedStyle(actions).visibility !== 'visible') return null
        const said = head.querySelector(':scope > .state').getBoundingClientRect()
        const box = actions.getBoundingClientRect()
        return { gap: box.left - said.right, right: box.right, pane: document.querySelector('#repos').getBoundingClientRect().right }
    }), [], { what: 'ready\'s toolbar shown under the pointer' })
    assert.ok(placed.gap >= 0 && placed.gap < 40, `beside its state: ${JSON.stringify(placed)}`)
    assert.ok(placed.right < placed.pane - 200, `not across the page: ${JSON.stringify(placed)}`)

    const held = await page.run((() => {
        const say = (button) => ({ disabled: button.disabled, title: button.title })
        return { readyGate: say(laneButton('ready', 'Gate')), readyLand: say(laneButton('ready', 'Land')), featureGate: say(laneButton('feature', 'Gate')), featureLand: say(laneButton('feature', 'Land')) }
    }))
    assert.equal(held.readyGate.disabled, false, 'a commit, nothing uncommitted: it can be gated')
    assert.equal(held.readyLand.disabled, true)
    assert.match(held.readyLand.title, /^Gate it first: a land needs a green gate on its newest commit/)
    assert.equal(held.featureGate.disabled, true)
    assert.match(held.featureGate.title, /^Commit first/)
    assert.match(held.featureLand.title, /^Commit first/)

    // Gated from the page: then, and only then, Land.
    await page.click((() => laneButton('ready', 'Gate')))
    await page.click((() => laneButton('ready', 'Gate it')))
    await page.until((() => { const land = laneButton('ready', 'Land'); return land && !land.disabled && card('ready').querySelector('.lane-title > .state').textContent === 'Ready to land' }),
        [], { what: 'ready gated green, and Land pressable' })
    assert.equal(await page.run((() => laneButton('ready', 'Land').classList.contains('primary'))), true, 'the next thing to do, solid')
})

test('every uncommitted file is ticked at first, and a tick only ticks', { skip, timeout: 60_000 * SLOW }, async () => {
    const ticks = () => [...document.querySelectorAll('li.lane[data-key="demo/feature"] > .changes .tick')].map((tick) => tick.checked)
    assert.deepEqual(await page.run(ticks), [true, true])
    await page.click((() => card('feature').querySelector(':scope > .changes .tick')))
    await page.until(`() => { const all = (${ticks})(); return all[0] === false && all[1] === true }`)
    assert.match(await page.run((() => laneButton('feature', 'Commit').textContent)), /Commit 1 of 2…/)
})

test('the main checkout\'s uncommitted files are drawn on main\'s line, ticked, and move to a new lane of their own', { skip, timeout: 120_000 * SLOW }, async () => {
    write(repo, 'app.txt', 'one\ntwo, begun in main\nthree\n')
    write(repo, 'idea.txt', 'an idea, begun in main\n')
    const drawn = await page.until(() => {
        const row = document.querySelector('li.main-changes')
        const files = row ? [...row.querySelectorAll('.change-path')].map((node) => node.textContent) : []
        return files.length === 2 ? { files, nextIsTip: row.nextElementSibling?.classList.contains('tip'), ticked: [...row.querySelectorAll('.tick')].every((tick) => tick.checked) } : null
    }, [], { what: 'main\'s two files on its line' })
    assert.deepEqual(drawn.files.sort(), ['app.txt', 'idea.txt'])
    assert.ok(drawn.nextIsTip, 'just above main\'s newest commit, the one they were begun on')
    assert.ok(drawn.ticked)
    assert.doesNotMatch(await page.run(() => document.querySelector('section.repo .facts').textContent), /uncommitted/, 'not a label above any more')

    // app.txt stays in main; idea.txt goes to a lane of its own.
    await page.click(() => [...document.querySelectorAll('li.main-changes li')].find((row) => row.textContent.includes('app.txt')).querySelector('.tick'))
    await page.click(() => buttonIn('li.main-changes', 'Move 1 of 2 to a new lane'))
    await page.until(() => document.activeElement?.matches('li.main-changes .confirm.carry input'))
    await page.type('idea')
    await page.click(() => buttonIn('li.main-changes', 'Move them'))
    await page.until((() => {
        const idea = card('idea')
        return idea && !idea.classList.contains('pending') && [...idea.querySelectorAll(':scope > .changes .change-path')].map((node) => node.textContent).join() === 'idea.txt' &&
            [...document.querySelectorAll('li.main-changes .change-path')].map((node) => node.textContent).join() === 'app.txt'
    }), [], { what: 'idea made with idea.txt, and app.txt left in main' })
    assert.deepEqual(status(repo), [' M app.txt'])
    assert.equal(fs.readFileSync(path.join(laneDir('idea'), 'idea.txt'), 'utf8'), 'an idea, begun in main\n')
})

test('Pull is shown when origin has commits main lacks, held while main has uncommitted work, saying why, then pulls', { skip, timeout: 120_000 * SLOW }, async () => {
    git(other, 'pull', '-q', 'origin', 'main')
    commit(other, 'theirs.txt', 'theirs\n', 'Somebody else lands')
    git(other, 'push', '-q', 'origin', 'main')
    await page.click(() => buttonIn('.repo-head', 'Fetch'))
    const held = await page.until(() => { const pull = buttonIn('.repo-head', 'Pull 1'); return pull ? { disabled: pull.disabled, title: pull.title } : null }, [], { what: 'Pull 1 beside the repository\'s name' })
    assert.equal(held.disabled, true)
    assert.match(held.title, /The main checkout has 1 uncommitted file: move them to a lane, or discard them, first/)

    // Discarded from main's own node: then Pull can run, and does.
    await page.click(() => buttonIn('li.main-changes', 'Discard'))
    await page.click(() => buttonIn('li.main-changes', 'Discard it'))
    await page.until(() => !document.querySelector('li.main-changes') && buttonIn('.repo-head', 'Pull 1')?.disabled === false, [], { what: 'main clean, and Pull pressable' })
    await page.click(() => buttonIn('.repo-head', 'Pull 1'))
    await page.until(() => !buttonIn('.repo-head', 'Pull'), [], { what: 'nothing left to pull' })
    assert.equal(fs.readFileSync(path.join(repo, 'theirs.txt'), 'utf8'), 'theirs\n')
})

test('a lane whose copy on origin moved on says so, and Pull fast-forwards it', { skip, timeout: 120_000 * SLOW }, async () => {
    git(other, 'fetch', '-q', 'origin')
    git(other, 'switch', '-q', 'shared')
    commit(other, 'suggestion.txt', 'a suggestion from review\n', 'Apply a suggestion')
    git(other, 'push', '-q', 'origin', 'shared')
    await page.click(() => buttonIn('.repo-head', 'Fetch'))
    await page.until((() => /1 new on origin\/shared/.test(card('shared').querySelector('.lane-title > .state').textContent)), [], { what: 'shared saying it is behind its copy on origin' })
    await page.pointAt((() => card('shared').querySelector('.lane-name')))
    assert.equal(await page.until((() => laneButton('shared', 'Pull')?.classList.contains('primary'))), true)
    await page.click((() => laneButton('shared', 'Pull')))
    for (let i = 0; i < 100 && !fs.existsSync(path.join(laneDir('shared'), 'suggestion.txt')); i++) await sleep(100)
    assert.equal(fs.readFileSync(path.join(laneDir('shared'), 'suggestion.txt'), 'utf8'), 'a suggestion from review\n')
    await page.until((() => !/new on origin/.test(card('shared').querySelector('.lane-title > .state').textContent)), [], { what: 'shared no longer behind' })
})

test('a pull request merged on GitHub says so, holds Commit, and moves what came after it to a new lane', { skip, timeout: 120_000 * SLOW }, async () => {
    await page.until((() => card('shipped')?.querySelector('.lane-title > .state')?.textContent === 'Merged on GitHub, with work since'), [], { what: 'shipped seen as merged, with work since' })
    const held = await page.run((() => ({
        commit: Boolean(laneButton('shipped', 'Commit')),
        move: Boolean(laneButton('shipped', 'Move to a new lane')),
        note: card('shipped').querySelector('.merged-note')?.textContent
    })))
    assert.equal(held.commit, false, 'no Commit on a merged lane')
    assert.equal(held.move, true)
    assert.match(held.note, /#4 was merged on GitHub, so a commit here would be in no pull request/)

    await page.click((() => card('shipped').querySelector(':scope > .changes .changes-actions:not(.tools) button')))
    await page.until(() => document.activeElement?.matches('li.lane[data-key="demo/shipped"] .confirm.carry input'))
    assert.match(await page.run((() => card('shipped').querySelector('.confirm.carry p').textContent)), /1 commit made since #4 was merged and 1 uncommitted file/)
    await page.type('shipped-next')
    await page.click((() => laneButton('shipped', 'Move them')))
    await page.until((() => {
        const next = card('shipped-next')
        return next && !next.classList.contains('pending') && next.querySelector('.stack .subject')?.textContent === 'After the merge' &&
            [...next.querySelectorAll(':scope > .changes .change-path')].map((node) => node.textContent).join() === 'wip.txt'
    }), [], { what: 'shipped-next with the commit and the file' })
    // What was merged is left, with nothing of its own: its one thing to do now is to be dropped.
    await page.pointAt((() => card('shipped').querySelector('.lane-name')))
    await page.until((() => card('shipped').querySelector('.lane-title > .state').textContent === 'Merged on GitHub' && laneButton('shipped', 'Drop')?.classList.contains('primary')),
        [], { what: 'shipped merged, clean, Drop next' })
})

test('in the editor, a file\'s tick only ticks, a click on the file opens its diff, and the terminal icon is the way to a lane\'s terminal', { skip, timeout: 60_000 * SLOW }, async () => {
    const editor = await open(browser, base, { editor: true })
    try {
        await editor.until((() => document.body.classList.contains('in-editor') && card('feature')?.querySelector(':scope > .changes .tick')))
        await editor.click((() => card('feature').querySelector(':scope > .changes .tick')))
        await editor.until((() => card('feature').querySelector(':scope > .changes .tick').checked === false))
        assert.deepEqual(await editor.run(() => window.__opened), [], 'unticking opened nothing')

        await editor.click((() => card('feature').querySelector(':scope > .changes .change-path')))
        const diff = await editor.until(() => window.__opened.at(-1))
        assert.equal(diff.what, 'uncommitted')
        assert.equal(diff.name, 'feature')

        await editor.pointAt((() => card('ready').querySelector('.lane-name.tag')))
        const terminal = await editor.until((() => {
            const button = card('ready').querySelector('.hover-actions button[aria-label="Terminal in ready"]')
            return button?.checkVisibility({ visibilityProperty: true }) ? { icon: Boolean(button.querySelector('svg.icon-terminal')), words: button.textContent.trim() } : null
        }), [], { what: 'ready\'s terminal icon under the pointer' })
        assert.deepEqual(terminal, { icon: true, words: '' }, 'an icon, its words its title')
        await editor.click((() => card('ready').querySelector('.hover-actions button[aria-label="Terminal in ready"]')))
        const asked = await editor.until(() => window.__opened.find((one) => one.what === 'goto'))
        assert.equal(asked.lane, 'ready')
        const text = await editor.run(() => document.body.innerText)
        assert.doesNotMatch(text, /\bGoto\b/)
        assert.doesNotMatch(text, /You are here/)
    } finally {
        await editor.close()
    }
})
