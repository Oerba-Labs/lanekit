/**
 * What a gate's tests said, read from the JUnit XML they wrote into $LAB_RESULTS (lib/results.mjs): the reader on its
 * own, on files in the shapes pytest, `node --test` and go-junit-report write, several at once, none, malformed ones
 * and huge ones; then the gate itself on scratch repositories, giving its steps the folder, emptying its own and
 * leaving the environment's alone, saying the counts and the tests that failed, and changing nothing for a project
 * that writes no JUnit; and what the service, the page's state and the MCP server's gate tool are told.
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

import { countsSaid, LIMITS, parseJUnit, prepareResults, readResults, resultsFolderFor, testsLines, testsShown } from '../lib/results.mjs'
import { createService } from '../lib/service.mjs'

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
// the gate
// ---------------------------------------------------------------------------

/** A repository with lanes whose one gate step is `script`, run by sh in the checkout, and a lane of it with a commit. */
const project = (name, script, { ignore = '.env\n.lanekit/\n', parent = 'work' } = {}) => {
    const repo = path.join(scratch, parent, name)
    fs.mkdirSync(repo, { recursive: true })
    fs.writeFileSync(path.join(repo, 'lane.config.json'), JSON.stringify({
        name, slug: name, integrationBranch: 'main', roots: {},
        gate: { sides: {}, seam: [], generated: [], tiers: { 1: { label: 'the tests', steps: [{ what: 'running the tests', command: 'sh', args: ['-c', script] }] } } },
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
    assert.match(first.out, /\[gate +\d+s\] tests: 2 passed, 1 failed, 1 errored, 2 skipped\n {2}failed {3}tests\.test_scores::test_long_score_splits\n {2}errored {2}tests\.test_db::test_migrations\n/)
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
    assert.equal(lines[step + 2], '', 'the banner follows the step as it always has')
    assert.match(lines[step + 4], /VERIFIED/)
    const record = newestRun(repo)
    assert.equal('tests' in record, false)
    assert.deepEqual(Object.keys(record), ['id', 'kind', 'tier', 'branch', 'sha', 'worktree', 'result', 'narrowed', 'earned', 'why', 'files', 'startedAt', 'durationSeconds', 'failures'])
})

test('malformed JUnit is said once and never fails a gate whose steps passed', () => {
    const { lane } = project('garbled', 'printf "<testsuites><testsuite><testcase name=x>" > "$LAB_RESULTS/broken.xml"')
    const run = gate(lane)
    assert.equal(run.code, 0, run.out)
    assert.match(run.out, /VERIFIED/)
    const said = run.out.split('\n').filter((line) => /broken\.xml/.test(line))
    assert.deepEqual(said.map((line) => line.replace(/^\[gate +\d+s\] /, '')), ['1 XML file the tests wrote could not be read, so it is not counted: broken.xml (a tag is not well formed, at line 1)'])
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
