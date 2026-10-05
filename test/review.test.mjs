/**
 * Reviewing somebody's pull request in a lane of its own: `lane new --pr <n>` checks it out with its own port and
 * environment, from a branch of this repository or from a fork; `lane pull` brings what its author pushed, putting the
 * gate's rebase aside and never the reviewer's own commits; `lane review` says what the reviewer makes of it, on GitHub;
 * and nothing a lane of one's own does with its branch (push, land, a pull request of its own) is done to somebody
 * else's. Against lanekit's stand-in for gh (test/fake-gh) and a bare repository standing in for GitHub, which keeps each
 * pull request's head as GitHub does, under refs/pull/<n>/head.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing. Nothing here reaches GitHub.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-review-')))
const bin = path.join(scratch, 'bin')
const ghState = path.join(scratch, 'gh-state.json')
const ghLog = path.join(scratch, 'gh-log.jsonl')
// The stand-in first on the PATH, in this process too, before lanekit's modules load: they read the PATH then.
Object.assign(process.env, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_GH_STATE: ghState, FAKE_GH_LOG: ghLog })
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
const { forgetGithub } = await import('../lib/github.mjs')
const { createService } = await import('../lib/service.mjs')
const { repoState } = await import('../lib/state.mjs')
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const lane = (...args) => {
    const result = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), ...args], { cwd: repo, env, encoding: 'utf8' })
    return { code: result.status, out: `${result.stdout}${result.stderr}` }
}
const write = (cwd, file, text) => fs.writeFileSync(path.join(cwd, file), text)
const commit = (cwd, file, text, message) => { write(cwd, file, text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-qm', message) }
const laneDir = (name) => path.join(scratch, 'work', `demo-${name}`)
const ghAsked = () => (fs.existsSync(ghLog) ? fs.readFileSync(ghLog, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [])
const read = (name) => repoState(repo).lanes.find((candidate) => candidate.name === name)
/** What a pull request's author pushes: their branch on "GitHub", and GitHub's own copy of the pull request's head. */
const authorPushes = (number, file, text, message, branch = null) => {
    commit(author, file, text, message)
    if (branch) git(author, 'push', '-q', 'origin', `HEAD:refs/heads/${branch}`)
    git(author, 'push', '-q', '-f', 'origin', `HEAD:refs/pull/${number}/head`)
}

let origin, repo, author

before(() => {
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(KIT, 'test', 'fake-gh')}" "$@"\n`, { mode: 0o755 })
    origin = path.join(scratch, 'origin.git')
    git(scratch, 'init', '-q', '--bare', '-b', 'main', origin)
    repo = path.join(scratch, 'work', 'demo')
    fs.mkdirSync(repo, { recursive: true })
    write(repo, 'lane.config.json', JSON.stringify({
        name: 'Demo', slug: 'demo', integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'check', steps: [{ what: 'nothing', command: 'true', args: [] }] } } },
        lane: { portBase: 19101, portCeiling: 19199, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    write(repo, '.gitignore', '.env\n.lanekit/\n')
    write(repo, 'app.txt', 'one\n')
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    // Named as GitHub names it, sent to the bare repository here.
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/demo.git')
    git(repo, 'config', `url.${origin}.insteadOf`, 'git@github.com:acme/demo.git')
    git(repo, 'push', '-q', '-u', 'origin', 'main')

    // Zoe's pull request from a branch of this repository (#5), and Yan's from a fork (#6), which has no branch here.
    author = path.join(scratch, 'author')
    git(scratch, 'clone', '-q', origin, author)
    git(author, 'switch', '-q', '-c', 'feature-x')
    authorPushes(5, 'feature.txt', 'the feature\n', 'Add the feature', 'feature-x')
    git(author, 'switch', '-q', '--detach', 'origin/main')
    authorPushes(6, 'fork.txt', 'from a fork\n', 'Fix it from a fork')
    git(author, 'switch', '-q', 'feature-x')
    fs.writeFileSync(ghState, JSON.stringify({
        owner: 'acme', name: 'demo', origin, me: 'reviewer',
        prs: [
            { number: 5, title: 'Add the feature', state: 'OPEN', isDraft: false, headRefName: 'feature-x', isCrossRepository: false, author: { login: 'zoe' }, baseRefName: 'main', url: 'https://github.com/acme/demo/pull/5' },
            { number: 6, title: 'Fix it from a fork', state: 'OPEN', isDraft: false, headRefName: 'patch-1', isCrossRepository: true, author: { login: 'yan' }, baseRefName: 'main', url: 'https://github.com/acme/demo/pull/6' },
            { number: 4, title: 'Long gone', state: 'MERGED', isDraft: false, headRefName: 'old', isCrossRepository: false, author: { login: 'zoe' }, baseRefName: 'main', url: 'https://github.com/acme/demo/pull/4' }
        ]
    }))
})

