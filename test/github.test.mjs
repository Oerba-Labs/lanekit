/**
 * Pull requests and their reviews, through gh: what lanekit reads of them (who was asked, who approved, the threads
 * left open, what main's rules need), and what `lane pr` asks of gh. Against a stand-in for gh (test/fake-gh) that
 * answers from a file and reaches no network: the repository's remote is named as GitHub would name it, and git is
 * sent to a bare repository on this machine instead, by insteadOf.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-github-')))
const bin = path.join(scratch, 'bin')
const ghState = path.join(scratch, 'gh-state.json')
const ghLog = path.join(scratch, 'gh-log.jsonl')
// The stand-in comes first on the PATH, in this process too, BEFORE lanekit's modules load: the one that asks gh reads
// the PATH as it loads, and a real gh signed in here would ask GitHub about acme/demo.
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: ghState, FAKE_GH_LOG: ghLog })
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const { forgetGithub, reviewNeedsOf, reviewerOf, unresolvedOf } = await import('../lib/github.mjs')
const { createService } = await import('../lib/service.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const lane = (cwd, ...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const ghSaid = () => JSON.parse(fs.readFileSync(ghState, 'utf8'))
const ghSet = (change) => fs.writeFileSync(ghState, JSON.stringify({ ...ghSaid(), ...change }, null, 1))
const ghAsked = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])

let origin, repo, feature

before(() => {
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(KIT, 'test', 'fake-gh')}" "$@"\n`, { mode: 0o755 })
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    fs.writeFileSync(ghState, JSON.stringify({
        owner: 'acme', name: 'demo', origin, prs: [], repo: { mergeCommitAllowed: true, squashMergeAllowed: true, rebaseMergeAllowed: true },
        // Pull requests anywhere asking this person for a review: one here, one elsewhere. Asked for once in a while,
        // so said from the start.
        search: [
            { number: 3, title: 'Tidy the docs', url: 'https://github.com/other/thing/pull/3', repository: { name: 'thing', nameWithOwner: 'other/thing' }, author: { login: 'yan' }, updatedAt: '2026-09-29T08:00:00Z', isDraft: true },
            { number: 7, title: 'Fix the parser', url: 'https://github.com/acme/demo/pull/7', repository: { name: 'demo', nameWithOwner: 'acme/demo' }, author: { login: 'zoe' }, updatedAt: '2026-09-30T10:00:00Z', isDraft: false }
        ]
    }))
    repo = path.join(scratch, 'work', 'demo')
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: {
            portBase: 19401, portCeiling: 19499, copyOnCreate: [], linkOnCreate: [],
            env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: []
        }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n.lanekit/\n')
    fs.writeFileSync(path.join(repo, 'app.txt'), 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    // Named as GitHub names it; sent to the bare repository here.
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git')
    git(repo, 'config', `url.${origin}.insteadOf`, 'git@github.com:acme/demo.git')
    git(repo, 'push', '-q', '-u', 'origin', 'main')
    assert.equal(lane(repo, 'new', 'feature').code, 0)
    feature = path.join(scratch, 'work', 'demo-feature')
    fs.writeFileSync(path.join(feature, 'feature.txt'), 'feature\n')
    git(feature, 'add', '-A')
    git(feature, 'commit', '-qm', 'Add the feature')
})

after(() => fs.rmSync(scratch, { recursive: true, force: true }))

test('what a pull request into main needs is read from its rulesets and its protection', () => {
    const pullRequest = (parameters, id = 7) => ({ type: 'pull_request', ruleset_id: id, parameters })
    assert.deepEqual(reviewNeedsOf({ rules: [pullRequest({ required_approving_review_count: 1 }), pullRequest({ required_approving_review_count: 2, required_review_thread_resolution: true }, 8)] }),
        { approvals: 2, codeOwners: false, threads: true }, 'the most any rule asks')
    assert.deepEqual(reviewNeedsOf({ rules: [], protection: { required_pull_request_reviews: { required_approving_review_count: 1, require_code_owner_reviews: true } } }),
        { approvals: 1, codeOwners: true, threads: false })
    assert.deepEqual(reviewNeedsOf({ rules: [], protection: { required_conversation_resolution: { enabled: true } } }), { approvals: 0, codeOwners: false, threads: true })
    assert.equal(reviewNeedsOf({ rules: [{ type: 'non_fast_forward' }] }), null, 'nothing asks for a review')
    assert.equal(reviewNeedsOf({}), null)
    assert.equal(reviewerOf({ __typename: 'User', login: 'alice' }), 'alice')
    assert.equal(reviewerOf({ __typename: 'Team', name: 'Core', slug: 'core' }), 'core')
    assert.deepEqual([...unresolvedOf({ data: { repository: { pullRequests: { nodes: [{ number: 4, reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }] } }] } } } })], [[4, 1]])
})

test('a pull request\'s review is said in a few words: who asked for changes, who approved, who has not answered', () => {
    // reviewWordsOf, read from the page as it is written there and run here: plain data in and out.
    const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
    const start = page.indexOf('const reviewWordsOf = ')
    assert.notEqual(start, -1, 'the page has reviewWordsOf')
    const reviewWordsOf = new Function(`${page.slice(start, page.indexOf('\n}\n', start) + 2)}; return reviewWordsOf`)()
    const open = (extra) => ({ state: 'OPEN', draft: false, review: '', requested: [], reviews: [], ...extra })
    const needs = { approvals: 2, codeOwners: true, threads: true }
    assert.deepEqual(reviewWordsOf(open({ review: 'CHANGES_REQUESTED', reviews: [{ who: 'bob', state: 'CHANGES_REQUESTED' }] }), null),
        { tone: 'bad', text: 'Changes requested by bob', title: 'bob asked for changes' })
    const waiting = reviewWordsOf(open({ review: 'REVIEW_REQUIRED', requested: ['carol', 'acme/core'], reviews: [{ who: 'alice', state: 'APPROVED' }] }), needs)
    assert.equal(waiting.text, 'Waiting on carol and acme/core · 1 of 2')
    assert.match(waiting.title, /alice approved · carol is asked to review · acme\/core is asked to review · 2 approvals needed · its code owners must approve · every thread must be resolved/)
    assert.equal(reviewWordsOf(open({ review: 'REVIEW_REQUIRED' }), needs).text, 'Review required, nobody asked · 0 of 2')
    assert.equal(reviewWordsOf(open({ review: 'APPROVED', reviews: [{ who: 'a', state: 'APPROVED' }, { who: 'b', state: 'APPROVED' }, { who: 'c', state: 'APPROVED' }] }), needs).text,
        'Approved by a, b and 1 more')
    assert.equal(reviewWordsOf(open({ draft: true, requested: ['carol'] }), needs), null, 'a draft is not under review')
    assert.equal(reviewWordsOf(open({}), null), null, 'nobody asked, nothing needed: nothing said')
    assert.equal(reviewWordsOf({ ...open({}), state: 'MERGED' }, needs), null)
})

test('lane pr opens a draft with its reviewers, pushing the lane first; asks more of an open one; and makes a draft ready', () => {
    const odd = lane(repo, 'pr', 'feature', '--reviewer', 'not a login')
    assert.equal(odd.code, 1)
    assert.match(odd.out, /is not a GitHub login/)

    const opened = lane(repo, 'pr', 'feature', '--draft', '--push', '--reviewer', 'alice,acme/core')
    assert.equal(opened.code, 0, opened.out)
    assert.equal(git(origin, 'rev-parse', 'feature'), git(feature, 'rev-parse', 'HEAD'), 'pushed first')
    const create = ghAsked().find((args) => args[0] === 'pr' && args[1] === 'create')
    assert.deepEqual(create, ['pr', 'create', '--base', 'main', '--head', 'feature', '--fill', '--draft', '--reviewer', 'alice', '--reviewer', 'acme/core'])
    const made = ghSaid().prs[0]
    assert.equal(made.isDraft, true)

    const asked = lane(repo, 'pr', 'feature', '--reviewer', 'bob')
    assert.equal(asked.code, 0, asked.out)
    assert.deepEqual(ghSaid().prs[0].reviewRequests.map(reviewerOf), ['alice', 'acme/core', 'bob'])
    assert.equal(ghSaid().prs.length, 1, 'asked of the open one, not a second opened')

    const ready = lane(repo, 'pr', 'feature', '--ready')
    assert.equal(ready.code, 0, ready.out)
    assert.equal(ghSaid().prs[0].isDraft, false)
    assert.match(lane(repo, 'pr', 'feature').out, /has an open pull request already/)
})

test('the reading carries each open pull request\'s review, its threads, and what main\'s rules need of it', async () => {
    ghSet({
        rules: [{ type: 'pull_request', ruleset_id: 7, parameters: { required_approving_review_count: 2, required_review_thread_resolution: true } }],
        rulesets: { 7: { id: 7, current_user_can_bypass: 'never' } },
        prs: ghSaid().prs.map((pr) => ({
            ...pr, reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED', threads: [true, false, false],
            latestReviews: [{ author: { login: 'alice' }, state: 'APPROVED' }], comments: [{ body: 'one' }]
        }))
    })
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    try {
        let read = null
        for (let i = 0; i < 80; i++) {
            read = (await service.state()).repos[0]
            if (read.github?.rules && read.lanes[0]?.pull?.threads !== null && read.lanes[0]?.pull?.requested?.length) break
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.deepEqual(read.github.rules, {
            push: { allowed: false, why: 'main takes its changes by pull request' },
            review: { approvals: 2, codeOwners: false, threads: true }
        })
        const pull = read.lanes.find((candidate) => candidate.name === 'feature').pull
        assert.equal(pull.number, 1)
        assert.equal(pull.review, 'REVIEW_REQUIRED')
        assert.deepEqual(pull.requested, ['alice', 'acme/core', 'bob'])
        assert.deepEqual(pull.reviews, [{ who: 'alice', state: 'APPROVED' }])
        assert.equal(pull.threads, 2)
        assert.equal(pull.comments, 1)
        assert.equal(pull.mergeState, 'BLOCKED')
        // Main may not be pushed to here, and the page's press says so before anything runs.
        git(repo, 'commit', '-q', '--allow-empty', '-m', 'Straight onto main')
        const refused = await service.press({ repo: 'demo', verb: 'push-main' })
        assert.equal(refused.status, 409)
        assert.match(refused.body.error, /takes its changes by pull request/)
        git(repo, 'reset', '-q', '--hard', 'HEAD~1')
    } finally {
        service.dispose()
    }
})

test('where main lands by pull request, a lane\'s next step follows its pull request, and one merged on GitHub says so anywhere', () => {
    // prStepOf, read from the page as it is written there and run here: plain data in and out.
    const page = fs.readFileSync(path.join(KIT, 'web', 'lanes.js'), 'utf8')
    const start = page.indexOf('const prStepOf = ')
    assert.notEqual(start, -1, 'the page has prStepOf')
    const prStepOf = new Function(`${page.slice(start, page.indexOf('\n}\n', start) + 2)}; return prStepOf`)()
    const byPr = { integrationBranch: 'main', github: { rules: { push: { allowed: false } } }, main: { upstream: { behind: 0 } } }
    const here = { ...byPr, github: { rules: { push: { allowed: true } } } }
    const lane = (extra) => ({ kind: 'working', dirty: 0, operation: null, behind: 0, queue: { verdict: 'land now' }, upstream: { ahead: 0, behind: 0 }, pull: null, ...extra })
    const open = (extra) => ({ state: 'OPEN', number: 5, draft: false, review: '', checks: 'passing', mergeState: 'CLEAN', requested: [], ...extra })
    const next = (repo, extra) => prStepOf(repo, lane(extra))?.next ?? null
    assert.equal(next(byPr, {}), 'pr', 'ready, and no pull request yet')
    assert.equal(next(byPr, { queue: { verdict: 'gate now' } }), null, 'its gate first: the usual words')
    assert.equal(next(byPr, { dirty: 2 }), null, 'uncommitted work first')
    assert.equal(next(byPr, { pull: open(), upstream: { ahead: 1, behind: 0 } }), 'push')
    assert.equal(next(byPr, { pull: open(), upstream: { ahead: 1, behind: 2 } }), 'push-force')
    assert.equal(next(byPr, { pull: open({ draft: true }) }), 'ready')
    assert.equal(next(byPr, { pull: open({ review: 'REVIEW_REQUIRED' }) }), 'review', 'nobody asked yet')
    assert.equal(next(byPr, { pull: open({ review: 'REVIEW_REQUIRED', requested: ['carol'] }) }), null, 'waiting on carol')
    assert.equal(next(byPr, { pull: open({ review: 'CHANGES_REQUESTED' }) }), null)
    assert.equal(next(byPr, { pull: open({ mergeState: 'BEHIND' }), behind: 3 }), 'rebase')
    assert.equal(next(byPr, { pull: open({ review: 'APPROVED' }) }), 'merge')
    assert.equal(prStepOf(byPr, lane({ pull: open({ review: 'APPROVED' }) })).word, 'Approved: ready to merge')
    assert.equal(next(here, { pull: open({ review: 'APPROVED' }) }), null, 'where main lands here, the usual words')
    assert.equal(next(here, { pull: { state: 'MERGED' } }), 'drop', 'merged on GitHub, squashed: anywhere')
    assert.equal(next({ ...here, main: { upstream: { behind: 1 } } }, { pull: { state: 'MERGED' } }), 'pull', 'main here is behind it')
})

test('lane merge merges a pull request GitHub would merge, at the lane\'s own commit, and brings main here up to it', () => {
    const head = git(feature, 'rev-parse', 'HEAD')
    const pr = (change) => ghSet({ prs: ghSaid().prs.map((one) => (one.number === 1 ? { ...one, ...change } : one)) })
    pr({ reviewDecision: 'REVIEW_REQUIRED', headRefOid: head, mergeStateStatus: 'BLOCKED' })
    assert.match(lane(repo, 'merge', 'feature').out, /#1 waits for its review/)
    pr({ reviewDecision: 'APPROVED', isDraft: true })
    assert.match(lane(repo, 'merge', 'feature').out, /#1 is a draft: lane pr feature --ready/)
    pr({ isDraft: false, headRefOid: 'f'.repeat(40) })
    assert.match(lane(repo, 'merge', 'feature').out, /lane push feature first/)
    assert.ok(!ghAsked().some((args) => args[0] === 'pr' && args[1] === 'merge'), 'nothing was merged yet')

    pr({ headRefOid: head, mergeStateStatus: 'CLEAN' })
    const merged = lane(repo, 'merge', 'feature')
    assert.equal(merged.code, 0, merged.out)
    assert.match(merged.out, /MERGED/)
    assert.deepEqual(ghAsked().find((args) => args[0] === 'pr' && args[1] === 'merge'), ['pr', 'merge', '1', '--merge', '--match-head-commit', head])
    assert.equal(git(origin, 'rev-list', '--parents', '-n1', 'main').split(' ')[2], head, 'a merge commit, the lane\'s commit its second parent')
    assert.equal(git(repo, 'rev-parse', 'main'), git(origin, 'rev-parse', 'main'), 'main here brought up to it')
    git(repo, 'merge-base', '--is-ancestor', 'feature', 'main')
})

test('squashed on GitHub, a lane is said to be merged there, to drop; and the page\'s land and merge are held to main\'s rules', async () => {
    assert.equal(lane(repo, 'new', 'second').code, 0)
    const second = path.join(scratch, 'work', 'demo-second')
    fs.writeFileSync(path.join(second, 'second.txt'), 'second\n')
    git(second, 'add', '-A')
    git(second, 'commit', '-qm', 'Add a second thing')
    assert.equal(lane(repo, 'pr', 'second', '--push').code, 0)
    ghSet({
        repo: { mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: false },
        prs: ghSaid().prs.map((one) => (one.headRefName === 'second' ? { ...one, reviewDecision: 'APPROVED', headRefOid: git(second, 'rev-parse', 'HEAD'), mergeStateStatus: 'CLEAN' } : one))
    })
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    try {
        const landed = await service.press({ repo: 'demo', verb: 'land', lane: 'second', dryRun: true })
        assert.equal(landed.status, 409)
        assert.match(landed.body.error, /lands there by its pull request/)

        const squashed = lane(repo, 'merge', 'second')
        assert.equal(squashed.code, 0, squashed.out)
        assert.ok(ghAsked().some((args) => args[0] === 'pr' && args[1] === 'merge' && args.includes('--squash')))
        assert.match(squashed.out, /lane drop second/)
        assert.equal(spawnSync('git', ['merge-base', '--is-ancestor', 'second', 'main'], { cwd: repo }).status, 1, 'its commits are not main\'s own')

        forgetGithub(repo)
        let read = null
        for (let i = 0; i < 80; i++) {
            read = (await service.state()).repos[0].lanes.find((candidate) => candidate.name === 'second')
            if (read?.pull?.state === 'MERGED') break
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(read.kind, 'working')
        assert.equal(read.pull.state, 'MERGED')
        const again = await service.press({ repo: 'demo', verb: 'merge', lane: 'second' })
        assert.equal(again.status, 409)
        assert.match(again.body.error, /no open pull request to merge/)
    } finally {
        service.dispose()
    }
})

test('pull requests anywhere that wait on your review are asked of GitHub, newest first, and matched to the repositories here', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    try {
        let state = null
        for (let i = 0; i < 80; i++) {
            state = await service.state()
            if (state.reviews.length === 2 && state.repos[0].github?.slug) break
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.deepEqual(state.reviews.map((review) => [review.repo, review.number, review.author, review.draft]), [['acme/demo', 7, 'zoe', false], ['other/thing', 3, 'yan', true]])
        assert.equal(state.reviews[0].url, 'https://github.com/acme/demo/pull/7')
        assert.equal(state.repos[0].github.slug, 'acme/demo', 'the repository here, by its name on GitHub')
        assert.ok(ghAsked().some((args) => args[0] === 'search' && args.includes('--review-requested=@me') && args.includes('--state=open')))
    } finally {
        service.dispose()
    }
})
