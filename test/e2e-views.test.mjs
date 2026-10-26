/**
 * The page end to end (test/e2e-harness says how): what changes as it happens, the page at the widths of a narrow window,
 * a middling one and a wide one, what waits on you, folding, the agents, the landing order's own view, a tab's title, the
 * keyboard, and main's full suite.
 *
 *     node --test test/e2e-views.test.mjs
 *
 * Needs git, node and Chrome or Chromium (LANEKIT_CHROME names one elsewhere); skipped, and said, without one. Leaves
 * nothing. Each test goes on from where the one before it in this file left the repository, as a person's afternoon
 * would.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { SLOW, skip, scratch, repo, env, git, commit, laneDir, open, card, RECORD, atRest, begin, end } from './e2e-harness'

let browser, base, page

before(async () => { if (!skip) ({ browser, base, page } = await begin()) })
after(end)

// ---------------------------------------------------------------------------

test('what an agent commits comes in as it happens: the file it took fades from where it was, its commit fades in washed, and what is under it slides', { skip, timeout: 120_000 * SLOW }, async () => {
    await page.run((() => { card('feature').scrollIntoView({ block: 'center' }); return true }))
    await page.until(atRest, [], { what: 'the page at rest' })
    await page.run(RECORD)
    // Committed by somebody else, in the lane's own folder: nothing pressed on the page, so nothing drawn before it is done.
    git(laneDir('feature'), 'add', 'feature.txt')
    git(laneDir('feature'), 'commit', '-qm', 'Make the feature better')
    const sha = git(laneDir('feature'), 'rev-parse', 'HEAD')
    await page.until((() => card('feature').querySelector('.stack .subject')?.textContent === 'Make the feature better' &&
        [...card('feature').querySelectorAll(':scope > .changes .change-path')].map((node) => node.textContent).join() === 'notes.txt'),
    [], { what: 'feature with its new commit, and notes.txt left uncommitted' })
    const seen = await page.run(() => window.__motion)
    const said = JSON.stringify(seen.map((one) => `${one.id} ${one.key ?? one.text.slice(0, 40)}`))
    const went = seen.filter((one) => one.id === 'motion-leave' && one.leaving && /feature\.txt/.test(one.text))
    assert.ok(went.length, `feature.txt fades from where it was: ${said}`)
    assert.ok(went.every((one) => one.inert && !one.findable), 'its copy is inert, and nothing in it is found as the file itself')
    assert.ok(seen.some((one) => one.id === 'motion-fade' && one.key === `demo/feature@${sha}`), `its commit fades in: ${said}`)
    assert.ok(seen.some((one) => one.id === 'motion-wash' && one.key === `demo/feature@${sha}`), `washed, so a glance finds it: ${said}`)
    assert.ok(seen.some((one) => one.id === 'motion-move' && one.lane === 'demo/feature' && one.moves), `what is under it slides rather than jumps: ${said}`)
    await page.until(() => !document.querySelector('.leaving'), [], { what: 'the copy of what went, gone once faded' })
    assert.equal(await page.run(() => document.querySelectorAll('li.lane[data-key="demo/feature"]').length), 1)
})

test('where the machine asks for less motion nothing slides and what changes only fades; a lane something runs in is lit along its line', { skip, timeout: 120_000 * SLOW }, async () => {
    const still = await open(browser, `${base}?repo=demo`, { still: true })
    try {
        // feature, the newest of the lanes beside it since the agent's commit: another keeps it where it is, in sight.
        await still.until((() => card('feature')), [], { what: 'feature drawn' })
        await still.run((() => { card('feature').scrollIntoView({ block: 'center' }); return true }))
        await still.until(atRest, [], { what: 'the page at rest' })
        await still.run(RECORD)
        commit(laneDir('feature'), 'more.txt', 'more\n', 'Say a little more')
        const sha = git(laneDir('feature'), 'rev-parse', 'HEAD')
        await still.until((() => card('feature').querySelector('.stack .subject')?.textContent === 'Say a little more'), [], { what: 'feature with its new commit' })
        const seen = await still.run(() => window.__motion)
        assert.ok(seen.some((one) => one.id === 'motion-fade' && one.key === `demo/feature@${sha}`), `its commit fades in: ${JSON.stringify(seen.map((one) => `${one.id} ${one.key}`))}`)
        assert.deepEqual(seen.filter((one) => one.moves).map((one) => `${one.id} ${one.key}`), [], 'nothing slides, scales or pops')

        // A press running in ready, as the service says one is: its line lit and still here, a light running down it
        // where motion is welcome.
        const running = (name) => {
            current.jobs.unshift({ id: 'e2e-running', repo: 'demo', lane: name, verb: 'gate', state: 'running', startedAt: Date.now(), command: 'gate' })
            draw(true)
            return card(name).classList.contains('working') && getComputedStyle(card(name), '::before').animationName
        }
        assert.equal(await still.run(running, 'ready'), 'none')
        assert.equal(await page.run(running, 'ready'), 'flow')
        await page.run(() => refresh().then(() => true))
    } finally {
        await still.close()
    }
})

test('a window narrower than 760px lays the page out as the side bar does: the next step and ⋯ float over a lane\'s corner, no hidden toolbar keeps a line under its name, and a commit\'s details open under its row', { skip, timeout: 120_000 * SLOW }, async () => {
    const narrow = await open(browser, `${base}?repo=demo`, { width: 640, height: 900 })
    try {
        await narrow.until((() => card('feature') && document.documentElement.hasAttribute('data-compact')), [], { what: 'the narrow page, laid out compact' })
        // The name's row is one line: nothing invisible holds a second under it.
        const rows = await narrow.run((() => {
            const lane = card('feature')
            return { title: lane.querySelector('.lane-title').getBoundingClientRect().height, name: lane.querySelector('.lane-name').getBoundingClientRect().height, toolbar: getComputedStyle(lane.querySelector('.hover-actions')).display }
        }))
        assert.ok(rows.title < rows.name * 2, `one line under the name, not two: ${JSON.stringify(rows)}`)
        assert.equal(rows.toolbar, 'none', 'the toolbar is not in the flow')
        // The pointer on it: its next step, as its icon with its word first in its title, and ⋯, in its corner, inside the window.
        await narrow.pointAt((() => card('feature').querySelector('.lane-title')))
        const corner = await narrow.until((() => {
            const corner = card('feature').querySelector('.corner')
            if (!corner || getComputedStyle(corner).visibility !== 'visible') return null
            const buttons = [...corner.querySelectorAll('button')]
            // A word the stylesheet hides is still in textContent: what shows is what is asked.
            const shows = (button) => { const label = button.querySelector('.label'); return Boolean(label && getComputedStyle(label).display !== 'none') }
            return {
                right: corner.getBoundingClientRect().right, width: innerWidth, primary: buttons[0]?.classList.contains('primary'),
                names: buttons.map((button) => button.getAttribute('aria-label')), worded: buttons.map(shows), titles: buttons.map((button) => button.title)
            }
        }), [], { what: 'feature\'s corner under the pointer' })
        assert.ok(corner.right <= corner.width, `inside the window: ${JSON.stringify(corner)}`)
        assert.equal(corner.names.length, 2, `the next step and ⋯: ${JSON.stringify(corner)}`)
        assert.ok(corner.primary && corner.names[0] && corner.worded[0] === false && corner.titles[0].startsWith(`${corner.names[0]}: `),
            `the next step as its icon, its word its name and first in its title: ${JSON.stringify(corner)}`)
        assert.equal(corner.names[1], 'Everything feature can do')
        // A commit chosen: its details right under its row, the pane beside the log left hidden.
        await narrow.click((() => card('feature').querySelector('.stack .subject')))
        const placed = await narrow.until((() => {
            const inline = card('feature').querySelector('.details-inline')
            if (!inline?.querySelector('.change-list')) return null
            const row = card('feature').querySelector('.stack .selected').getBoundingClientRect()
            return { below: inline.getBoundingClientRect().top - row.bottom, pane: document.getElementById('details').hidden }
        }), [], { what: 'the details under the row' })
        // Within a few pixels: CI's Mac lays the box 2px into the row's own padding.
        assert.ok(placed.below > -6 && placed.below < 40, `right under its row: ${JSON.stringify(placed)}`)
        assert.equal(placed.pane, true, 'the pane beside the log stays hidden')
        // Widened past the line, the same page goes back to the toolbar beside the name and the pane beside the log.
        await narrow.resize(1200, 900)
        await narrow.until((() => !document.documentElement.hasAttribute('data-compact') && !document.getElementById('details').hidden && !card('feature').querySelector('.details-inline')), [], { what: 'wide again: the details in the pane' })
        assert.equal(await narrow.run((() => getComputedStyle(card('feature').querySelector('.lane-title > .hover-actions')).position)), 'absolute', 'the toolbar floats beside the name again')
    } finally {
        await narrow.close()
    }
})

test('with the details pane open in a window of middling width, a lane\'s toolbar keeps to the log\'s column: every button but the next step its icon alone, under the name', { skip, timeout: 120_000 * SLOW }, async () => {
    const middling = await open(browser, `${base}?repo=demo`, { editor: true, width: 1000, height: 900 })
    try {
        await middling.until((() => card('feature') && !document.documentElement.hasAttribute('data-compact')), [], { what: 'the editor tab, 1000 wide' })
        await middling.click((() => card('feature').querySelector('.stack .subject')))
        await middling.until((() => !document.getElementById('details').hidden && document.querySelector('.details .change-list')), [], { what: 'the details beside the log' })
        await middling.pointAt((() => card('feature').querySelector('.lane-title')))
        const seen = await middling.until((() => {
            const toolbar = card('feature').querySelector('.lane-title > .hover-actions')
            if (getComputedStyle(toolbar).visibility !== 'visible') return null
            const said = (button) => button.querySelector('.label') && getComputedStyle(button.querySelector('.label')).display !== 'none'
            return {
                right: toolbar.getBoundingClientRect().right, pane: document.getElementById('details').getBoundingClientRect().left,
                count: toolbar.querySelectorAll('.btn').length,
                said: [...toolbar.querySelectorAll('.btn')].filter(said).map((button) => `${button.getAttribute('aria-label')}${button.classList.contains('primary') ? ' (next)' : ''}`)
            }
        }), [], { what: 'feature\'s toolbar under the pointer' })
        assert.ok(seen.right <= seen.pane, `the toolbar ends before the pane begins: ${JSON.stringify(seen)}`)
        assert.ok(seen.count >= 5, `the editor's whole toolbar: ${JSON.stringify(seen)}`)
        assert.deepEqual(seen.said, ['Verify (next)'], `only the next step keeps its word: ${JSON.stringify(seen)}`)
        // The ⋯ menu's items keep their words, whatever the toolbar's own buttons show.
        await middling.click((() => card('feature').querySelector('.hover-actions .more')))
        const menu = await middling.until((() => {
            const items = [...card('feature').querySelectorAll('.more-menu .btn')]
            return items.length ? items.map((item) => ({ name: item.getAttribute('aria-label'), worded: item.querySelector('.label') ? getComputedStyle(item.querySelector('.label')).display !== 'none' : false })) : null
        }), [], { what: 'the ⋯ menu open' })
        assert.ok(menu.every((item) => item.worded), `every item with its word: ${JSON.stringify(menu)}`)
        await middling.run(() => { closeMenus(); draw(true); return true })
    } finally {
        await middling.close()
    }
})

test('a wide window keeps the page to a column of reading width, and the Log and Landing tabs under the bar as the log scrolls past them', { skip, timeout: 60_000 * SLOW }, async () => {
    const wide = await open(browser, `${base}?repo=demo`, { width: 1600, height: 500 })
    try {
        await wide.until((() => card('feature') && document.querySelector('.queue-row .view-tab')), [], { what: 'the page, with its tabs' })
        const column = await wide.run((() => ({ repo: document.querySelector('section.repo').getBoundingClientRect().width, window: innerWidth })))
        assert.ok(column.repo <= 1080 && column.window === 1600, `a column of 1080 at most in a window of 1600: ${JSON.stringify(column)}`)
        await wide.run((() => { window.scrollTo(0, 600); return true }))
        const stuck = await wide.until((() => {
            const row = document.querySelector('.queue-row')
            if (!row.classList.contains('stuck')) return null
            return { top: row.getBoundingClientRect().top, bar: document.querySelector('header.bar').getBoundingClientRect().bottom, scrolled: scrollY, tabs: row.querySelectorAll('.view-tab').length, counts: row.querySelectorAll('.view-count').length }
        }), [], { what: 'the tabs stuck under the bar' })
        assert.ok(Math.abs(stuck.top - stuck.bar) < 2 && stuck.scrolled > 0 && stuck.tabs === 2 && stuck.counts > 0, `under the bar, the Landing tab with its counts: ${JSON.stringify(stuck)}`)
    } finally {
        await wide.close()
    }
})

test('what waits on you is one line under the switcher: a lane ready to land, a pull request waiting on your review, each opening what it names', { skip, timeout: 60_000 * SLOW }, async () => {
    const said = await page.until((() => {
        const strip = [...document.querySelectorAll('#strip .strip-item')].map((item) => ({ text: item.textContent.trim(), link: item.tagName === 'A' ? item.href : null }))
        if (!strip.length) return null
        return {
            strip, hidden: document.getElementById('strip').hidden,
            ready: [...document.querySelectorAll('li.lane[data-key]')].filter((lane) => lane.querySelector('.lane-title > .state')?.textContent === 'Ready to land').map((lane) => lane.dataset.key.split('/')[1]),
            needs: [...document.querySelectorAll('li.lane[data-key]')].filter((lane) => lane.querySelector('.wants-badge')?.textContent).map((lane) => lane.dataset.key.split('/')[1])
        }
    }), [], { what: 'the strip, with something in it' })
    assert.equal(said.hidden, false)
    for (const name of said.ready) assert.ok(said.strip.some((item) => item.text === `${name} ready to land`), `${name} is ready, and the strip says so: ${JSON.stringify(said.strip)}`)
    for (const name of said.needs) assert.ok(said.strip.some((item) => item.text.endsWith(` in ${name}`)), `an agent waits in ${name}, and the strip says so`)
    const review = said.strip.find((item) => /^#8 waits on your review$/.test(item.text))
    assert.ok(review, `#8 waits on this person's review, as the header says: ${JSON.stringify(said.strip)}`)
    assert.match(review.link, /github\.com\/acme\/demo\/pull\/8/, 'a link to it on GitHub')
    // A lane named in it, pressed: the lane is brought into view and marked.
    if (said.ready.length) {
        await page.click((() => [...document.querySelectorAll('#strip button')].find((item) => / ready to land$/.test(item.textContent))))
        await page.until((name) => card(name)?.classList.contains('flash'), [said.ready[0]], { what: `${said.ready[0]} marked` })
    }
})

test('a lane folds to its name from the mark on its line, or z, and unfolds the same way, remembered by the page', { skip, timeout: 60_000 * SLOW }, async () => {
    const shown = () => ({ folded: card('feature').classList.contains('folded'), stack: getComputedStyle(card('feature').querySelector(':scope > .stack')).display, name: Boolean(card('feature').querySelector('.lane-name')), mark: card('feature').querySelector('.fold').getAttribute('aria-expanded') })
    assert.deepEqual(await page.run(shown), { folded: false, stack: 'block', name: true, mark: 'true' })
    await page.click((() => card('feature').querySelector('.fold')))
    await page.until(`() => { const s = (${shown})(); return s.folded && s.stack === 'none' }`, [], { what: 'feature folded' })
    assert.deepEqual(await page.run(shown), { folded: true, stack: 'none', name: true, mark: 'false' })
    // Drawn again, it stays folded; z unfolds it.
    await page.run(() => refresh().then(() => true))
    assert.equal(await page.run(() => card('feature').classList.contains('folded')), true)
    await page.run(() => { card('feature').focus(); card('feature').dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true, cancelable: true })); return true })
    await page.until((() => !card('feature').classList.contains('folded')), [], { what: 'feature unfolded' })
    assert.equal(await page.run(() => getComputedStyle(card('feature').querySelector(':scope > .stack')).display), 'block')
})

test('a commit is a ring, and a lane something is at work in fills its newest commit; the uncommitted node is a dashed ring', { skip, timeout: 60_000 * SLOW }, async () => {
    const dots = () => {
        const style = (node, pseudo = '::before') => getComputedStyle(node, pseudo)
        const lane = card('feature')
        const dirty = document.querySelector('li.lane > .changes')
        return {
            mainTip: style(document.querySelector('li.commit.tip')).borderStyle, mainFill: style(document.querySelector('li.commit.tip')).backgroundColor,
            commit: style(lane.querySelector('.stack-commit')).backgroundColor, ring: style(lane.querySelector('.stack-commit')).borderColor,
            files: dirty ? style(dirty).borderStyle : 'dashed',
            page: getComputedStyle(document.body).backgroundColor
        }
    }
    const rest = await page.run(dots)
    assert.equal(rest.mainTip, 'solid')
    assert.equal(rest.mainFill, rest.page, 'main\'s commit is a ring')
    assert.equal(rest.commit, rest.page, 'a settled commit of a lane is a ring')
    assert.equal(rest.files, 'dashed', 'the uncommitted node is dashed')
    // Something at work in it, as the service says one is: its newest commit fills in the lane's colour.
    await page.run(() => { current.jobs.unshift({ id: 'e2e-at-work', repo: 'demo', lane: 'feature', verb: 'gate', state: 'running', startedAt: Date.now(), command: 'gate' }); draw(true); return true })
    const busy = await page.run(dots)
    assert.equal(busy.commit, busy.ring, `its newest commit fills in its own colour: ${JSON.stringify(busy)}`)
    await page.run(() => refresh().then(() => true))
})

test('a repository\'s agents are one button at its head, saying how many and how many need you, which opens each with where it works and its session', { skip, timeout: 60_000 * SLOW }, async () => {
    // Three agents as their hooks would say it: two in the main checkout, told apart only by their sessions, and one in a lane.
    const reports = path.join(env.XDG_STATE_HOME, 'lanekit', 'agents')
    fs.mkdirSync(reports, { recursive: true })
    const report = (session, cwd, state, tool, minutes) => fs.writeFileSync(path.join(reports, `claude-${session}.json`), JSON.stringify({
        key: `claude-${session}`, agent: 'claude', host: os.hostname(), session, cwd, state, tool, at: Date.now(), since: Date.now() - minutes * 60_000, pid: process.pid, pids: [process.pid]
    }))
    report('aaaa1111bbbb', repo, 'running', 'Bash', 3)
    report('cccc2222dddd', repo, 'ready', null, 40)
    report('eeee3333ffff', laneDir('feature'), 'needs-you', 'Edit', 1)
    try {
        const button = await page.until((() => {
            const toggle = document.querySelector('.repo-head .agents-toggle')
            return toggle && /3 agents/.test(toggle.textContent) ? { text: toggle.textContent.replace(/\s+/g, ' ').trim(), expanded: toggle.getAttribute('aria-expanded') } : null
        }), [], { what: 'the agents button, with three' })
        assert.match(button.text, /3 agents.*1 needs you/, 'how many, and how many need you')
        assert.equal(button.expanded, 'false')
        assert.equal(await page.run(() => document.querySelectorAll('section.repo [data-agents="demo/"] .agent-chip').length), 0, 'no row of chips for the main checkout under the head')
        await page.click((() => document.querySelector('.agents-toggle')))
        const panel = await page.until((() => {
            const menu = document.querySelector('.agents-panel')
            if (!menu) return null
            return {
                groups: [...menu.querySelectorAll('.agents-group')].map((group) => group.textContent),
                rows: [...menu.querySelectorAll('.agent-row')].map((row) => ({ where: row.querySelector('.agent-where').textContent, session: row.querySelector('.agent-session').textContent, state: row.querySelector('.state').textContent }))
            }
        }), [], { what: 'the agents menu, open' })
        assert.deepEqual(panel.groups, ['Needs you · 1', 'At work · 1', 'Idle · 1'], 'those that need you first, then at work, then idle')
        assert.deepEqual(panel.rows, [
            { where: 'feature', session: 'eeee3333', state: 'Needs you · Edit' },
            { where: 'main checkout', session: 'aaaa1111', state: 'Running · Bash' },
            { where: 'main checkout', session: 'cccc2222', state: 'Ready' }
        ], 'each with where it works, and the session that tells two in the main checkout apart')
        // A lane's agent, pressed: the menu closes and the lane is brought into view and marked.
        await page.click((() => [...document.querySelectorAll('.agent-row')].find((row) => row.querySelector('.agent-where').textContent === 'feature')))
        await page.until((() => !document.querySelector('.agents-panel') && card('feature')?.classList.contains('flash')), [], { what: 'the menu closed, and feature marked' })
        // Escape closes it, as it does a lane's ⋯.
        await page.click((() => document.querySelector('.agents-toggle')))
        await page.until((() => document.querySelector('.agents-panel')), [], { what: 'the agents menu, open again' })
        await page.run(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return true })
        await page.until((() => !document.querySelector('.agents-panel')), [], { what: 'the agents menu closed by Escape' })
    } finally {
        fs.rmSync(reports, { recursive: true, force: true })
    }
    await page.until((() => !document.querySelector('.agents-toggle')), [], { what: 'no agents button with no agents' })
})

test('the landing order has a view of its own: a table of every lane in its groups, with what each needs, its verification, changes, collisions, pull request and next step', { skip, timeout: 60_000 * SLOW }, async () => {
    const tabs = await page.until((() => {
        const views = [...document.querySelectorAll('.views .view-tab')]
        return views.length ? views.map((tab) => ({ text: tab.textContent, selected: tab.getAttribute('aria-selected') })) : null
    }), [], { what: 'the Log and Landing tabs' })
    assert.equal(tabs.length, 2)
    assert.deepEqual(tabs.map((tab) => tab.selected), ['true', 'false'], 'the log first')
    assert.match(tabs[1].text, /^Landing(\d+)+$/)
    // No line of the landing order over the log: the Landing tab counts each group in its colour instead.
    const over = await page.run(() => ({
        line: document.querySelectorAll('.queue-row .queue-item, .queue-row .queue-title').length,
        landNext: [...document.querySelectorAll('.views-row > button')].map((button) => button.getAttribute('aria-label')),
        counts: [...document.querySelectorAll('.view-tab .view-count')].map((count) => ({ verdict: count.dataset.verdict, n: Number(count.textContent), dot: count.querySelector('.queue-dot').className })),
        groups: landingGroupsOf(current.repos.find((repo) => repo.id === 'demo').lanes).map((group) => ({ verdict: group.verdict, names: group.lanes.map((item) => item.name) }))
    }))
    assert.equal(over.line, 0, 'no line of the landing order over the log')
    assert.deepEqual(over.counts.map((count) => [count.verdict, count.n]), over.groups.map((group) => [group.verdict, group.names.length]), `a count for each group, in its order: ${JSON.stringify(over)}`)
    assert.ok(over.counts.every((count) => /queue-dot (done|info|warn|risk|quiet)/.test(count.dot)), 'each in its group\'s colour')
    const ready = over.groups.find((group) => group.verdict === 'land now')
    assert.deepEqual(over.landNext, ready ? [`Land ${ready.names[0]}…`] : [], 'Land next at the end of the tabs, where a lane is ready')
    const inOrder = over.groups.flatMap((group) => group.names)
    await page.click((() => [...document.querySelectorAll('.view-tab')].find((tab) => tab.textContent.startsWith('Landing'))))
    const table = await page.until((() => {
        const landing = document.querySelector('.landing:not([hidden]) .landing-table')
        if (!landing) return null
        return {
            heads: [...landing.querySelectorAll('thead th')].map((th) => th.textContent),
            groups: [...landing.querySelectorAll('.landing-group-head th')].map((th) => th.textContent),
            lanes: [...landing.querySelectorAll('tr.landing-lane')].map((row) => ({
                name: row.querySelector('.lane-name').textContent,
                needs: row.querySelector('td[data-label="Needs"] .state').textContent,
                step: row.querySelector('.landing-step').textContent.trim(),
                hue: row.querySelector('.lane-name').dataset.hue,
                cardHue: card(row.querySelector('.lane-name').textContent)?.dataset.hue
            })),
            log: getComputedStyle(document.querySelector('ol.log')).display
        }
    }), [], { what: 'the landing view' })
    assert.deepEqual(table.heads, ['Lane', 'Needs', 'Verified', 'Changes', 'Collides with', 'Pull request', 'Agents', ''])
    assert.ok(table.groups.length > 0, 'its groups, each a heading')
    for (const name of inOrder) assert.ok(table.lanes.some((lane) => lane.name === name), `${name}, in the landing order, has a row: ${JSON.stringify(table.lanes)}`)
    assert.deepEqual(table.lanes.slice(0, inOrder.length).map((lane) => lane.name), inOrder, 'in the landing order\'s groups and order')
    assert.ok(table.lanes.every((lane) => lane.needs && lane.step), `each with what it needs and a next step: ${JSON.stringify(table.lanes)}`)
    assert.ok(table.lanes.every((lane) => lane.hue && lane.hue === lane.cardHue), `each named in its lane's colour: ${JSON.stringify(table.lanes)}`)
    assert.equal(table.log, 'none', 'the log out of sight, kept')
    // Remembered by the page: drawn again, it stays.
    await page.run(() => refresh().then(() => true))
    assert.equal(await page.run(() => Boolean(document.querySelector('.landing:not([hidden]) .landing-table'))), true)
    // A lane's name, pressed: the log is shown, and the lane brought into view and marked.
    const name = table.lanes[0].name
    await page.click(((name) => [...document.querySelectorAll('tr.landing-lane .lane-name')].find((node) => node.textContent === name)), name)
    await page.until(((name) => document.querySelector('.landing').hidden && getComputedStyle(document.querySelector('ol.log')).display !== 'none' && card(name)?.classList.contains('flash')), [name], { what: `the log, with ${name} marked` })
    assert.deepEqual(await page.run(() => [...document.querySelectorAll('.view-tab')].map((tab) => tab.getAttribute('aria-selected'))), ['true', 'false'])
})

test('from one view to the other, the view shown fades in whole: nothing in the log slides in from the page\'s corner, and nothing of the landing table fades over it', { skip, timeout: 60_000 * SLOW }, async () => {
    const tab = (label) => [...document.querySelectorAll('.view-tab')].find((node) => node.textContent.startsWith(label))
    const across = async (label, shown) => {
        await page.until(atRest, [], { what: 'the page at rest' })
        await page.run(RECORD)
        await page.click(tab, label)
        await page.until(((shown) => !document.querySelector(shown).hidden), [shown], { what: `${shown} shown` })
        await page.until(atRest, [], { what: 'the page at rest again' })
        return page.run(() => window.__motion.map((one) => ({ id: one.id, key: one.key, leaving: one.leaving, moves: one.moves, part: one.part })))
    }
    const counts = () => [...document.querySelectorAll('.view-count')].map((node) => Math.round(node.getBoundingClientRect().left))
    const before = await page.run(counts)
    const toLanding = await across('Landing', '.landing')
    assert.deepEqual(await page.run(counts), before, 'the Landing tab\'s counts stay where they were as it is chosen')
    const toLog = await across('Log', 'ol.log')
    for (const [seen, to] of [[toLanding, 'the landing table'], [toLog, 'the log']]) {
        const said = JSON.stringify(seen)
        assert.ok(!seen.some((one) => one.moves), `nothing slides on the way to ${to}: ${said}`)
        assert.ok(!seen.some((one) => one.leaving), `nothing of the other view fades over ${to}: ${said}`)
        assert.deepEqual(seen.filter((one) => one.id === 'motion-fade').map((one) => one.part), to === 'the log' ? ['log', 'settled'] : ['landing'], `${to} fades in whole, and only it: ${said}`)
    }
})

test('a tab\'s title counts what waits on you, as the strip lists it; the bar says where LaneKit looks, its version only in the title; Home counts no lanes', { skip, timeout: 60_000 * SLOW }, async () => {
    const said = await page.until((() => {
        const strip = document.querySelectorAll('#strip:not([hidden]) .strip-item').length
        return strip ? { strip, title: document.title } : null
    }), [], { what: 'something waiting on you in the strip' })
    assert.equal(said.title, `(${said.strip}) Demo · LaneKit`, 'the count before the repository\'s name')
    const bar = await page.run(() => ({ text: document.querySelector('#where').textContent, title: document.querySelector('#where').title, kit: current.kit }))
    assert.doesNotMatch(bar.text, / · lanekit /, `no version in the bar: ${bar.text}`)
    if (bar.kit) assert.match(bar.title, new RegExp(`\\nlanekit ${bar.kit}$`), 'it is in the title')
    const home = await page.run(() => {
        const tab = document.querySelector('#switcher [data-key="switcher:"]')
        return { n: tab.querySelector('.n'), label: tab.getAttribute('aria-label'), repos: [...document.querySelectorAll('#switcher [data-key^="switcher:"]:not([data-key="switcher:"]) .n')].length }
    })
    assert.equal(home.n, null, 'Home counts no lanes')
    assert.equal(home.label, 'Home')
    assert.ok(home.repos > 0, 'each repository\'s tab keeps its count')
    // At Home, every repository's, summed.
    await page.run(() => { showRepo(null); return true })
    const atHome = await page.until((() => (/LaneKit$/.test(document.title) && !/·/.test(document.title) ? document.title : null)), [], { what: 'Home\'s title' })
    const total = await page.run(() => current.repos.reduce((sum, repo) => sum + waitingIn(repo).length, 0))
    assert.equal(atHome, total ? `(${total}) LaneKit` : 'LaneKit')
    await page.run(() => { showRepo('demo'); return true })
    await page.until((() => /Demo · LaneKit$/.test(document.title)), [], { what: 'back on demo' })
})

test('each list is one stop for Tab, j and k move row to row in it, lanes and commits alike, and the focus stays where it is as the page is drawn again', { skip, timeout: 60_000 * SLOW }, async () => {
    await page.run(() => { window.scrollTo(0, 0); return true })
    await page.until(atRest, [], { what: 'the page at rest' })
    // What has the focus: the row (data-row) it is, or is in, and its own words.
    const where = () => {
        const active = document.activeElement
        const row = active?.closest?.('[data-row]')
        return { row: row?.dataset.row ?? null, own: active === row, list: active?.closest?.('[data-rows]')?.dataset.rows ?? null, words: (active?.getAttribute('aria-label') || active?.textContent || '').trim().slice(0, 40), tag: active?.localName }
    }
    // Into the log from Log and Landing (past Land next, where a lane is ready), then Tab until out of it: one row, and
    // that row's own buttons, on the way.
    await page.run(() => { document.querySelector('.view-tab[aria-selected="true"]').focus(); return true })
    const stops = []
    for (let i = 0; i < 40; i++) {
        await page.key('Tab')
        const at = await page.run(where)
        if (!stops.length && at.list !== 'log:demo' && /^Land /.test(at.words)) continue
        if (stops.length && at.list !== 'log:demo') break
        stops.push(at)
    }
    const said = JSON.stringify(stops)
    assert.equal(stops[0].list, 'log:demo', `Tab from Log and Landing comes into the log: ${said}`)
    assert.ok(stops[0].own, 'at a row')
    assert.ok(stops.every((stop) => stop.row === stops[0].row), `and only that row and its buttons are stops: ${said}`)
    // j and k, row to row: lanes and main's commits alike, in the order drawn.
    await page.key('Tab', { shift: true })
    while ((await page.run(where)).own === false) await page.key('Tab', { shift: true })
    const order = await page.run(() => [...document.querySelector('ol.log[data-rows="log:demo"]').querySelectorAll('[data-row]')].filter((row) => row.getClientRects().length).map((row) => row.dataset.row))
    const first = (await page.run(where)).row
    const walked = [first]
    for (let i = 0; i < 6; i++) { await page.key('j'); walked.push((await page.run(where)).row) }
    const from = order.indexOf(first)
    assert.deepEqual(walked, order.slice(from, from + 7), `j steps through the log's rows in order: ${JSON.stringify(walked)} of ${JSON.stringify(order)}`)
    await page.key('k')
    assert.equal((await page.run(where)).row, walked[5], 'k, the row before')
    // On down, past the lanes, to main's commits.
    let reached = null
    for (let i = 0; i < order.length && !reached; i++) { await page.key('j'); const row = (await page.run(where)).row; if (/^demo@/.test(row)) reached = row }
    assert.equal(reached, order.slice(from + 6).find((row) => /^demo@/.test(row)), 'j goes on from the lanes to main\'s commits')
    // Tab out and back in: the log comes back at the row last in focus.
    const last = reached
    await page.run(() => { document.querySelector('.view-tab[aria-selected="true"]').focus(); return true })
    await page.key('Tab')
    if (/^Land /.test((await page.run(where)).words)) await page.key('Tab')
    assert.equal((await page.run(where)).row, last, 'Tab comes back to the row last in focus')
    // A commit's button in focus, and the page drawn again: the same button keeps the focus.
    const commit = order.find((row) => /^demo@/.test(row))
    await page.run(((commit) => { document.querySelector(`[data-row="${commit}"]`).focus(); return true }), commit)
    await page.key('Tab')
    const before = await page.run(where)
    assert.equal(before.row, commit)
    assert.equal(before.own, false, `a button of the commit: ${JSON.stringify(before)}`)
    await page.run(() => { draw(true); return true })
    assert.deepEqual(await page.run(where), before, 'drawn again, the focus is where it was')
    // The switcher's tabs: one stop, ← and → between them, ↓ into the log.
    const tabs = await page.run(() => [...document.querySelectorAll('#switcher [data-row]')].map((tab) => ({ row: tab.dataset.row, tabindex: tab.tabIndex })))
    assert.equal(tabs.filter((tab) => tab.tabindex === 0).length, 1, `one of the switcher's tabs is a stop: ${JSON.stringify(tabs)}`)
    await page.run(() => { document.querySelector('#switcher [data-row][tabindex="0"]').focus(); return true })
    const on = (await page.run(where)).row
    await page.key('ArrowLeft')
    const left = (await page.run(where)).row
    assert.notEqual(left, on, '← moves to the tab before')
    assert.equal(left, tabs[tabs.findIndex((tab) => tab.row === on) - 1].row)
    await page.key('ArrowDown')
    assert.equal((await page.run(where)).list, 'log:demo', '↓ from the switcher, into the log')
})

test('in a narrow column, the switcher is one button opening every repository as a menu once its tabs would not fit, and tabs again once they do', { skip, timeout: 60_000 * SLOW }, async () => {
    // Too narrow for Home, Demo and Quiet side by side.
    const thin = await open(browser, `${base}?repo=demo`, { width: 170, height: 800 })
    try {
        const switcher = () => ({
            toggle: document.querySelector('#switcher .switcher-toggle')?.textContent ?? null,
            expanded: document.querySelector('#switcher .switcher-toggle')?.getAttribute('aria-expanded') ?? null,
            tabs: [...document.querySelectorAll('#switcher > a')].length,
            items: [...document.querySelectorAll('#switcher .switcher-menu [role="menuitem"]')].map((item) => ({ name: item.querySelector('span').textContent, current: item.getAttribute('aria-current') })),
            focus: document.activeElement?.closest?.('#switcher') ? (document.activeElement.querySelector('span')?.textContent ?? document.activeElement.textContent) : null
        })
        const shut = await thin.until(() => { const said = (() => ({ toggle: document.querySelector('#switcher .switcher-toggle')?.textContent ?? null, tabs: document.querySelectorAll('#switcher > a').length }))(); return said.toggle ? said : null }, [], { what: 'the switcher as one button' })
        assert.match(shut.toggle, /^Demo\d+ lanes?▾$/, `the repository shown, its lanes, and a caret: ${shut.toggle}`)
        assert.equal(shut.tabs, 0, 'no row of tabs')
        await thin.click(() => document.querySelector('#switcher .switcher-toggle'))
        const opened = await thin.until(`(() => { const said = (${switcher})(); return said.items.length ? said : null })`, [], { what: 'the menu open' })
        assert.equal(opened.expanded, 'true')
        assert.deepEqual(opened.items, [{ name: 'Home', current: null }, { name: 'Demo', current: 'page' }, { name: 'Quiet', current: null }], 'Home first, then every repository, the one shown marked')
        assert.equal(opened.focus, 'Demo', 'the keyboard on the repository shown')
        await thin.key('ArrowDown')
        assert.equal((await thin.run(switcher)).focus, 'Quiet', '↓ goes down the menu')
        await thin.key('Enter')
        const moved = await thin.until(() => { const toggle = document.querySelector('#switcher .switcher-toggle'); return toggle && /^Quiet/.test(toggle.textContent) && !document.querySelector('.switcher-menu') ? true : null }, [], { what: 'Quiet shown, and the menu shut' })
        assert.ok(moved)
        // Escape shuts it, and the keyboard is back on its button.
        await thin.click(() => document.querySelector('#switcher .switcher-toggle'))
        await thin.until(() => document.querySelector('.switcher-menu'), [], { what: 'the menu open again' })
        await thin.key('Escape')
        await thin.until(() => !document.querySelector('.switcher-menu') && document.activeElement?.matches('.switcher-toggle'), [], { what: 'the menu shut by Escape, its button in focus' })
        // Wide enough, the tabs again.
        await thin.resize(1000, 800)
        await thin.until(() => document.querySelectorAll('#switcher > a').length === 3 && !document.querySelector('.switcher-toggle'), [], { what: 'the tabs again, wide' })
    } finally {
        await thin.close()
    }
})

test('main\'s full suite, where it runs nightly, is said on main\'s row: none yet; a failure first in the strip and on Home\'s card, its tests and its step\'s last lines opened from the strip; then passed, and the strip clear', { skip, timeout: 60_000 * SLOW }, async () => {
    // Where this machine's nightly job would be, here a folder with none in it, on a Mac or not.
    Object.assign(process.env, { LANEKIT_LAUNCH_AGENTS: path.join(scratch, 'launch-agents'), LANEKIT_PLATFORM: 'darwin' })
    const config = JSON.parse(fs.readFileSync(path.join(repo, 'lane.config.json'), 'utf8'))
    config.gate.full = { when: 'nightly', at: '02:00', label: 'every test', steps: [{ what: 'running every test', command: 'true', args: [] }] }
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify(config))
    git(repo, 'add', 'lane.config.json')
    git(repo, 'commit', '-qm', 'Run every test nightly')
    const row = () => {
        const node = document.querySelector('li.main-full')
        return node && { words: [...node.querySelectorAll(':scope > .facts > *')].map((one) => `${one.className.replace(/^state |\s?small|\s?opens|\s?discloses/g, '')}: ${one.textContent}`), open: node.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? null }
    }
    const none = await page.until(`(() => { const said = (${row})(); return said?.words.length ? said : null })`, [], { what: 'main\'s full suite on its row' })
    assert.deepEqual(none.words, ['quiet: No full suite run on main yet', 'warn: No nightly job on this machine'])
    assert.equal(await page.run(() => document.querySelector('li.commit.tip').nextElementSibling?.className), 'main-full', 'under main\'s newest commit')

    // A run of it that failed, on the commit before main's newest, nine hours ago.
    const runs = path.join(repo, '.lanekit', 'runs')
    fs.mkdirSync(runs, { recursive: true })
    const full = (ago, extra) => {
        const at = new Date(Date.now() - ago)
        const id = `${at.toISOString().replace(/[:.]/g, '-').replace(/-\d+Z$/, 'Z')}-1-full`
        fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({
            id, kind: 'full', why: 'nightly', label: 'every test', branch: 'main', worktree: repo, startedAt: at.toISOString(), durationSeconds: 40,
            steps: [{ what: 'running every test', seconds: 40 }], ...extra
        }))
    }
    full(9 * 3600_000, {
        sha: git(repo, 'rev-parse', 'HEAD~1'), result: 'failed',
        failures: [{ what: 'running every test', status: 1, tail: 'ok 1 - counts\nnot ok 2 - backup restores\n  expected 3 snapshots, found 2' }],
        tests: { files: 1, total: 2, passed: 1, failed: 1, errored: 0, skipped: 0, failing: [{ name: 'backup restores', outcome: 'failed' }] }
    })
    const strip = () => [...document.querySelectorAll('#strip > .strip-item')].map((item) => item.textContent)
    const failed = await page.until(`(() => { const said = (${row})(); return said?.words[0]?.startsWith('risk') ? { ...said, strip: (${strip})() } : null })`, [], { what: 'main\'s full suite failed, on its row' })
    assert.deepEqual(failed.words.slice(0, 3), ['risk: Full suite failed · every test · 1 passed, 1 failed · 9 h ago', `wraps: on ${git(repo, 'rev-parse', '--short=7', 'HEAD~1')}, 1 commit before main's newest`, 'warn: No nightly job on this machine'])
    assert.equal(failed.strip[0], 'Full suite failed on main', `first in the strip: ${JSON.stringify(failed.strip)}`)
    assert.equal(failed.open, 'false', 'why, not yet open')
    // The strip's item opens main's row, and why it failed.
    await page.click(() => [...document.querySelectorAll('#strip > .strip-item')].find((item) => item.textContent === 'Full suite failed on main'))
    const why = await page.until(() => {
        const failure = document.querySelector('li.main-full .failure')
        return failure && { heads: [...failure.querySelectorAll('.files-head')].map((one) => one.textContent), failing: [...failure.querySelectorAll('.failing li')].map((one) => one.textContent), tail: failure.querySelector('.tail')?.textContent }
    }, [], { what: 'why main\'s full suite failed, opened under its row' })
    assert.deepEqual(why.heads, ['1 test did not pass', 'Full suite: running every test failed (exit 1)'])
    assert.deepEqual(why.failing, ['backup restores'])
    assert.match(why.tail, /not ok 2 - backup restores\n {2}expected 3 snapshots, found 2/)
    assert.equal((await page.run(row)).open, 'true')
    // Home's card says it too, for a repository not shown.
    await page.run(() => { location.search = ''; return true })
    assert.ok(await page.until(() => [...document.querySelectorAll('.home-card[data-home="demo"] .state.risk')].some((one) => one.textContent === 'Full suite failed'), [], { what: 'Home\'s card for demo saying its full suite failed' }))

    // A newer run passed, on main's newest commit: said quietly, and nothing waits on you for it.
    full(3600_000, { sha: git(repo, 'rev-parse', 'HEAD'), result: 'passed', failures: [], tests: { files: 1, total: 2, passed: 2, failed: 0, errored: 0, skipped: 0, failing: [] } })
    await page.run(() => { location.search = '?repo=demo'; return true })
    const passed = await page.until(`(() => { const said = (${row})(); return said?.words[0]?.startsWith('done') ? { ...said, strip: (${strip})() } : null })`, [], { what: 'main\'s full suite passed, on its row' })
    assert.deepEqual(passed.words, ['done: Full suite passed · every test · 2 passed · 1 h ago', 'warn: No nightly job on this machine'], 'on main\'s newest, so no commit named')
    assert.ok(!passed.strip.some((item) => /Full suite/.test(item)), `the strip clear of it: ${JSON.stringify(passed.strip)}`)
})
