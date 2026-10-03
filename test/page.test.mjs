/**
 * What the page decides from the state alone, read from web/lanes.js as it is written there and run here: plain data
 * in and out. Why each of a lane's buttons is held, and until what (the owner, 2 Oct: they are drawn either way, held
 * until what they need is there); what a lane whose pull request was merged, or whose copy on origin moved on, asks for
 * next; and what the page no longer draws at all.
 *
 *     node --test
 *
 * Needs node; reads files only.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
/** The source from `const <first> = ` to the end of `const <last> = …`, run, and the functions it defines handed back. */
const fromPage = (first, last, names) => {
    const start = page.indexOf(`const ${first} = `)
    const lastAt = page.indexOf(`const ${last} = `)
    assert.ok(start !== -1 && lastAt !== -1, `the page has ${first} and ${last}`)
    const end = page.indexOf('\n}\n', lastAt) + 2
    return new Function(`${page.slice(start, end)}; return { ${names.join(', ')} }`)()
}
const { mainBlockOf, gateBlockOf, landBlockOf, pullBlockOf } = fromPage('mainBlockOf', 'pullBlockOf', ['mainBlockOf', 'gateBlockOf', 'landBlockOf', 'pullBlockOf'])
const { prStepOf } = fromPage('prStepOf', 'prStepOf', ['prStepOf'])

const repo = (main = {}, extra = {}) => ({
    integrationBranch: 'main',
    main: { onIntegration: true, branch: 'main', dirty: 0, operation: null, upstream: { name: 'origin/main', ahead: 0, behind: 0 }, ...main },
    github: { rules: { push: { allowed: true } } },
    ...extra
})
const lane = (extra = {}) => ({ name: 'feature', kind: 'working', ahead: 1, behind: 0, dirty: 0, operation: null, pull: null, upstream: null, queue: { verdict: 'gate now', collisions: [] }, gate: null, ...extra })

