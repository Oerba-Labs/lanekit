/**
 * What a gate's tests said, read from the JUnit XML they wrote into $LAB_RESULTS (lib/results.mjs): the reader on its
 * own, on files in the shapes pytest, `node --test` and go-junit-report write, several at once, none, malformed ones
 * and huge ones; then the gate itself on scratch repositories, giving its steps the folder, emptying its own and
 * leaving the environment's alone, saying the counts and the tests that failed, and changing nothing for a project
 * that writes no JUnit; where the time went (each step's seconds, the slowest tests, and a gate that has got much slower
 * than its recent runs); lanekit's own ./check writing JUnit only where it is asked to; and what the service, the page's
 * state and the MCP server's gate tool are told.
 *
 *     node --test
 *
 * Needs git and node; leaves nothing.
 */

import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { after, before, test } from 'node:test'

import { countsSaid, grownSaid, LIMITS, parseJUnit, prepareResults, readResults, resultsFolderFor, SLOWEST, slowestLines, testsGrown, testsLines, testsShown } from '../lib/results.mjs'
import { SLOWDOWN, slowdownLines, slowdownOf } from '../lib/runs.mjs'
import { createService } from '../lib/service.mjs'
import { repoState } from '../lib/state.mjs'

const KIT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
    LANEKIT_PORTS: ''
}
delete env.LAB_RESULTS
// And from this process's own: the services made below spawn their gates with it, and a gate of lanekit itself runs these
// tests with LAB_RESULTS set to its own folder, where the fixtures would then land, counted as lanekit's tests.
delete process.env.LAB_RESULTS
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
// eslint-disable-next-line no-control-regex
const plain = (text) => text.replace(/\x1b\[[0-9;]*m/g, '')

// ---------------------------------------------------------------------------
// JUnit as the reporters write it
// ---------------------------------------------------------------------------

/** pytest 8's, on one line as it writes it: a failure, a setup error, a skip, an xfail, two passes. */
const PYTEST = '<?xml version="1.0" encoding="utf-8"?><testsuites name="pytest tests"><testsuite name="pytest" errors="1" failures="1" skipped="2" tests="6" time="0.120" timestamp="2026-10-17T12:00:00.000000+00:00" hostname="box">' +
    '<testcase classname="tests.test_scores" name="test_page_turns" time="0.001" />' +
    '<testcase classname="tests.test_scores" name="test_long_score_splits" time="0.002"><failure message="assert 3 == 4">def test_long_score_splits():\n&gt;       assert 3 == 4\nE       assert 3 == 4\n\ntests/test_scores.py:8: AssertionError</failure></testcase>' +
    '<testcase classname="tests.test_scores" name="test_tie_crosses" time="0.000"><skipped type="pytest.skip" message="needs the engraver">tests/test_scores.py:11: needs the engraver</skipped></testcase>' +
    '<testcase classname="tests.test_db" name="test_migrations" time="0.003"><error message="failed on setup with &quot;sqlite3.OperationalError: unable to open database file&quot;">conftest.py:9: OperationalError</error></testcase>' +
    '<testcase classname="tests.test_db" name="test_seed[one &amp; two]" time="0.001"><system-out>seeded</system-out></testcase>' +
    '<testcase classname="tests.test_db" name="test_vacuum" time="0.001"><skipped type="pytest.xfail" message="sqlite cannot yet" /></testcase>' +
    '</testsuite></testsuites>'

/** `node --test --test-reporter=junit`'s: cases at the top and in a suite, a skip and a todo, `>` left bare in an
    attribute, and the comments it ends with. */
const NODE = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testcase name="the title is centred" time="0.000394" classname="test"/>
	<testcase name="a &lt;title> with &amp; in it" time="0.000323" classname="test" failure="1 == 2">
		<failure type="testCodeFailure" message="1 == 2">
[Error [ERR_TEST_FAILURE]: 1 == 2] {
  code: 'ERR_TEST_FAILURE',
      at TestContext.&lt;anonymous> (file:///work/scores/title.test.mjs:4:46)
}
		</failure>
	</testcase>
	<testcase name="a tie crosses the page" time="0.000045" classname="test">
		<skipped type="skipped" message="needs the engraver"/>
	</testcase>
	<testcase name="a coda" time="0.000048" classname="test">
		<skipped type="todo" message="true"/>
	</testcase>
	<testsuite name="scores" time="0.000289" disabled="0" errors="0" tests="2" failures="1" skipped="0" hostname="box">
		<testcase name="a page turns at the bar line" time="0.000074" classname="test"/>
		<testcase name="a long score splits into pages" time="0.000048" classname="test" failure="boom">
			<failure type="testCodeFailure" message="boom">
Error [ERR_TEST_FAILURE]: boom
			</failure>
		</testcase>
	</testsuite>
	<!-- tests 6 -->
	<!-- pass 2 -->
	<!-- fail 2 -->
	<!-- duration_ms 47.763 -->
</testsuites>
`

/** go-junit-report's: CDATA, properties, a package that did not build. */
const GO = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites tests="4" failures="1" errors="1" skipped="1">
	<testsuite name="example.com/scores" tests="3" failures="1" errors="0" id="0" hostname="box" skipped="1" time="0.004" timestamp="2026-10-17T12:00:00Z">
		<properties>
			<property name="go.version" value="go1.23.2 linux/amd64"></property>
		</properties>
		<testcase name="TestPageTurns" classname="example.com/scores" time="0.000"></testcase>
		<testcase name="TestLongScore/three_pages" classname="example.com/scores" time="0.001">
			<failure message="Failed"><![CDATA[    scores_test.go:21: got 3 pages, want 4 <not a tag>]]></failure>
		</testcase>
		<testcase name="TestTie" classname="example.com/scores" time="0.000">
			<skipped message="Skipped"><![CDATA[    scores_test.go:30: needs the engraver]]></skipped>
		</testcase>
	</testsuite>
	<testsuite name="example.com/midi" tests="1" failures="0" errors="1" id="1" hostname="box" time="0.000" timestamp="2026-10-17T12:00:00Z">
		<testcase name="[build failed]" classname="example.com/midi" time="0.000">
			<error message="Build error"><![CDATA[midi/export.go:12:2: undefined: Track]]></error>
		</testcase>
	</testsuite>
</testsuites>
`

/** A file of `n` passing cases, and `failing` failing ones, as one suite. */
const many = (n, failing = 0) => {
    const cases = []
    for (let i = 0; i < n; i++) cases.push(`<testcase classname="tests.test_bulk" name="test_${i}" time="0.001"/>`)
    for (let i = 0; i < failing; i++) cases.push(`<testcase classname="tests.test_bulk" name="test_broken_${i}" time="0.001"><failure message="no">no</failure></testcase>`)
    return `<?xml version="1.0" encoding="utf-8"?><testsuites><testsuite name="bulk" tests="${n + failing}">${cases.join('')}</testsuite></testsuites>`
}

let scratch
const folder = (name) => {
    const dir = path.join(scratch, 'folders', name)
    fs.mkdirSync(dir, { recursive: true })
    return dir
}
const put = (dir, file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
}

before(() => { scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lanekit-results-'))) })
after(() => { if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })

// ---------------------------------------------------------------------------
// the reader
// ---------------------------------------------------------------------------

test('pytest\'s JUnit is counted: passed, failed, errored and skipped, and the tests that did not pass named', () => {
    const dir = folder('pytest')
    put(dir, 'pytest.xml', PYTEST)
    const tests = readResults(dir)
    assert.deepEqual({ files: tests.files, total: tests.total, passed: tests.passed, failed: tests.failed, errored: tests.errored, skipped: tests.skipped },
        { files: 1, total: 6, passed: 2, failed: 1, errored: 1, skipped: 2 })
    assert.deepEqual(tests.failing, [
        { name: 'tests.test_scores::test_long_score_splits', outcome: 'failed' },
        { name: 'tests.test_db::test_migrations', outcome: 'errored' }
    ])
    assert.deepEqual(tests.unreadable, [])
    assert.equal(countsSaid(tests), '2 passed, 1 failed, 1 errored, 2 skipped')
    assert.deepEqual(testsLines(tests), [
        'tests: 2 passed, 1 failed, 1 errored, 2 skipped',
        '  failed   tests.test_scores::test_long_score_splits',
        '  errored  tests.test_db::test_migrations'
    ])
})

test('node --test\'s and go-junit-report\'s JUnit are counted too: suites in suites, CDATA, entities, and its closing comments', () => {
    const node = parseJUnit(NODE)
    assert.equal(node.junit, true)
    assert.deepEqual(node.cases.map((one) => one.outcome), ['passed', 'failed', 'skipped', 'skipped', 'passed', 'failed'])
    assert.equal(node.cases[1].name, 'test::a <title> with & in it', 'attributes are decoded, and a bare > in one is allowed')
    assert.equal(node.cases[5].name, 'test::a long score splits into pages')

    const go = parseJUnit(GO)
    assert.deepEqual(go.cases.map((one) => [one.name, one.outcome]), [
        ['example.com/scores::TestPageTurns', 'passed'],
        ['example.com/scores::TestLongScore/three_pages', 'failed'],
        ['example.com/scores::TestTie', 'skipped'],
        ['example.com/midi::[build failed]', 'errored']
    ])
})

test('several files are counted together, in subfolders, in the order of their paths; other XML and other files are passed over', () => {
    const dir = folder('several')
    put(dir, 'web/node.xml', NODE)
    put(dir, 'api/pytest.xml', PYTEST)
    put(dir, 'go.xml', GO)
    put(dir, 'coverage.xml', '<?xml version="1.0"?><coverage line-rate="0.9"><packages/></coverage>')
    put(dir, 'notes.txt', 'not XML, not read')
    put(dir, 'a/b/c/d/e/deep.xml', many(3))   // deeper than LaneKit looks
    fs.symlinkSync(path.join(dir, 'go.xml'), path.join(dir, 'linked.xml'))
    const tests = readResults(dir)
    assert.equal(tests.files, 3, 'pytest\'s, node\'s and go\'s; not the coverage report, the deep file or the link')
    assert.equal(tests.total, 16)
    assert.deepEqual([tests.passed, tests.failed, tests.errored, tests.skipped], [5, 4, 2, 5])
    assert.deepEqual(tests.failing.map((one) => one.name), [
        'tests.test_scores::test_long_score_splits', 'tests.test_db::test_migrations',
        'example.com/scores::TestLongScore/three_pages', 'example.com/midi::[build failed]', 'test::a <title> with & in it'
    ], 'api/ before go.xml before web/, the first five of six')
    const lines = testsLines(tests)
    assert.equal(lines[0], 'tests: 5 passed, 4 failed, 2 errored, 5 skipped')
    assert.equal(lines.length, 7, 'the counts, five names and one more')
    assert.equal(lines.at(-1), '  and 1 more')
})

test('an empty folder, a missing one, and one holding only XML that is not JUnit, have nothing to say', () => {
    assert.equal(readResults(folder('empty')), null)
    assert.equal(readResults(path.join(scratch, 'folders', 'not-there')), null)
    const other = folder('other')
    put(other, 'coverage.xml', '<coverage/>')
    assert.equal(readResults(other), null)
    assert.deepEqual(testsLines(null), [])
    assert.equal(testsShown(undefined), null)
    // JUnit that holds no test at all is something to say: nothing ran.
    const none = folder('none')
    put(none, 'node.xml', '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n\t<!-- tests 0 -->\n</testsuites>\n')
    assert.deepEqual(testsLines(readResults(none)), ['tests: no tests ran'])
})

test('malformed XML is said once, in plain words, with why for each file; its tests are not counted, and the others still are', () => {
    const reasons = {
        'cut.xml': [PYTEST.slice(0, PYTEST.indexOf('<testcase classname="tests.test_db"')), /it ends inside <testsuite>/],
        'crossed.xml': ['<testsuites><testsuite><testcase name="x"></testsuite></testsuites>', /<\/testsuite> closes <testcase>, at line 1/],
        'empty.xml': ['', /it is empty/],
        'words.xml': ['all tests passed, honestly', /text before its first element/],
        'two.xml': ['<testsuite/>\n<testsuite/>', /more than one root element, at line 2/],
        'after.xml': ['<testsuite></testsuite> trailing words', /text after its root element/],
        'lt.xml': ['<testsuite><testcase name="a < b"/></testsuite>', /a tag is not well formed/],
        'laughs.xml': ['<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><testsuite><testcase name="&lol2;"/></testsuite>', /DOCTYPE, which LaneKit does not read/],
        'comment.xml': ['<testsuite><!-- never closed', /a comment never ends/]
    }
    for (const [file, [text, why]] of Object.entries(reasons)) {
        assert.throws(() => parseJUnit(text), why, file)
    }
    const dir = folder('malformed')
    put(dir, 'good.xml', GO)
    for (const [file, [text]] of Object.entries(reasons)) put(dir, file, text)
    const tests = readResults(dir)
    assert.equal(tests.files, 1)
    assert.equal(tests.total, 4, 'the good file is counted, and nothing of the malformed ones')
    assert.equal(tests.unreadable.length, Object.keys(reasons).length)
    const lines = testsLines(tests)
    assert.equal(lines[0], 'tests: 1 passed, 1 failed, 1 errored, 1 skipped')
    const unread = lines.filter((line) => /could not be read/.test(line))
    assert.equal(unread.length, 1, 'said once')
    assert.match(unread[0], /^9 XML files the tests wrote could not be read, so they are not counted: after\.xml \(it has text after its root element, at line 1\), comment\.xml \(a comment never ends, at line 1\), crossed\.xml \(.*\), and 6 more$/)

    const alone = folder('malformed-alone')
    put(alone, 'pytest.xml', reasons['cut.xml'][0])
    assert.deepEqual(testsLines(readResults(alone)), ['1 XML file the tests wrote could not be read, so it is not counted: pytest.xml (it ends inside <testsuite>)'])
})

test('how much is read is bounded: a file past the bound is not opened, nor JUnit past the total, nor files past the count', () => {
    const dir = folder('bounded')
    put(dir, 'a-small.xml', many(2))
    put(dir, 'b-huge.xml', many(400))
    fs.chmodSync(path.join(dir, 'b-huge.xml'), 0o000)   // were it opened, it would say so
    put(dir, 'c-small.xml', many(2))
    put(dir, 'd-small.xml', many(2))
    // Room in all for the first small file and not the second.
    const small = fs.statSync(path.join(dir, 'a-small.xml')).size
    const limits = { ...LIMITS, fileBytes: 4096, totalBytes: small + 10, files: 3 }
    const tests = readResults(dir, { limits })
    fs.chmodSync(path.join(dir, 'b-huge.xml'), 0o644)
    assert.equal(tests.files, 1)
    assert.equal(tests.passed, 2)
    assert.deepEqual(tests.unreadable.map((one) => one.file), ['b-huge.xml', 'c-small.xml'])
    assert.match(tests.unreadable[0].why, /^it is \d+ KB, more than the 4 KB LaneKit reads of one file$/)
    assert.match(tests.unreadable[1].why, new RegExp(`^LaneKit reads at most ${small + 10} bytes of JUnit in all$`))
    assert.equal(tests.notRead, 1)
    assert.match(testsLines(tests).at(-1), /; 1 more XML file was not read, past the first 3$/)
})

test('a large file in bounds is read whole, quickly: 100,000 tests', () => {
    const dir = folder('large')
    put(dir, 'bulk.xml', many(99_990, 10))
    const size = fs.statSync(path.join(dir, 'bulk.xml')).size
    assert.ok(size > 5 * 1024 * 1024 && size < LIMITS.fileBytes, `${size} bytes`)
    const began = Date.now()
    const tests = readResults(dir)
    assert.ok(Date.now() - began < 10_000, `read in ${Date.now() - began} ms`)
    assert.equal(countsSaid(tests), '99,990 passed, 10 failed')
    assert.equal(tests.failing.length, 5)
    assert.equal(testsLines(tests).at(-1), '  and 5 more')
})

test('a folder of its own is emptied first; one somebody else named keeps every file, and only what the run wrote is read', () => {
    const own = folder('own')
    put(own, 'old.xml', PYTEST)
    assert.equal(prepareResults({ dir: own, own: true }), null)
    assert.deepEqual(fs.readdirSync(own), [])

    const theirs = folder('theirs')
    put(theirs, 'old.xml', PYTEST)
    put(theirs, 'keep.txt', 'somebody\'s')
    put(theirs, 'rewritten.xml', PYTEST)
    const seen = prepareResults({ dir: theirs, own: false })
    put(theirs, 'new.xml', GO)
    fs.writeFileSync(path.join(theirs, 'rewritten.xml'), many(7))
    const tests = readResults(theirs, { before: seen })
    assert.equal(tests.files, 2, 'the new file and the rewritten one, not the one left as it was')
    assert.equal(tests.total, 11)
    assert.deepEqual(fs.readdirSync(theirs).sort(), ['keep.txt', 'new.xml', 'old.xml', 'rewritten.xml'])
    const untouched = folder('untouched')
    put(untouched, 'old.xml', PYTEST)
    assert.equal(readResults(untouched, { before: prepareResults({ dir: untouched, own: false }) }), null, 'nothing new: nothing said')
})

// ---------------------------------------------------------------------------
// where the time went
// ---------------------------------------------------------------------------

/** A self-test runner's JUnit, as homelab's ./check is to write it: suites, a suite in a suite, a file, and two tests
    without a time that is one. */
const TIMED = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
	<testsuite name="selftests" time="40.5">
		<testcase name="backup restores" classname="selftest" time="31.25"/>
		<testcase name="dns answers" classname="selftest" time="0.4"/>
		<testsuite name="vault">
			<testcase name="unseals" classname="selftest" time="8.0004"/>
		</testsuite>
		<testcase name="no time" classname="selftest"/>
		<testcase name="a time that is not one" classname="selftest" time="soon"/>
	</testsuite>
	<testcase name="lint" file="tools/lint.sh" time="1.5"/>
</testsuites>
`

test('each test\'s time, file and suite are read, and the slowest are kept, slowest first, bounded', () => {
    const parsed = parseJUnit(TIMED)
    assert.deepEqual(parsed.cases.map(({ name, seconds, file, suite }) => [name, seconds, file, suite]), [
        ['selftest::backup restores', 31.25, undefined, 'selftests'],
        ['selftest::dns answers', 0.4, undefined, 'selftests'],
        ['selftest::unseals', 8, undefined, 'vault'],
        ['selftest::no time', null, undefined, 'selftests'],
        ['selftest::a time that is not one', null, undefined, 'selftests'],
        ['lint', 1.5, 'tools/lint.sh', undefined]
    ], 'the innermost suite, and none outside every suite')
    assert.equal(parseJUnit(NODE).cases[4].suite, 'scores')

    const dir = folder('timed')
    put(dir, 'selftests.xml', TIMED)
    const tests = readResults(dir)
    const slowest = [
        { name: 'selftest::backup restores', suite: 'selftests', seconds: 31.25 },
        { name: 'selftest::unseals', suite: 'vault', seconds: 8 },
        { name: 'lint', file: 'tools/lint.sh', seconds: 1.5 },
        { name: 'selftest::dns answers', suite: 'selftests', seconds: 0.4 }
    ]
    assert.deepEqual(tests.slowest, slowest, 'fewer than the bound: every test with a time, and none without one')
    assert.deepEqual(testsShown(tests).slowest, slowest, 'and the page, the editor and an agent are given them')

    const bulk = folder('timed-bulk')
    const cases = Array.from({ length: 30 }, (_, i) => `<testcase name="t${i}" time="${i % 15}"/>`).join('')
    put(bulk, 'bulk.xml', `<testsuite>${cases}</testsuite>`)
    const kept = readResults(bulk).slowest
    assert.equal(kept.length, SLOWEST)
    assert.deepEqual(kept.map((test) => test.name), ['t14', 't29', 't13', 't28', 't12', 't27', 't11', 't26', 't10', 't25'], 'of two as slow, the one read first')
})

test('the gate names the slowest few with their seconds and where they are; a quick suite, or one without times, names none', () => {
    const dir = folder('timed-said')
    put(dir, 'selftests.xml', TIMED)
    assert.deepEqual(slowestLines(readResults(dir)), [
        'slowest tests:',
        '   31s  selftest::backup restores  (selftests)',
        '  8.0s  selftest::unseals  (vault)',
        '  1.5s  lint  (tools/lint.sh)',
        '  0.4s  selftest::dns answers  (selftests)'
    ])
    const quick = folder('timed-quick')
    put(quick, 'pytest.xml', PYTEST)
    assert.deepEqual(slowestLines(readResults(quick)), [], 'its slowest took 0.003s')
    assert.deepEqual(slowestLines(testsShown({ files: 1, total: 1, passed: 1 })), [], 'a run recorded before times were kept')
    assert.deepEqual(slowestLines(null), [])
})

test('which tests grew: exactly where the earlier run kept the test, at least where it kept a full list without it, new where it kept every test', () => {
    const then = { slowest: [{ name: 'backup', suite: 'selftests', seconds: 5 }, { name: 'dns', suite: 'selftests', seconds: 1 }] }
    const now = {
        slowest: [
            { name: 'restore', suite: 'selftests', seconds: 50 },
            { name: 'backup', suite: 'selftests', seconds: 20 },
            { name: 'backup', suite: 'other', seconds: 6 },
            { name: 'dns', suite: 'selftests', seconds: 1.5 }
        ]
    }
    const grown = testsGrown(now, then)
    assert.deepEqual(grown, [
        { name: 'restore', suite: 'selftests', seconds: 50, was: 0, since: 'new' },
        { name: 'backup', suite: 'selftests', seconds: 20, was: 5, since: 'was' },
        { name: 'backup', suite: 'other', seconds: 6, was: 0, since: 'new' }
    ], 'most grown first; a test is its name in its suite; dns grew by under a second')
    assert.deepEqual(grown.map(grownSaid), ['new → 50s', '5.0s → 20s', 'new → 6.0s'])

    const full = { slowest: Array.from({ length: SLOWEST }, (_, i) => ({ name: `t${i}`, seconds: SLOWEST - i })) }
    const after = testsGrown({ slowest: [{ name: 'creeping', seconds: 30 }, { name: 't0', seconds: 10 }] }, full)
    assert.deepEqual(after, [{ name: 'creeping', seconds: 30, was: 1, since: 'at most' }], 't0 took as long as before')
    assert.equal(grownSaid(after[0]), 'at most 1.0s → 30s')

    const six = { slowest: Array.from({ length: 6 }, (_, i) => ({ name: `n${i}`, seconds: 10 + i })) }
    assert.equal(testsGrown(six, { slowest: [{ name: 'other', seconds: 1 }] }).length, 5, 'at most five are named')
    assert.deepEqual(testsGrown(now, null), [])
    assert.deepEqual(testsGrown({ slowest: [] }, then), [])
})

/** A passing run of tier 1 that took `seconds`, as a record holds it, `days` days into October. */
const pastRun = (days, seconds, extra = {}) => ({
    id: `2026-10-${String(days).padStart(2, '0')}T12-00-00Z-1-tier1`, kind: 'tier1', tier: 1, result: 'passed',
    startedAt: `2026-10-${String(days).padStart(2, '0')}T12:00:00.000Z`, durationSeconds: seconds, ...extra
})

test('a slow-down is a passing run twice the median of its tier\'s last ten passing runs, with five at least to go on', () => {
    const usual = [25, 24, 26, 25, 27].map((seconds, i) => pastRun(20 - i, seconds))
    const now = (seconds, extra = {}) => ({ ...pastRun(25, seconds), id: 'now', ...extra })
    assert.equal(slowdownOf(now(50), usual.slice(0, 4)), null, 'four runs are too few to say what is usual')
    assert.equal(slowdownOf(now(49), usual), null, 'under twice the median')
    const twice = slowdownOf(now(50), usual)
    assert.deepEqual({ ...twice, usual: twice.usual.id }, { seconds: 50, median: 25, runs: 5, ratio: 2, usual: usual[0].id, tests: [], steps: [] },
        'the usual run is the newest of those at the median')
    assert.equal(slowdownOf(now(500, { result: 'failed' }), usual), null, 'a failing run is said already')
    assert.equal(slowdownOf(now(5), [1, 1, 1, 1, 1].map((seconds, i) => pastRun(20 - i, seconds))), null, 'a quick gate is let off: four seconds more is noise')
    assert.ok(slowdownOf(now(6), [1, 1, 1, 1, 1].map((seconds, i) => pastRun(20 - i, seconds))), 'five seconds more is not')

    // Other tiers and failing runs are not compared with, and only the newest ten that are; the median of an even number
    // is between the middle two.
    const mixed = [
        pastRun(24, 300, { kind: 'tier2', tier: 2 }), pastRun(23, 300, { result: 'failed' }),
        ...[10, 10, 10, 10, 10, 30, 30, 30, 30, 30].map((seconds, i) => pastRun(22 - i, seconds)),
        ...[900, 900, 900].map((seconds, i) => pastRun(5 - i, seconds))
    ]
    const compared = slowdownOf(now(45), mixed)
    assert.deepEqual([compared.median, compared.runs], [20, 10])
    assert.equal(slowdownOf(now(39), mixed), null)

    // Once the slow runs are most of the ten, slow is what is usual and it is not said again.
    const slowNow = [...[1100, 1100, 1100, 1100, 1100, 1100].map((seconds, i) => pastRun(24 - i, seconds)), ...usual]
    assert.equal(slowdownOf(now(1100), slowNow), null)
    assert.equal(slowdownOf(now(1100), slowNow.slice(4)).median, 26, 'two slow runs in: still said')
    assert.equal(slowdownOf({ ...now(60), id: usual[0].id }, usual), null, 'a run is never compared with itself')
})

test('a slow-down names the tests that grew most and the steps, against the usual run, and says it does not fail', () => {
    // homelab's, as it went: about 25s on 11 Oct, about 1,100s on 25 Oct.
    const before = { files: 1, total: 3, passed: 3, slowest: [{ name: 'selftest::dns', suite: 'selftests', seconds: 12 }, { name: 'selftest::backup', suite: 'selftests', seconds: 0.4 }] }
    const steps = (lint, tests) => [{ what: 'linting', seconds: lint }, { what: 'running the self-tests', seconds: tests }]
    const history = [
        pastRun(24, 26),   // no JUnit then: not the run the tests are compared with
        ...[25, 24, 27, 25].map((seconds, i) => pastRun(23 - i, seconds, { tests: before, steps: steps(2, seconds - 2) })),
        pastRun(11, 25, { tests: before, steps: steps(2, 23) })
    ]
    const record = {
        ...pastRun(25, 1100), id: 'now', steps: steps(2.4, 1097.6),
        tests: { files: 1, total: 4, passed: 4, slowest: [{ name: 'selftest::backup', suite: 'selftests', seconds: 612 }, { name: 'selftest::restore', suite: 'selftests', seconds: 450 }, { name: 'selftest::dns', suite: 'selftests', seconds: 12.5 }] }
    }
    const slowdown = slowdownOf(record, history)
    assert.equal(slowdown.usual.id, history[1].id, 'nearest the median of those with times: 25s, the newest of three')
    assert.deepEqual(slowdown.steps, [{ what: 'running the self-tests', seconds: 1097.6, was: 23 }], 'linting grew by under a second')
    assert.deepEqual(slowdown.tests.map((test) => [test.name, test.since, test.was]), [['selftest::backup', 'was', 0.4], ['selftest::restore', 'new', 0]])
    assert.deepEqual(slowdownLines(slowdown, 1), [
        'slower than usual: this took 1,100s, 44 times the 25s that tier 1\'s last 6 passing runs here took at the median',
        '  steps that grew most, against a usual run (25s, 23 Oct):',
        '    23s → 1,098s  running the self-tests',
        '  tests that grew most:',
        '    0.4s → 612s  selftest::backup  (selftests)',
        '    new → 450s   selftest::restore  (selftests)',
        '  This does not fail verifying. A busy machine slows it too: if the next run is as slow, it is the project.'
    ])
    // One step is the whole run: naming it says nothing the first line did not.
    assert.deepEqual(slowdownOf({ ...record, steps: [{ what: 'running ./check', seconds: 1100 }] }, history).steps, [])
    assert.deepEqual(slowdownLines(null, 1), [])
    assert.deepEqual(Object.keys(SLOWDOWN), ['ratio', 'recent', 'least', 'seconds'])
})

// ---------------------------------------------------------------------------
// the gate
// ---------------------------------------------------------------------------

/**
 * A repository with lanes whose one gate step is `script`, run by sh in the checkout, and a lane of it with a commit;
 * `script` may be several steps instead, as `{ what: script }`.
 */
const project = (name, script, { ignore = '.env\n.lanekit/\n', parent = 'work' } = {}) => {
    const steps = typeof script === 'string'
        ? [{ what: 'running the tests', command: 'sh', args: ['-c', script] }]
        : Object.entries(script).map(([what, one]) => ({ what, command: 'sh', args: ['-c', one] }))
    const repo = path.join(scratch, parent, name)
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name, slug: name, integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'the tests', steps } } },
        lane: { portBase: 19801, portCeiling: 19899, copyOnCreate: [], linkOnCreate: [], env: { file: '.env', portKey: 'PORT', perLane: {} }, makeDirs: [], seed: [], provision: [] }
    }))
    fs.writeFileSync(path.join(repo, '.gitignore'), ignore)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-qm', 'Begin')
    const made = spawnSync(process.execPath, [path.join(KIT, 'dev', 'lane.mjs'), 'new', 'work'], { cwd: repo, env, encoding: 'utf8' })
    assert.equal(made.status, 0, made.stdout + made.stderr)
    const lane = path.join(scratch, parent, `${name}-work`)
    fs.writeFileSync(path.join(lane, 'change.txt'), 'a change\n')
    git(lane, 'add', '-A')
    git(lane, 'commit', '-qm', 'Change something')
    return { repo, lane }
}
const gate = (lane, extra = {}) => {
    const run = spawnSync(process.execPath, [path.join(KIT, 'dev', 'gate.mjs')], { cwd: lane, env: { ...env, ...extra }, encoding: 'utf8' })
    return { code: run.status, out: plain(`${run.stdout}${run.stderr}`) }
}
const newestRun = (repo) => {
    const dir = path.join(repo, '.lanekit', 'runs')
    const newest = fs.readdirSync(dir).sort().at(-1)
    return JSON.parse(fs.readFileSync(path.join(dir, newest), 'utf8'))
}

// Writes pytest's JUnit the first time and Go's after, each under a name of its own, so a count from both is a count
// from an earlier run; fails while either says a test failed, as a real check exits.
const WRITES_JUNIT = (pytest, go) => `
mkdir -p "$LAB_RESULTS"
echo "LAB_RESULTS is $LAB_RESULTS"
if [ -f ../written-once ]; then cp '${go}' "$LAB_RESULTS/go.xml"; else cp '${pytest}' "$LAB_RESULTS/pytest.xml"; touch ../written-once; fi
exit 1`

test('a gate gives its steps a folder of the lane\'s as LAB_RESULTS, says what its JUnit counts, and keeps it with the run', () => {
    put(scratch, 'fixtures/pytest.xml', PYTEST)
    put(scratch, 'fixtures/go.xml', GO)
    const { repo, lane } = project('counted', WRITES_JUNIT(path.join(scratch, 'fixtures/pytest.xml'), path.join(scratch, 'fixtures/go.xml')))
    const first = gate(lane)
    assert.equal(first.code, 1, 'the step\'s exit is the verdict')
    assert.match(first.out, new RegExp(`LAB_RESULTS is ${path.join(lane, '.lanekit', 'results').replaceAll('.', '\\.')}\\n`))
    assert.match(first.out, /\[verify +\d+s\] tests: 2 passed, 1 failed, 1 errored, 2 skipped\n {2}failed {3}tests\.test_scores::test_long_score_splits\n {2}errored {2}tests\.test_db::test_migrations\n/)
    assert.match(first.out, /FAILED/)
    const record = newestRun(repo)
    assert.equal(record.result, 'failed')
    assert.deepEqual([record.tests.passed, record.tests.failed, record.tests.errored, record.tests.skipped, record.tests.files], [2, 1, 1, 2, 1])
    assert.equal(git(lane, 'status', '--porcelain'), '', 'the results leave the tree clean, so the next gate is not refused')

    const second = gate(lane)
    assert.match(second.out, /tests: 1 passed, 1 failed, 1 errored, 1 skipped\n/, 'only the second run\'s file: the first\'s was cleared')
    assert.deepEqual(fs.readdirSync(path.join(lane, '.lanekit', 'results')), ['go.xml'])
})

test('a gate uses the LAB_RESULTS the environment names, removes nothing from it, and reads only what the run wrote there', () => {
    put(scratch, 'fixtures/pytest.xml', PYTEST)
    const { repo, lane } = project('named', `cp '${path.join(scratch, 'fixtures/pytest.xml')}' "$LAB_RESULTS/pytest.xml"; echo "LAB_RESULTS is $LAB_RESULTS"`)
    const named = folder('named-by-ci')
    put(named, 'stale.xml', GO)
    put(named, 'somebody.txt', 'kept')
    const run = gate(lane, { LAB_RESULTS: named })
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, new RegExp(`LAB_RESULTS is ${named.replaceAll('.', '\\.')}\\n`))
    assert.match(run.out, /tests: 2 passed, 1 failed, 1 errored, 2 skipped\n/, 'pytest\'s, written by this run; not the stale Go file')
    assert.match(run.out, /VERIFIED/, 'JUnit that names failures does not fail a gate whose steps passed')
    assert.deepEqual(fs.readdirSync(named).sort(), ['pytest.xml', 'somebody.txt', 'stale.xml'])
    assert.equal(fs.existsSync(path.join(lane, '.lanekit', 'results')), false)
    assert.equal(newestRun(repo).result, 'passed')
})

test('a project that writes no JUnit is reported exactly as before: no word of tests, and no tests in its record', () => {
    const { repo, lane } = project('quiet', 'echo "checked: LAB_RESULTS=${LAB_RESULTS:+set}"')
    const run = gate(lane)
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /checked: LAB_RESULTS=set/, 'the folder is still given')
    assert.doesNotMatch(run.out, /tests:|XML|JUnit/)
    const lines = run.out.split('\n')
    const step = lines.findIndex((line) => /running the tests…/.test(line))
    assert.equal(lines[step + 1], 'checked: LAB_RESULTS=set')
    assert.match(lines[step + 2], /recording the result…$/, 'then the result is written down')
    assert.equal(lines[step + 3], '', 'and the banner follows it')
    assert.match(lines[step + 5], /VERIFIED/)
    const record = newestRun(repo)
    assert.equal('tests' in record, false)
    // As before but for each step's seconds, which every run keeps since 25 Oct 2026.
    assert.deepEqual(Object.keys(record), ['id', 'kind', 'tier', 'branch', 'sha', 'worktree', 'result', 'narrowed', 'earned', 'why', 'files', 'startedAt', 'durationSeconds', 'steps', 'failures'])
    assert.deepEqual(record.steps.map((step) => step.what), ['running the tests'])
    assert.ok(Number.isFinite(record.steps[0].seconds))
})

test('malformed JUnit is said once and never fails a gate whose steps passed', () => {
    const { lane } = project('garbled', 'printf "<testsuites><testsuite><testcase name=x>" > "$LAB_RESULTS/broken.xml"')
    const run = gate(lane)
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /VERIFIED/)
    const said = run.out.split('\n').filter((line) => /broken\.xml/.test(line))
    assert.deepEqual(said.map((line) => line.replace(/^\[verify +\d+s\] /, '')), ['1 XML file the tests wrote could not be read, so it is not counted: broken.xml (a tag is not well formed, at line 1)'])
})

test('where git does not ignore .lanekit/, the results go in the lane\'s own git directory, and the tree stays clean', () => {
    put(scratch, 'fixtures/go.xml', GO)
    const { lane } = project('unignored', `cp '${path.join(scratch, 'fixtures/go.xml')}' "$LAB_RESULTS/go.xml"; echo "LAB_RESULTS is $LAB_RESULTS"`, { ignore: '.env\n.lanekit/runs/\n' })
    const where = resultsFolderFor(lane, {})
    assert.equal(where.own, true)
    assert.equal(where.dir, path.join(git(lane, 'rev-parse', '--absolute-git-dir'), 'lanekit-results'))
    const run = gate(lane)
    assert.match(run.out, /tests: 1 passed, 1 failed, 1 errored, 1 skipped/)
    assert.match(run.out, /LAB_RESULTS is .*\/\.git\/worktrees\/unignored-work\/lanekit-results\n/)
    assert.equal(git(lane, 'status', '--porcelain'), '')
    assert.match(gate(lane).out, /VERIFIED/, 'and the next gate is not refused for a dirty tree')
})

test('a .lanekit that is a link is not followed: the gate empties only a folder of the lane\'s own', () => {
    const { lane } = project('linked', 'echo "LAB_RESULTS is $LAB_RESULTS"; touch "$LAB_RESULTS/x.xml"', { ignore: '.env\n.lanekit\n' })
    const elsewhere = folder('elsewhere')
    put(elsewhere, 'results/keep.txt', 'not the gate\'s to remove')
    fs.symlinkSync(elsewhere, path.join(lane, '.lanekit'))
    const run = gate(lane)
    assert.match(run.out, /LAB_RESULTS is .*\/\.git\/worktrees\/linked-work\/lanekit-results\n/)
    assert.deepEqual(fs.readdirSync(path.join(elsewhere, 'results')), ['keep.txt'])
})

test('a gate keeps each step\'s seconds, says them where there are several, and names the slowest tests', () => {
    put(scratch, 'fixtures/selftests.xml', TIMED)
    const { repo, lane } = project('stepped', { building: 'sleep 1', 'running the self-tests': `cp '${path.join(scratch, 'fixtures/selftests.xml')}' "$LAB_RESULTS/selftests.xml"` })
    const run = gate(lane)
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /\[verify +\d+s\] the steps took \d\.\ds building, \d\.\ds running the self-tests\n/)
    assert.match(run.out, /\[verify +\d+s\] tests: 6 passed\n\[verify +\d+s\] slowest tests:\n {3}31s {2}selftest::backup restores {2}\(selftests\)\n {2}8\.0s {2}selftest::unseals {2}\(vault\)\n/)
    assert.doesNotMatch(run.out, /slower than usual/, 'no runs before it to be slower than')
    const record = newestRun(repo)
    assert.deepEqual(record.steps.map((step) => step.what), ['building', 'running the self-tests'])
    assert.ok(record.steps[0].seconds >= 1 && record.steps[0].seconds < record.durationSeconds + 1, JSON.stringify(record.steps))
    assert.equal(record.tests.slowest[0].name, 'selftest::backup restores')
    assert.equal('slowdown' in record, false)
})

test('a gate much slower than its tier\'s recent passing runs says so, names what grew, keeps it with the run, and still passes', () => {
    put(scratch, 'fixtures/selftests.xml', TIMED)
    const { repo, lane } = project('slowed', { building: 'true', 'running the self-tests': `sleep 7; cp '${path.join(scratch, 'fixtures/selftests.xml')}' "$LAB_RESULTS/selftests.xml"` })
    // Five quick runs before it, as other lanes' gates would have left them; dated long ago, so they sort before it.
    const runs = path.join(repo, '.lanekit', 'runs')
    fs.mkdirSync(runs, { recursive: true })
    for (let day = 1; day <= 5; day++) {
        const id = `2000-01-0${day}T12-00-00Z-1-tier1`
        fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({
            id, kind: 'tier1', tier: 1, branch: 'earlier', result: 'passed', startedAt: `2000-01-0${day}T12:00:00.000Z`, durationSeconds: 1,
            steps: [{ what: 'building', seconds: 0.1 }, { what: 'running the self-tests', seconds: 0.6 }],
            tests: { files: 1, total: 4, passed: 4, slowest: [{ name: 'selftest::backup restores', suite: 'selftests', seconds: 0.4 }, { name: 'lint', file: 'tools/lint.sh', seconds: 0.3 }] }
        }))
    }
    const run = gate(lane)
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /\[verify +\d+s\] slower than usual: this took [\d.]+s, [\d.]+ times the 1\.0s that tier 1's last 5 passing runs here took at the median\n/)
    assert.match(run.out, / {2}steps that grew most, against a usual run \(1\.0s, 5 Jan\):\n {4}0\.6s → \d\.\ds {2}running the self-tests\n/)
    assert.match(run.out, / {2}tests that grew most:\n {4}0\.4s → 31s {3}selftest::backup restores {2}\(selftests\)\n {4}new → 8\.0s {3}selftest::unseals {2}\(vault\)\n {4}0\.3s → 1\.5s {2}lint {2}\(tools\/lint\.sh\)\n/,
        'unseals is new: the usual run kept fewer than ten, so every test it timed')
    assert.match(run.out, / {2}This does not fail verifying\..*\n\[verify +\d+s\] recording the result…\n/)
    assert.match(run.out, /VERIFIED/)
    const { slowdown } = newestRun(repo)
    assert.deepEqual([slowdown.median, slowdown.runs, slowdown.usual.id], [1, 5, '2000-01-05T12-00-00Z-1-tier1'])
    assert.ok(slowdown.seconds >= 7 && slowdown.ratio >= 7, JSON.stringify(slowdown))
    assert.deepEqual(slowdown.tests.map((test) => [test.name, test.since]), [['selftest::backup restores', 'was'], ['selftest::unseals', 'new'], ['lint', 'was']])
    assert.deepEqual(slowdown.steps.map((step) => step.what), ['running the self-tests'])
})

test('lanekit\'s ./check runs node --test as before without LAB_RESULTS, and with it writes JUnit there too, hiding it from the tests', () => {
    const kit = folder('check-kit')
    fs.copyFileSync(path.join(KIT, 'check'), path.join(kit, 'check'))
    put(kit, 'test/alone.test.mjs', `import assert from 'node:assert/strict'
import { test } from 'node:test'
test('the tests are not given the folder', () => { assert.equal(process.env.LAB_RESULTS, undefined) })
`)
    // A node --test of its own, not a child of this one's.
    const clean = { ...env }
    delete clean.NODE_TEST_CONTEXT
    const said = (out) => out.replace(/duration_ms:? [\d.]+/g, 'duration_ms N')
    const direct = spawnSync(process.execPath, ['--test'], { cwd: kit, env: clean, encoding: 'utf8' })
    const before = spawnSync(path.join(kit, 'check'), [], { cwd: scratch, env: clean, encoding: 'utf8' })
    assert.equal(before.status, 0, before.stdout + before.stderr)
    assert.equal(said(before.stdout), said(direct.stdout), 'exactly node --test\'s own output')
    assert.deepEqual(fs.readdirSync(kit).sort(), ['check', 'test'])

    const named = spawnSync(path.join(kit, 'check'), [], { cwd: scratch, env: { ...clean, LAB_RESULTS: 'check-results' }, encoding: 'utf8' })
    assert.equal(named.status, 0, named.stdout + named.stderr)
    assert.equal(said(named.stdout), said(direct.stdout), 'the console output is as it was: TAP, into a pipe')
    const tests = readResults(path.join(scratch, 'check-results'))
    assert.equal(countsSaid(tests), '1 passed', 'a relative LAB_RESULTS is taken from where ./check was run')
    assert.deepEqual(fs.readdirSync(path.join(scratch, 'check-results')), ['lanekit.xml'])
})

// ---------------------------------------------------------------------------
// what the page, the editor and an agent are told
// ---------------------------------------------------------------------------

test('the service tells a finished gate\'s job its tests, and the page\'s state has them with the lane\'s gate', async () => {
    put(scratch, 'fixtures/pytest.xml', PYTEST)
    const { repo } = project('served', `cp '${path.join(scratch, 'fixtures/pytest.xml')}' "$LAB_RESULTS/pytest.xml"; exit 1`, { parent: 'served' })
    const service = createService({ dirs: [path.dirname(repo)] })
    try {
        await service.state()
        const pressed = await service.press({ repo: 'served', verb: 'gate', lane: 'work' })
        assert.equal(pressed.status, 202, JSON.stringify(pressed.body))
        const done = await new Promise((resolve) => service.events.on('done', (job) => { if (job.id === pressed.body.id) resolve(job) }))
        assert.equal(done.code, 1)
        assert.equal(done.tests.said, '2 passed, 1 failed, 1 errored, 2 skipped')
        assert.deepEqual(done.tests.failing.map((one) => one.outcome), ['failed', 'errored'])
        assert.equal(done.tests.more, 0)
        const read = (await service.state()).repos.find((one) => one.id === 'served').lanes.find((one) => one.name === 'work')
        assert.equal(read.gate.result, 'failed')
        assert.equal(read.gate.tests.said, '2 passed, 1 failed, 1 errored, 2 skipped')
        assert.equal(read.gate.tests.failing[0].name, 'tests.test_scores::test_long_score_splits')
    } finally {
        service.dispose()
    }
})

test('a gate that wrote no JUnit, or never ran its steps, tells its job nothing of tests', async () => {
    const { repo, lane } = project('unsaid', 'true', { parent: 'unsaid' })
    const service = createService({ dirs: [path.dirname(repo)] })
    try {
        await service.state()
        const finish = async () => {
            const pressed = await service.press({ repo: 'unsaid', verb: 'gate', lane: 'work' })
            return new Promise((resolve) => service.events.on('done', (job) => { if (job.id === pressed.body.id) resolve(job) }))
        }
        const passed = await finish()
        assert.equal(passed.code, 0)
        assert.equal('tests' in passed, false)
        // A dirty tree is refused before anything runs, and writes no run: an older run's tests are not this one's.
        fs.writeFileSync(path.join(lane, 'loose.txt'), 'loose\n')
        const refused = await finish()
        assert.notEqual(refused.code, 0)
        assert.equal('tests' in refused, false)
    } finally {
        service.dispose()
    }
})

test('the MCP server\'s gate tool says the counts and the tests that did not pass, before the output', async () => {
    put(scratch, 'fixtures/pytest.xml', PYTEST)
    const { repo } = project('agent', `cp '${path.join(scratch, 'fixtures/pytest.xml')}' "$LAB_RESULTS/pytest.xml"; exit 1`, { parent: 'agent' })
    const server = spawn(process.execPath, [path.join(KIT, 'bin', 'mcp.mjs')], { cwd: os.tmpdir(), env: { ...env, LANEKIT_PROJECT: repo }, stdio: ['pipe', 'pipe', 'inherit'] })
    const waiting = new Map()
    readline.createInterface({ input: server.stdout }).on('line', (line) => {
        const message = JSON.parse(line)
        waiting.get(message.id)?.(message)
    })
    let next = 0
    const ask = (method, params) => new Promise((resolve) => {
        const id = ++next
        waiting.set(id, resolve)
        server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
    try {
        await ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
        const answer = await ask('tools/call', { name: 'gate', arguments: { lane: 'work' } })
        const text = answer.result.content.map((part) => part.text).join('\n')
        assert.equal(answer.result.isError, true)
        assert.match(text, /^It failed \(exit 1\)\.\nTests: 2 passed, 1 failed, 1 errored, 2 skipped\n {2}failed {3}tests\.test_scores::test_long_score_splits\n {2}errored {2}tests\.test_db::test_migrations\n\n\$ node dev\/gate\.mjs\n/)
    } finally {
        server.stdin.end()
    }
})

test('the page\'s state has a verification\'s steps and its slow-down with the lane\'s gate, in a shape it can draw; none for a run from before', () => {
    const { repo, lane } = project('timed', 'true', { parent: 'timed' })
    const runs = path.join(repo, '.lanekit', 'runs')
    fs.mkdirSync(runs, { recursive: true })
    const sha = git(lane, 'rev-parse', 'HEAD')
    const record = (id, extra) => fs.writeFileSync(path.join(runs, `${id}.json`), JSON.stringify({
        id, kind: 'tier1', tier: 1, branch: 'work', sha, worktree: lane, result: 'passed', narrowed: false, earned: 1,
        startedAt: '2026-10-25T12:00:00.000Z', durationSeconds: 1100, failures: [], ...extra
    }))
    record('2026-10-25T12-00-00Z-1-tier1', {})
    const before = repoState(repo).lanes.find((one) => one.name === 'work').gate
    assert.equal(before.result, 'passed')
    assert.equal('steps' in before, false, 'a run from before reads as it always has')
    assert.equal('slowdown' in before, false)
    record('2026-10-25T12-00-01Z-1-tier1', {
        steps: [{ what: 'building', seconds: 90 }, { what: 'running the self-tests', seconds: 1010 }],
        tests: { files: 1, total: 4, passed: 4, failed: 0, errored: 0, skipped: 0, failing: [], slowest: [{ name: 'selftest::backup', suite: 'selftests', seconds: 612 }] },
        slowdown: {
            seconds: 1100, median: 250, runs: 10, ratio: 4.4, usual: { id: 'usual', seconds: 248, startedAt: '2026-10-11T03:00:00.000Z' },
            tests: [{ name: 'selftest::backup', suite: 'selftests', seconds: 612, was: 0.4, since: 'was' }, { name: 'selftest::vault', seconds: 41, was: 0, since: 'new' }],
            steps: [{ what: 'running the self-tests', seconds: 1010, was: 160 }]
        }
    })
    const gate = repoState(repo).lanes.find((one) => one.name === 'work').gate
    assert.deepEqual(gate.steps, [{ what: 'building', seconds: 90 }, { what: 'running the self-tests', seconds: 1010 }])
    assert.deepEqual(gate.tests.slowest, [{ name: 'selftest::backup', suite: 'selftests', seconds: 612 }])
    assert.deepEqual(gate.slowdown, {
        seconds: 1100, median: 250, runs: 10, ratio: 4.4, usual: { id: 'usual', seconds: 248, at: Date.parse('2026-10-11T03:00:00.000Z') },
        steps: [{ what: 'running the self-tests', seconds: 1010, was: 160 }],
        tests: [{ name: 'selftest::backup', suite: 'selftests', seconds: 612, was: 0.4, since: 'was' }, { name: 'selftest::vault', seconds: 41, was: 0, since: 'new' }]
    })
})
