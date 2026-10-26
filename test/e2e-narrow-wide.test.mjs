/**
 * The page end to end (test/e2e-harness says how): a lane an agent lands, coming onto main's line; a verification as it
 * runs; a verification, and main's full suite, much slower than usual, and where their time went; and then, with that merge on main and a lane ready to land, nothing on the page wider than the narrowest side
 * bar, drawn as the narrowest machine running these tests draws it.
 *
 *     node --test test/e2e-narrow-wide.test.mjs
 *
 * Needs git, node and Chrome or Chromium (LANEKIT_CHROME names one elsewhere); skipped, and said, without one. Leaves
 * nothing. Each test goes on from where the one before it in this file left the repository, as a person's afternoon
 * would.
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { KIT, SLOW, skip, repo, env, git, lane, commit, laneDir, open, card, RECORD, atRest, begin, end, nothingWider } from './e2e-harness'

let browser, base, page

before(async () => { if (!skip) ({ browser, base, page } = await begin()) })
after(end)

// ---------------------------------------------------------------------------

test('a lane an agent lands slides into main\'s line as it goes, its merge commit comes onto main washed, and main\'s name slides up to it', { skip, timeout: 180_000 * SLOW }, async () => {
    lane('new', 'tiny')
    commit(laneDir('tiny'), 'tiny.txt', 'tiny\n', 'Add a tiny thing')
    execFileSync(process.execPath, [path.join(KIT, 'dev', 'gate.mjs')], { cwd: laneDir('tiny'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    await page.until((() => card('tiny')?.querySelector('.lane-title > .state')?.textContent === 'Ready to land'), [], { what: 'tiny, gated green' })
    await page.run(() => { window.scrollTo(0, 0); return true })
    await page.until(atRest, [], { what: 'the page at rest' })
    await page.run(RECORD)
    lane('land', 'tiny')
    const tip = git(repo, 'rev-parse', 'HEAD')
    await page.until((sha) => !card('tiny') && document.querySelector('li.commit.tip')?.dataset.sha === sha, [tip], { what: 'tiny gone, and main at its merge' })
    assert.equal(await page.run(() => document.querySelector('li.commit.tip .tag.merged')?.textContent), 'tiny', 'main\'s merge is tagged with the lane it brought')
    assert.deepEqual(await page.run(() => ['.landed-word', '.subject', '.brought-more'].map((part) => document.querySelector(`li.commit.tip ${part}`)?.textContent ?? null)),
        ['Landed', 'Add a tiny thing', null], 'and reads Landed, with the one commit it brought; git\'s words in its title')
    assert.match(await page.run(() => document.querySelector('li.commit.tip').title), /^Merge branch 'tiny'/)
    assert.match(git(repo, 'log', '-1', '--format=%b'), /\* tiny:\n {2}Add a tiny thing/, 'git\'s own words for the merge list what it brought')
    const seen = await page.run(() => window.__motion)
    const said = JSON.stringify(seen.map((one) => `${one.id} ${one.key ?? one.text.slice(0, 40)} ${one.transforms.join(' ')}`))
    assert.ok(seen.some((one) => one.id === 'motion-leave' && /Add a tiny thing/.test(one.text) && one.transforms.some((transform) => /translateX\(-/.test(transform))),
        `tiny slides into main's line as it goes: ${said}`)
    assert.ok(seen.some((one) => one.id === 'motion-wash' && one.key === `demo@${tip}`), `the merge commit is washed onto main: ${said}`)
    assert.ok(seen.some((one) => one.id === 'motion-move' && one.key === 'demo:tag:main'), `main's name slides up to it: ${said}`)
    // Chosen, the merge says in the details what it brought, each commit with its hash.
    await page.click((() => document.querySelector('li.commit.tip')))
    const brought = await page.until((() => {
        const list = document.querySelector('.pane-commit .details-brought')
        return list ? [...list.querySelectorAll('p, li')].map((node) => node.textContent) : null
    }), [], { what: 'what the merge brought, in the details' })
    assert.deepEqual(brought, ['Brought 1 commit', `${git(repo, 'rev-parse', '--short', 'tiny')}Add a tiny thing`])
    await page.click((() => document.querySelector('.pane-commit .close')))
    await page.until((() => !document.querySelector('.pane-commit')), [], { what: 'the details closed' })
})

test('a verification shows its three parts as it runs, Rebase, the tests of its tier by its label, Record; and a tier is named by its label', { skip, timeout: 60_000 * SLOW }, async () => {
    // A verification running in feature, as the service says one is, at each of its parts in turn.
    const at = (verify) => {
        current.jobs = current.jobs.filter((job) => job.id !== 'e2e-verify')
        current.jobs.unshift({ id: 'e2e-verify', repo: 'demo', lane: 'feature', verb: 'gate', state: 'running', startedAt: Date.now(), command: 'gate', step: 'running the checks', verify })
        draw(true)
        return [...card('feature').querySelectorAll('.live .verify-step')].map((step) => `${step.className.replace('verify-step ', '')} ${step.textContent}${step.getAttribute('aria-current') ? ' (current)' : ''}`)
    }
    try {
        assert.deepEqual(await page.run(at, { phase: 'rebase' }), ['now ◉Rebase (current)', 'next ○Tests', 'next ○Record'])
        assert.deepEqual(await page.run(at, { phase: 'tests', tier: 1, label: 'check' }), ['done ✓Rebase', 'now ◉Tests: check (current)', 'next ○Record'])
        assert.deepEqual(await page.run(at, { phase: 'record', tier: 1, label: 'check' }), ['done ✓Rebase', 'done ✓Tests: check', 'now ◉Record (current)'])
        assert.equal(await page.run(() => card('feature').querySelector('.verify-step.now').title), 'running the checks', 'the gate\'s own words for what it is doing, in the title of the part under way')
        assert.equal(await page.run(() => card('feature').querySelector('.live .live-step')), null, 'not a line of its output any more')
    } finally {
        await page.run(() => refresh().then(() => true))
    }
    // A verification done, by its tier's label: the tier's number in its title.
    lane('new', 'labelled')
    commit(laneDir('labelled'), 'labelled.txt', 'labelled\n', 'Label it')
    execFileSync(process.execPath, [path.join(KIT, 'dev', 'gate.mjs')], { cwd: laneDir('labelled'), env, stdio: ['ignore', 'pipe', 'pipe'] })
    const said = await page.until((() => {
        const node = card('labelled')?.querySelector('.facts .state.done')
        return node ? { text: node.textContent, title: node.title } : null
    }), [], { what: 'labelled, verified' })
    assert.match(said.text, /^Verified · check/, 'the tier by its label')
    assert.doesNotMatch(said.text, /tier \d/)
    assert.match(said.title, /^Tier 1\n/, 'its number in the title')
})

test('a verification much slower than usual says so on its line, a lane\'s and main\'s full suite\'s alike; its details say the usual run\'s time and day, its steps\' seconds, the tests that grew and the slowest, and keep to the column at 170px', { skip, timeout: 90_000 * SLOW }, async () => {
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'lane.config.json'), 'utf8'))
    config.gate.full = { when: 'after-land', label: 'every test', steps: [{ what: 'running every test', command: 'true', args: [] }] }
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify(config))
    git(repo, 'add', 'lane.config.json')
    git(repo, 'commit', '-qm', 'Run every test after each land')
    // labelled's verification, and main's full suite, each 4.4 times as long as their kind's usual runs, as runs.mjs keeps it.
    const runs = path.join(repo, '.lanekit', 'runs')
    const timed = {
        durationSeconds: 1100, steps: [{ what: 'building', seconds: 90 }, { what: 'running the self-tests', seconds: 1010 }], failures: [],
        tests: { files: 1, total: 3, passed: 3, failed: 0, errored: 0, skipped: 0, failing: [], slowest: [
            { name: 'selftest::backup restores', suite: 'selftests', seconds: 612 }, { name: 'selftest::vault unseals after a restart with every key it had before', file: 'tests/vault.sh', seconds: 41.2 }, { name: 'lint', seconds: 3.1 }] },
        slowdown: {
            seconds: 1100, median: 250, runs: 10, ratio: 4.4, usual: { id: 'usual', seconds: 248, startedAt: '2026-10-11T12:00:00.000Z' },
            tests: [{ name: 'selftest::backup restores', suite: 'selftests', seconds: 612, was: 0.4, since: 'was' }, { name: 'selftest::vault unseals after a restart with every key it had before', file: 'tests/vault.sh', seconds: 41.2, was: 0, since: 'new' }],
            steps: [{ what: 'running the self-tests', seconds: 1010, was: 160 }]
        }
    }
    const put = (kind, extra) => {
        const at = new Date()
        const id = `${at.toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z')}-1-${kind}`
        fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({ id, kind, startedAt: at.toISOString(), result: 'passed', ...timed, ...extra }))
    }
    put('tier1', { tier: 1, branch: 'labelled', sha: git(laneDir('labelled'), 'rev-parse', 'HEAD'), worktree: laneDir('labelled'), narrowed: false, earned: 1 })
    put('full', { why: 'after-land', label: 'every test', branch: 'main', sha: git(repo, 'rev-parse', 'HEAD'), worktree: repo })

    const lineOf = (scope) => {
        const facts = document.querySelector(scope)
        return facts && [...facts.querySelectorAll('.state')].map((one) => `${one.textContent}${one.getAttribute('aria-expanded') ? ` [${one.getAttribute('aria-expanded')}]` : ''}`)
    }
    const laneLine = await page.until(`(() => { const said = (${lineOf})('li.lane[data-key="demo/labelled"] > .facts'); return said?.some((one) => /slower/.test(one)) ? said : null })`, [], { what: 'labelled\'s verification, slower than usual' })
    assert.match(laneLine[0], /^Verified · check · 3 passed · just now \[false\]$/)
    assert.equal(laneLine[1], '4.4× slower than usual [false]', 'beside its words, and opening the same details')
    const mainLine = await page.until(`(() => { const said = (${lineOf})('li.main-full > .facts'); return said?.some((one) => /slower/.test(one)) ? said : null })`, [], { what: 'main\'s full suite, slower than usual' })
    assert.deepEqual(mainLine, ['Full suite passed · every test · 3 passed · just now [false]', '4.4× slower than usual [false]'])

    // Opened from its words: the slow-down against the usual run, the tests that grew, each step, the slowest tests.
    const details = (scope) => {
        const timings = document.querySelector(scope)
        if (!timings) return null
        return [...timings.querySelectorAll('.files-head, p, li')].map((one) => (one.localName === 'li'
            ? `${one.querySelector('.secs').textContent} | ${one.querySelector('.timed-name').textContent}${one.title ? ` (${one.title})` : ''}` : one.textContent))
    }
    const said = [
        'Tests that grew most',
        '0.4s → 612s | selftest::backup restores (selftests)',
        'new → 41s | selftest::vault unseals after a restart with every key it had before (tests/vault.sh)',
        'It does not fail verifying. A busy machine slows it too: if the next run is as slow, it is the project.',
        'Its steps', '90s | building', '160s → 1,010s | running the self-tests',
        'Slowest tests', '612s | selftest::backup restores (selftests)', '41s | selftest::vault unseals after a restart with every key it had before (tests/vault.sh)', '3.1s | lint'
    ]
    await page.click(() => card('labelled').querySelector('.facts .slower'))
    const laneDetails = await page.until(`() => (${details})('li.lane[data-key="demo/labelled"] > .timings.slow')`, [], { what: 'labelled\'s details, opened' })
    assert.deepEqual(laneDetails, ['4.4× slower than usual: 1,100s, against 250s at the median of its last 10 passing runs', 'A usual run took 248s, on 11 Oct', ...said])
    await page.click(() => document.querySelector('li.main-full .discloses'))
    const mainDetails = await page.until(`() => (${details})('li.main-full > .timings.slow')`, [], { what: 'main\'s full suite\'s details, opened' })
    assert.deepEqual(mainDetails.slice(2), said)
    // Its words close them again.
    await page.click(() => card('labelled').querySelector('.facts .discloses'))
    await page.until(() => !card('labelled').querySelector('.timings'), [], { what: 'labelled\'s details closed' })

    // In the narrowest side bar, as this machine draws it and as Linux does, the details open: nothing wider than it.
    for (const wide of [false, true]) {
        const thin = await open(browser, `${base}?repo=demo`, { width: 170, height: 900, wide })
        try {
            await thin.click(() => document.querySelector('li.lane[data-key="demo/labelled"] .facts .slower'))
            await thin.click(() => document.querySelector('li.main-full .discloses'))
            await thin.until(() => document.querySelectorAll('.timings.slow').length === 2, [], { what: 'both details open, at 170px' })
            const out = await thin.run(() => {
                const width = document.documentElement.clientWidth
                const wider = [...document.querySelectorAll('body *')].filter((node) => node.getBoundingClientRect().right > width + 0.5 && node.checkVisibility())
                    .map((node) => `${node.localName}.${String(node.className).trim().split(/\s+/).join('.')} "${node.textContent.trim().slice(0, 30)}"`)
                return { scroll: document.documentElement.scrollWidth, width, wider: wider.slice(0, 6) }
            })
            assert.ok(out.scroll <= out.width && !out.wider.length, `at 170px${wide ? ', drawn wide' : ''}, ${out.scroll}px wide in a column of ${out.width}px: ${out.wider.join(', ')}`)
        } finally {
            await thin.close()
        }
    }
})

test('nothing on the page is wider than the column, down to the narrowest side bar: Home, a log and its landing table at 170px and up, drawn wide', { skip, timeout: 120_000 * SLOW }, () => nothingWider(browser, base, true))
