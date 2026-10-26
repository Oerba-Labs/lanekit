/**
 * The page end to end (test/e2e-harness says how): a lane's buttons, held until what they need is there; a pull request
 * reviewed in a lane from Home; a lane's full suite, where a land needs it; and then, with a lane ready to land and a review lane in it, nothing on the page wider
 * than the narrowest side bar, as this machine draws it.
 *
 *     node --test test/e2e-narrow.test.mjs
 *
 * Needs git, node and Chrome or Chromium (LANEKIT_CHROME names one elsewhere); skipped, and said, without one. Leaves
 * nothing. Each test goes on from where the one before it in this file left the repository, as a person's afternoon
 * would.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { KIT, sleep, SLOW, skip, scratch, work, env, git, commit, ghState, laneDir, open, card, buttonIn, laneButton, begin, end, nothingWider } from './e2e-harness'

let browser, base, page

before(async () => { if (!skip) ({ browser, base, page } = await begin()) })
after(end)

// ---------------------------------------------------------------------------

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
        return { readyGate: say(laneButton('ready', 'Verify')), readyLand: say(laneButton('ready', 'Land')), featureGate: say(laneButton('feature', 'Verify')), featureLand: say(laneButton('feature', 'Land')) }
    }))
    assert.equal(held.readyGate.disabled, false, 'a commit, nothing uncommitted: it can be gated')
    assert.equal(held.readyLand.disabled, true)
    assert.match(held.readyLand.title, /^Verify it first: a land needs its newest commit verified/)
    assert.equal(held.featureGate.disabled, true)
    assert.match(held.featureGate.title, /^Commit first/)
    assert.match(held.featureLand.title, /^Commit first/)

    // Gated from the page: then, and only then, Land.
    await page.click((() => laneButton('ready', 'Verify')))
    await page.click((() => laneButton('ready', 'Verify it')))
    await page.until((() => { const land = laneButton('ready', 'Land'); return land && !land.disabled && card('ready').querySelector('.lane-title > .state').textContent === 'Ready to land' }),
        [], { what: 'ready gated green, and Land pressable' })
    assert.equal(await page.run((() => laneButton('ready', 'Land').classList.contains('primary'))), true, 'the next thing to do, solid')
})

test('a pull request waiting on your review opens in a lane of its own from Home, and is approved from its lane', { skip, timeout: 120_000 * SLOW }, async () => {
    const home = await open(browser, base)
    try {
        await home.until(() => [...document.querySelectorAll('.home-reviews li')].some((row) => row.textContent.includes('Teach it to count')), [], { what: 'Home listing #8 as waiting on this person\'s review' })
        await home.click(() => buttonIn('.home-reviews', 'Review in a lane'))
        await home.until(() => {
            const lane = card('review-8')
            return lane && !lane.classList.contains('pending') && /^Reviewing #8 by kim$/.test(lane.querySelector('.lane-title > .state')?.textContent ?? '')
        }, [], { what: 'review-8 made, and shown as Reviewing #8 by kim', timeout: 60_000 * SLOW })
        assert.equal(fs.readFileSync(path.join(laneDir('review-8'), 'count.txt'), 'utf8'), 'one, two, three\n')
        await home.pointAt(() => card('review-8').querySelector('.lane-name'))
        const offered = await home.run(() => ({ land: Boolean(laneButton('review-8', 'Land')), push: Boolean(laneButton('review-8', 'Push')), review: laneButton('review-8', 'Review…')?.classList.contains('primary') }))
        assert.deepEqual(offered, { land: false, push: false, review: true }, 'somebody else\'s pull request: reviewed, never landed or pushed from here')
        await home.click(() => laneButton('review-8', 'Review…'))
        await home.until(() => document.activeElement?.matches('li.lane[data-key="demo/review-8"] .confirm.verdict textarea'))
        await home.type('It counts as it says.')
        await home.click(() => laneButton('review-8', 'Approve'))
        let review = null
        for (let i = 0; i < 200 && !review; i++) {
            review = JSON.parse(fs.readFileSync(ghState, 'utf8')).prs.find((pr) => pr.number === 8).latestReviews?.find((one) => one.author.login === 'reviewer') ?? null
            if (!review) await sleep(100)
        }
        assert.deepEqual(review && { state: review.state, body: review.body }, { state: 'APPROVED', body: 'It counts as it says.' }, 'the approval reached GitHub, in its words')
    } finally {
        await home.close()
    }
})

test('where the full suite runs before a land, a lane\'s verification says it as a state of its own, and Land waits on it, saying the full suite failed on this commit, until it passes', { skip, timeout: 120_000 * SLOW }, async () => {
    // Quiet runs every test before each land, failing while a file says so.
    const quiet = path.join(work, 'quiet')
    const fails = path.join(scratch, 'every-test-fails')
    const config = JSON.parse(fs.readFileSync(path.join(quiet, 'lane.config.json'), 'utf8'))
    config.gate.full = { when: 'before-land', steps: [{ what: 'running every test', command: 'sh', args: ['-c', `test ! -e '${fails}'`] }] }
    fs.writeFileSync(path.join(quiet, 'lane.config.json'), JSON.stringify(config))
    // And keeps its runs out of git, as demo does: a run left uncommitted in the main checkout would hold a land too.
    fs.writeFileSync(path.join(quiet, '.gitignore'), '.env\n.lanekit/\n')
    git(quiet, 'add', 'lane.config.json', '.gitignore')
    git(quiet, 'commit', '-qm', 'Run every test before each land')
    execFileSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'new', 'hushed'], { cwd: quiet, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const dir = path.join(work, 'quiet-hushed')
    commit(dir, 'hushed.txt', 'hushed\n', 'Hush it')
    const verify = () => spawnSync(process.execPath, [path.join(KIT, 'dev', 'gate.mjs')], { cwd: dir, env, encoding: 'utf8' })
    fs.writeFileSync(fails, '')
    const failed = verify()
    assert.notEqual(failed.status, 0, 'the tier passed, the full suite did not')

    const tab = await open(browser, `${base}?repo=quiet`)
    try {
        const said = () => {
            const lane = document.querySelector('li.lane[data-key="quiet/hushed"]')
            if (!lane) return null
            const land = [...lane.querySelectorAll('button')].find((button) => (button.getAttribute('aria-label') || button.textContent).trim().startsWith('Land'))
            return {
                facts: [...lane.querySelectorAll(':scope > .facts > .state')].map((one) => `${one.className.replace(/^state |\s?small|\s?opens|\s?discloses/g, '')}: ${one.textContent}`),
                failure: [...lane.querySelectorAll(':scope > .failure .files-head')].map((one) => one.textContent),
                land: land && { disabled: land.disabled, title: land.title },
                strip: [...document.querySelectorAll('#strip > .strip-item')].map((item) => item.textContent)
            }
        }
        const held = await tab.until(`(() => { const now = (${said})(); return now?.facts.some((one) => one.startsWith('risk: Full suite')) ? now : null })`, [], { what: 'hushed, its full suite failed' })
        assert.match(held.facts[0], /^done: Verified · check · /, 'its tier passed')
        assert.match(held.facts[1], /^risk: Full suite failed · /, `the full suite under it, failed: ${JSON.stringify(held.facts)}`)
        assert.deepEqual(held.failure, ['Full suite: running every test failed (exit 1)'])
        assert.deepEqual(held.land, { disabled: true, title: 'The full suite failed on this commit: fix it, commit, and verify it again' })
        assert.ok(held.strip.includes('hushed failed the full suite'), `the strip says so: ${JSON.stringify(held.strip)}`)

        // Passed: Land is there to press.
        fs.rmSync(fails)
        const passed = verify()
        assert.equal(passed.status, 0, passed.stdout + passed.stderr)
        const ready = await tab.until(`(() => { const now = (${said})(); return now?.land && !now.land.disabled ? now : null })`, [], { what: 'hushed, its full suite passed, and Land pressable' })
        assert.match(ready.facts[1], /^done: Full suite passed · /, JSON.stringify(ready.facts))
        assert.deepEqual(ready.failure, [])
        assert.ok(!ready.strip.some((item) => /full suite/.test(item)), JSON.stringify(ready.strip))
    } finally {
        await tab.close()
    }
})

test('nothing on the page is wider than the column, down to the narrowest side bar: Home, a log and its landing table at 170px and up', { skip, timeout: 120_000 * SLOW }, () => nothingWider(browser, base, false))