// The service's asks of gh run in the background, one after the other, and a read begun before the service was
// disposed goes on to its end: the folder goes once gh's log has stopped growing.
after(async () => {
    for (let last = -1, i = 0; i < 30; i++) {
        const size = fs.existsSync(ghLog) ? fs.statSync(ghLog).size : 0
        if (size === last) break
        last = size
        await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('a pull request from this repository is checked out in a lane of its own, named for it, following its branch', () => {
    const made = lane('new', '--pr', '5')
    assert.equal(made.code, 0, made.out)
    assert.match(made.out, /reviewing #5, "Add the feature" by zoe: it follows origin\/feature-x/)
    assert.match(made.out, /lane "review-5" ready/)
    assert.match(made.out, /from #5 by zoe, as pushed/)
    assert.equal(fs.readFileSync(path.join(laneDir('review-5'), 'feature.txt'), 'utf8'), 'the feature\n')
    assert.ok(fs.existsSync(path.join(laneDir('review-5'), '.env')), 'with an environment of its own')
    assert.equal(git(laneDir('review-5'), 'rev-parse', '--abbrev-ref', '@{upstream}'), 'origin/feature-x')
    const read5 = read('review-5')
    assert.equal(read5.review, 5)
    assert.equal(read5.queue, null, 'somebody else\'s work is not in this person\'s landing order')
})

test('one from a fork is checked out from GitHub\'s copy of its head, with no branch here to follow', () => {
    const made = lane('new', 'fork-6', '--pr', '6')
    assert.equal(made.code, 0, made.out)
    assert.match(made.out, /from a fork, so lane pull fetches what its author pushes/)
    assert.equal(fs.readFileSync(path.join(laneDir('fork-6'), 'fork.txt'), 'utf8'), 'from a fork\n')
    assert.equal(spawnSync('git', ['rev-parse', '--abbrev-ref', '@{upstream}'], { cwd: laneDir('fork-6') }).status, 128, 'no upstream')
    assert.equal(read('fork-6').review, 6)
})

test('what cannot be reviewed is refused before anything is made', () => {
    assert.match(lane('new', '--pr', '4').out, /#4 is merged: there is nothing left to review/)
    assert.match(lane('new', '--pr', 'abc').out, /"abc" is not a pull request's number/)
    assert.match(lane('new', 'x', '--pr', '5', '--base', 'main').out, /--pr takes the pull request as it is/)
    assert.match(lane('new', '--pr', '5').out, /demo-review-5 already exists/, 'its lane is there already')
    assert.match(lane('new', '--pr', '99').out, /GitHub has no pull request #99 here/)
    assert.ok(!fs.existsSync(laneDir('review-4')) && !fs.existsSync(laneDir('review-99')))
})

test('lane pull brings what the author pushed, the gate\'s rebase put aside, and never the reviewer\'s own commits', () => {
    authorPushes(5, 'feature.txt', 'the feature, better\n', 'Answer the review', 'feature-x')
    const pulled = lane('pull', 'review-5')
    assert.equal(pulled.code, 0, pulled.out)
    assert.match(pulled.out, /#5 as its author pushed it/)
    assert.equal(fs.readFileSync(path.join(laneDir('review-5'), 'feature.txt'), 'utf8'), 'the feature, better\n')

    // The gate rebases the lane onto main as it is: what the author pushes after that still arrives.
    commit(repo, 'main.txt', 'main moves\n', 'Main moves on')
    git(laneDir('review-5'), 'rebase', '-q', 'main')
    authorPushes(5, 'more.txt', 'more\n', 'And more', 'feature-x')
    const after = lane('pull', 'review-5')
    assert.equal(after.code, 0, after.out)
    assert.match(after.out, /what the gate rebased onto main is put aside for what #5's author pushed/)
    assert.equal(git(laneDir('review-5'), 'rev-parse', 'HEAD'), git(author, 'rev-parse', 'HEAD'))

    // A commit of the reviewer's own is theirs: a pull that would lose it is refused.
    commit(laneDir('review-5'), 'mine.txt', 'a thought of mine\n', 'Try something')
    authorPushes(5, 'last.txt', 'last\n', 'One last thing', 'feature-x')
    const refused = lane('pull', 'review-5')
    assert.equal(refused.code, 1)
    assert.match(refused.out, /review-5 has 1 commit of your own on #5, which a pull would lose/)
    assert.ok(fs.existsSync(path.join(laneDir('review-5'), 'mine.txt')))
    git(laneDir('review-5'), 'reset', '-q', '--hard', 'HEAD~1')
    assert.equal(lane('pull', 'review-5').code, 0)

    // From a fork: GitHub's copy of its head, fetched again.
    git(author, 'switch', '-q', '--detach', `${git(origin, 'rev-parse', 'refs/pull/6/head')}`)
    authorPushes(6, 'fork.txt', 'from a fork, again\n', 'Answer from the fork')
    git(author, 'switch', '-q', 'feature-x')
    const fork = lane('pull', 'fork-6')
    assert.equal(fork.code, 0, fork.out)
    assert.equal(fs.readFileSync(path.join(laneDir('fork-6'), 'fork.txt'), 'utf8'), 'from a fork, again\n')
    assert.match(lane('pull', 'fork-6').out, /#6 has nothing new for fork-6/)
})

test('somebody else\'s pull request is never pushed, landed or given a pull request of its own from its review lane', () => {
    commit(laneDir('review-5'), 'tweak.txt', 'a tweak\n', 'A tweak of the reviewer\'s')
    for (const [verb, said] of [['push', /review-5 is a review of #5, somebody else's work, so it is not pushed/],
        ['land', /so it is not landed from here: it lands by its pull request/], ['pr', /so it is not given a pull request of its own/]]) {
        const refused = lane(verb, 'review-5')
        assert.equal(refused.code, 1, verb)
        assert.match(refused.out, said)
    }
    assert.notEqual(git(origin, 'rev-parse', 'refs/heads/feature-x'), git(laneDir('review-5'), 'rev-parse', 'HEAD'), 'the author\'s branch untouched')
    git(laneDir('review-5'), 'reset', '-q', '--hard', 'HEAD~1')
})

test('lane review says on GitHub what the reviewer makes of it: approved, changes requested, or a comment', () => {
    assert.match(lane('review', 'review-5').out, /lane review needs what you make of it/)
    assert.match(lane('review', 'review-5', '--request-changes').out, /--request-changes needs its words/)
    const asked = lane('review', 'review-5', '--request-changes', '-m', 'Name the new file for what it holds')
    assert.equal(asked.code, 0, asked.out)
    assert.match(asked.out, /REVIEWED\S*\s+·\s+review-5\s+·\s+#5 changes requested/)
    assert.deepEqual(ghAsked().find((args) => args[1] === 'review'), ['pr', 'review', '5', '--request-changes', '--body', 'Name the new file for what it holds'])
    const approved = lane('review', 'fork-6', '--approve')
    assert.equal(approved.code, 0, approved.out)
    assert.deepEqual(ghAsked().filter((args) => args[1] === 'review').at(-1), ['pr', 'review', '6', '--approve'])
    assert.equal(lane('new', 'mine').code, 0)
    assert.match(lane('review', 'mine', '--approve').out, /mine is not a review lane: lane new --pr <number> makes one/)
})

test('the page reads a review lane\'s pull request by its number, and its presses are held to the same rules', async () => {
    const service = createService({ dirs: [path.join(scratch, 'work')] })
    try {
        forgetGithub(repo)
        let seen = null
        // What its review said comes in GitHub's second answer, asked once the list that finds it is in: waited for too,
        // or a reading between the two (a busy CI runner's) finds the pull request with no review yet.
        for (let i = 0; i < 80; i++) {
            seen = (await service.state()).repos[0].lanes.find((candidate) => candidate.name === 'review-5')
            if (seen?.pull?.number === 5 && seen.pull.review) break
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
        assert.equal(seen.pull.number, 5, 'found by its number, its branch being the reviewer\'s own name for it')
        assert.equal(seen.pull.author, 'zoe')
        assert.equal(seen.pull.review, 'CHANGES_REQUESTED', 'and what the review said')
        const refused = async (body, pattern, status = 409) => {
            const answer = await service.press(body)
            assert.equal(answer.status, status, JSON.stringify(answer.body))
            assert.match(answer.body.error, pattern)
        }
        await refused({ repo: 'demo', verb: 'new', name: 'review-x', pr: 'x' }, /"x" is not a pull request's number/, 400)
        await refused({ repo: 'demo', verb: 'new', name: 'again-5', pr: 5 }, /#5 is being reviewed in review-5 already/)
        await refused({ repo: 'demo', verb: 'review', lane: 'review-5', verdict: 'shrug' }, /approves, requests changes, or comments/, 400)
        await refused({ repo: 'demo', verb: 'review', lane: 'review-5', verdict: 'comment' }, /a comment needs its words/, 400)
        await refused({ repo: 'demo', verb: 'review', lane: 'mine', verdict: 'approve' }, /mine is not a review of a pull request/)
        await refused({ repo: 'demo', verb: 'push', lane: 'review-5' }, /review-5 is a review of #5, somebody else's work, so it is not pushed/)
        await refused({ repo: 'demo', verb: 'land', lane: 'review-5' }, /so it is not landed from here/)
        await refused({ repo: 'demo', verb: 'pr', lane: 'review-5' }, /so it is not given a pull request of its own/)
        const pressed = await service.press({ repo: 'demo', verb: 'review', lane: 'review-5', verdict: 'approve' })
        assert.equal(pressed.status, 202, JSON.stringify(pressed.body))
        assert.match(pressed.body.command, /lane\.mjs review review-5 --approve$/)
        for (let i = 0; i < 300 && service.job(pressed.body.id)?.state !== 'done'; i++) await new Promise((resolve) => setTimeout(resolve, 20))
        assert.equal(service.job(pressed.body.id).code, 0, service.job(pressed.body.id).output)
        const made = await service.press({ repo: 'demo', verb: 'new', name: 'review-6b', pr: 6 })
        assert.equal(made.status, 409, 'one lane per pull request: #6 is in fork-6')
    } finally {
        service.dispose()
    }
})