test('Gate is held until there is a commit of the lane\'s own to name, with nothing uncommitted beside it', () => {
    assert.equal(gateBlockOf(lane()), null)
    assert.match(gateBlockOf(lane({ ahead: 0, kind: 'fresh', dirty: 2 })), /^Commit first/)
    assert.match(gateBlockOf(lane({ dirty: 1 })), /^Commit first: a gate result names a commit/)
    assert.match(gateBlockOf(lane({ ahead: 0, kind: 'fresh' })), /Nothing committed yet to gate/)
    assert.match(gateBlockOf(lane({ operation: 'rebase' })), /Finish its rebase first/)
    assert.match(gateBlockOf(lane({ pull: { state: 'MERGED', number: 4 } })), /#4 is merged on GitHub already/)
})

test('Land is held until the lane is gated green on its newest commit, first in its order, with main ready for it', () => {
    assert.equal(landBlockOf(repo(), lane({ queue: { verdict: 'land now' } })), null, 'gated green, nothing in the way')
    assert.match(landBlockOf(repo(), lane()), /^Gate it first: a land needs a green gate on its newest commit/)
    assert.match(landBlockOf(repo(), lane({ gate: { result: 'failed', current: true } })), /Its gate failed on this commit/)
    assert.match(landBlockOf(repo(), lane({ ahead: 0, kind: 'fresh' })), /Nothing committed yet to land/)
    assert.match(landBlockOf(repo(), lane({ dirty: 3, queue: { verdict: 'commit first' } })), /^Commit first: a land takes commits/)
    assert.match(landBlockOf(repo(), lane({ queue: { verdict: 'hold the gate', collisions: [{ lane: 'dark-mode' }] } })), /Wait for dark-mode to land first/)
    assert.match(landBlockOf(repo(), lane({ queue: { verdict: 'rebase first' } })), /Rebase it first: it no longer merges cleanly with main/)
    assert.match(landBlockOf(repo(), lane({ queue: null })), /no word on it yet/)
    const ready = lane({ queue: { verdict: 'land now' } })
    assert.match(landBlockOf(repo({ dirty: 2 }), ready), /The main checkout has 2 uncommitted files: move them to a lane, or discard them, first/)
    assert.match(landBlockOf(repo({ onIntegration: false, branch: 'hotfix' }), ready), /The main checkout is on hotfix, not main/)
    assert.match(landBlockOf(repo({ operation: 'merge' }), ready), /part-way through a merge/)
    assert.match(landBlockOf(repo(), lane({ queue: { verdict: 'land now' }, pull: { state: 'MERGED', number: 9 } })), /#9 is merged on GitHub already/)
})

test('Pull is offered whenever origin has commits main lacks, and held while it cannot fast-forward, saying why', () => {
    assert.match(pullBlockOf(repo()), /Nothing to pull/)
    const behind = { upstream: { name: 'origin/main', ahead: 0, behind: 3 } }
    assert.equal(pullBlockOf(repo(behind)), null)
    assert.match(pullBlockOf(repo({ ...behind, dirty: 1 })), /The main checkout has 1 uncommitted file: move them to a lane, or discard them, first/)
    assert.match(pullBlockOf(repo({ upstream: { name: 'origin/main', ahead: 1, behind: 3 } })), /main and origin\/main have diverged, 1 here and 3 there/)
    assert.match(pullBlockOf(repo({ ...behind, onIntegration: false, branch: 'hotfix' })), /on hotfix, not main/)
    assert.equal(mainBlockOf(repo()), null)
})

test('a pull request merged on GitHub, with work made since, asks for that work to move to a new lane, wherever main lands', () => {
    const merged = (extra) => lane({ pull: { state: 'MERGED', number: 4, head: 'a'.repeat(40) }, sinceMerge: 0, ...extra })
    assert.equal(prStepOf(repo(), merged()).next, 'drop', 'nothing since: squashed there, so drop it')
    const dirty = prStepOf(repo(), merged({ dirty: 2 }))
    assert.equal(dirty.next, 'carry')
    assert.equal(dirty.word, 'Merged on GitHub, with work since')
    assert.match(dirty.detail, /#4 was merged without 2 uncommitted files, which no pull request has: move them to a new lane/)
    const since = prStepOf(repo(), merged({ sinceMerge: 1 }))
    assert.equal(since.next, 'carry')
    assert.match(since.detail, /without 1 commit made since/)
    const both = prStepOf(repo(), merged({ sinceMerge: 2, dirty: 1 }))
    assert.match(both.detail, /2 commits made since and 1 uncommitted file/)
    // Main here behind GitHub's (merged by a merge commit, not brought here yet): pull first, then move it.
    const behind = repo({ upstream: { name: 'origin/main', ahead: 0, behind: 1 } })
    assert.equal(prStepOf(behind, merged({ dirty: 1 })).next, 'pull')
    assert.match(prStepOf(behind, merged({ dirty: 1 })).detail, /pull main, then move it to a new lane/)
    assert.equal(prStepOf(behind, merged()).next, 'pull')
    assert.equal(prStepOf(repo(), merged({ operation: 'rebase', dirty: 1 })), null, 'part-way through a rebase: that first')
})

test('a lane whose copy on origin has commits it lacks pulls them, and is never offered a push over somebody else\'s', () => {
    const up = (ahead, behind, foreign) => lane({ queue: { verdict: 'land now' }, upstream: { name: 'origin/feature', ahead, behind, foreign } })
    const pull = prStepOf(repo(), up(0, 2, 2))
    assert.equal(pull.next, 'update', 'somebody pushed to it, and it has nothing new: a fast-forward')
    assert.equal(pull.word, '2 new on origin/feature')
    const diverged = prStepOf(repo(), up(1, 1, 1))
    assert.equal(diverged.next, null, 'diverged with somebody else\'s commits: a person brings them in')
    assert.equal(diverged.tone, 'risk')
    assert.match(diverged.detail, /1 commit of somebody else's that this lane lacks: bring it in \(git pull --rebase, in the lane\) before pushing/)
    assert.equal(prStepOf(repo(), up(1, 1, 0)), null, 'rebased since pushed, where main lands here: the usual words, and Push… asks')
    const byPr = repo({}, { github: { rules: { push: { allowed: false } } } })
    const open = { state: 'OPEN', number: 5, draft: false, review: 'APPROVED', checks: 'passing', mergeState: 'CLEAN', requested: [] }
    assert.equal(prStepOf(byPr, { ...up(1, 1, 0), pull: open }).next, 'push-force', 'rebased since it was pushed, its old commits all its own')
    assert.equal(prStepOf(byPr, { ...up(0, 1, 1), pull: open }).next, 'update', 'GitHub\'s Update branch: pulled, not pushed over')
    assert.equal(prStepOf(byPr, { ...up(2, 1, 1), pull: open }).next, null)
    assert.equal(prStepOf(repo(), up(0, 2, 2)).next, 'update', 'where main lands here too')
    assert.equal(prStepOf(repo(), { ...up(0, 2, 2), dirty: 1 }), null, 'uncommitted work first: a fast-forward may touch it')
})

test('the page no longer says where you are, nor Goto, nor that a repository has no lanes, nor a count of files changed', () => {
    assert.doesNotMatch(page, /You are here/)
    assert.doesNotMatch(page, /iconButton\('goto'|'Goto'/, 'a lane\'s terminal is an icon, called what it is')
    assert.match(page, /iconButton\('terminal', `Terminal in /)
    assert.doesNotMatch(page, /No lanes yet\. A lane is a folder/)
    assert.doesNotMatch(page, /\$\{plural\(files\.length, 'file'\)\} changed/)
    assert.doesNotMatch(page, /host\.on\('here'/)
})
