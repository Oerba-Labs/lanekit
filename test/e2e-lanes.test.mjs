/**
 * The page end to end (test/e2e-harness says how): lanes as it draws them and their files, the main checkout's work moved
 * into a lane, what origin and GitHub say of the lanes, Pull, and the editor's tab.
 *
 *     node --test test/e2e-lanes.test.mjs
 *
 * Needs git, node and Chrome or Chromium (LANEKIT_CHROME names one elsewhere); skipped, and said, without one. Leaves
 * nothing. Each test goes on from where the one before it in this file left the repository, as a person's afternoon
 * would.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { sleep, SLOW, skip, repo, other, git, write, commit, laneDir, status, open, card, buttonIn, laneButton, begin, end } from './e2e-harness'

let browser, base, page

before(async () => { if (!skip) ({ browser, base, page } = await begin()) })
after(end)

// ---------------------------------------------------------------------------

test('the page says nothing of where you are, nor Goto, nor that a repository has no lanes, nor how many files a lane changed', { skip, timeout: 60_000 * SLOW }, async () => {
    const text = await page.run(() => document.body.innerText)
    assert.doesNotMatch(text, /You are here/)
    assert.doesNotMatch(text, /\bGoto\b/)
    assert.equal(await page.run((() => [...card('feature').querySelectorAll('.facts button')].filter((button) => /files? changed/.test(button.textContent)).length)), 0)
    // Up to date is a dot, its words the title: the bar's edge says nothing while all is well.
    assert.deepEqual(await page.run(() => { const dot = document.getElementById('updated'); return { words: dot.textContent, ok: dot.classList.contains('ok'), title: dot.title } }), { words: '', ok: true, title: 'Up to date' })

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

test('a lane is drawn from its name down, in a colour of its own: its name at the top of its line, its uncommitted files under it, its commits under them', { skip, timeout: 60_000 * SLOW }, async () => {
    const layout = await page.run((() => {
        const lane = card('feature')
        const kids = [...lane.children]
        const at = (selector) => kids.findIndex((kid) => kid.matches(selector))
        const box = (node) => node.getBoundingClientRect()
        const commits = [...lane.querySelectorAll(':scope > .stack > .stack-commit')]
        return {
            order: [at('.lane-head'), at('.changes'), at('.stack')],
            nameAboveFiles: box(lane.querySelector(':scope > .lane-head')).bottom <= box(lane.querySelector(':scope > .changes')).top + 1,
            filesAboveCommits: box(lane.querySelector(':scope > .changes')).bottom <= box(commits[0]).top + 1,
            name: lane.querySelector('.lane-head .lane-name').textContent,
            hue: lane.dataset.hue,
            line: getComputedStyle(lane, '::before').backgroundColor, dot: getComputedStyle(commits[0], '::before').borderColor,
            tag: getComputedStyle(lane.querySelector('.lane-head .lane-name')).color,
            hues: [...document.querySelectorAll('li.lane[data-key]')].map((one) => one.dataset.hue)
        }
    }))
    assert.ok(layout.order[0] < layout.order[1] && layout.order[1] < layout.order[2], JSON.stringify(layout.order))
    assert.ok(layout.nameAboveFiles && layout.filesAboveCommits, JSON.stringify(layout))
    assert.equal(layout.name, 'feature')
    assert.match(layout.hue, /^(cyan|magenta|yellow|green|blue|red)$/)
    assert.ok(layout.line === layout.dot && layout.line === layout.tag, `its line, its dots and its name in one colour: ${JSON.stringify(layout)}`)
    assert.equal(new Set(layout.hues).size, layout.hues.length, `each lane a colour of its own: ${layout.hues.join(', ')}`)
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
