/**
 * The page end to end (test/e2e-harness says how): a lane an agent lands, coming onto main's line; a verification as it
 * runs; and then, with that merge on main and a lane ready to land, nothing on the page wider than the narrowest side
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
import path from 'node:path'
import { after, before, test } from 'node:test'
import { KIT, SLOW, skip, repo, env, git, lane, commit, laneDir, card, RECORD, atRest, begin, end, nothingWider } from './e2e-harness'

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

test('nothing on the page is wider than the column, down to the narrowest side bar: Home, a log and its landing table at 170px and up, drawn wide', { skip, timeout: 120_000 * SLOW }, () => nothingWider(browser, base, true))
