/**
 * What a gate's tests said, read from the JUnit XML they left in `$LAB_RESULTS`.
 *
 * THE CONVENTION. A gate's steps are given `LAB_RESULTS`, the path of a folder, and a test runner that can write JUnit
 * XML (pytest's `--junitxml`, `node --test`'s junit reporter, Go's through go-junit-report, Jest's, Xcode's) may write
 * it there, in any number of files and folders. Afterwards the gate reads them and says how many passed, failed, were
 * skipped and errored, and names the first few that did not pass. Nothing else is asked of a project: one whose tests
 * write no JUnit is reported exactly as before, and one that writes it needs no setting to be heard.
 *
 * WHO CHOOSES THE FOLDER. Whoever runs the tests: the folder is theirs to make and to read, and a project's own check
 * only writes where it is told. The gate chooses one of the lane's own (`resultsFolderFor`) unless the environment it
 * was started in names one already, as a CI job may.
 *
 * NEVER FROM AN EARLIER RUN. A folder the gate chose is emptied before the steps run. One the environment named is
 * somebody else's, so nothing in it is removed: it is looked at before the steps, and only what they wrote or rewrote
 * is read afterwards.
 *
 * THE EXIT CODE IS THE VERDICT. The counts say what the tests said; they never pass or fail a gate. A step that exits
 * 0 while its JUnit names a failure still passes, and the counts say so beside it. A file that cannot be read is said
 * once, plainly, and its tests are not counted, rather than counted from as far as it went.
 *
 * NO DEPENDENCY, SO A SMALL READER. Node has no XML parser of its own and lanekit takes no dependency, so this reads
 * the part of XML that JUnit uses: elements and their attributes, comments, CDATA, the declaration. A file that is not
 * well formed by those rules (cut short, a tag closed by another's name, two roots, text outside the root) is said to
 * be unreadable. A DOCTYPE is refused, so nothing in a file expands into anything else; entities other than XML's own
 * five and character references are left as they are written.
 *
 * BOUNDED. At most LIMITS.files files, LIMITS.depth folders down, LIMITS.fileBytes in one file and LIMITS.totalBytes in
 * all. A file past a bound is not read at all (its size is asked first, and the read itself stops at the bound in case
 * it grew), and is said like a malformed one. Symbolic links are not followed.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const LIMITS = { files: 200, depth: 4, fileBytes: 32 * 1024 * 1024, totalBytes: 128 * 1024 * 1024 }
/** How many tests that did not pass are named: a handful, then "and N more". */
export const NAMED = 5
/**
 * How many of the slowest tests a run keeps, and how many of those the gate shows. Kept: enough that a test which grows
 * from the tenth slowest to the first is still found in the run it is compared with (lib/runs.mjs, slowdownOf); shown:
 * a handful, as the failing are.
 */
export const SLOWEST = 10
const SLOWEST_SHOWN = 5
/** Under a second, the slowest test is not where a gate's time went, and naming it is noise. */
const SLOW_ENOUGH = 1
const NAME_MOST = 200
const UNREAD_NAMED = 3

// ---------------------------------------------------------------------------
// the folder
// ---------------------------------------------------------------------------

/**
 * The folder a gate of `checkout` gives its steps as LAB_RESULTS: `{ dir, own }`. `own` is true when the gate chose
 * it, and may empty it.
 *
 * The environment's, where it names one (a relative path is taken from the checkout). Otherwise `.lanekit/results/`
 * in the checkout, which `lane adopt` and `lane init` have git ignore, so a file written there never makes the tree
 * dirty, which the next gate would refuse. Where git does not ignore it, or `.lanekit` there is not a plain folder
 * (a link would have the gate empty a folder somewhere else), the checkout's own git directory instead
 * (`.git/worktrees/<lane>/lanekit-results` for a lane), which is the lane's and goes when the lane does.
 */
export const resultsFolderFor = (checkout, env = process.env) => {
    const named = env.LAB_RESULTS
    if (named) return { dir: path.resolve(checkout, named), own: false }
    const inside = path.join(checkout, '.lanekit', 'results')
    const plainFolders = [path.join(checkout, '.lanekit'), inside].every((dir) => {
        try { return fs.lstatSync(dir).isDirectory() } catch (error) { return error.code === 'ENOENT' }
    })
    const ignored = plainFolders && spawnSync('git', ['check-ignore', '-q', path.join('.lanekit', 'results', 'junit.xml')], { cwd: checkout }).status === 0
    if (ignored) return { dir: inside, own: true }
    const gitDir = spawnSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: checkout, encoding: 'utf8' })
    if (gitDir.status === 0 && gitDir.stdout.trim()) return { dir: path.join(gitDir.stdout.trim(), 'lanekit-results'), own: true }
    throw new Error(`${checkout} is not a git checkout, so verifying has no folder of its own for the tests' JUnit`)
}

/**
 * Ready a folder for a run, and say what was in it before: an empty folder of the gate's own, or one of somebody
 * else's looked at and left alone. What it returns is what `readResults` is handed afterwards as `before`.
 */
export const prepareResults = ({ dir, own }, limits = LIMITS) => {
    if (own) {
        fs.rmSync(dir, { recursive: true, force: true })
        fs.mkdirSync(dir, { recursive: true })
        return null
    }
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* the steps will say, or write nowhere */ }
    const before = new Map()
    for (const file of xmlFilesIn(dir, limits).found) before.set(file.rel, signature(file.stat))
    return before
}

const signature = (stat) => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`

/**
 * Every `.xml` file under `dir`, in a stable order (by path), at most `limits.files` of them and `limits.depth` folders
 * down; symbolic links are passed over. `{ found: [{ rel, abs, stat }], beyond }`, `beyond` the number left unlisted.
 */
const xmlFilesIn = (dir, limits) => {
    const found = []
    let beyond = 0
    const walk = (at, rel, depth) => {
        let entries
        try { entries = fs.readdirSync(at, { withFileTypes: true }) } catch { return }
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
        for (const entry of entries) {
            const abs = path.join(at, entry.name)
            const relative = rel ? `${rel}/${entry.name}` : entry.name
            if (entry.isSymbolicLink()) continue
            if (entry.isDirectory()) {
                if (depth < limits.depth) walk(abs, relative, depth + 1)
                continue
            }
            if (!entry.isFile() || !/\.xml$/i.test(entry.name)) continue
            if (found.length >= limits.files) { beyond++; continue }
            let stat
            try { stat = fs.lstatSync(abs) } catch { continue }
            found.push({ rel: relative, abs, stat })
        }
    }
    walk(dir, '', 0)
    return { found, beyond }
}

// ---------------------------------------------------------------------------
// reading JUnit
// ---------------------------------------------------------------------------

class Unreadable extends Error {}

const NAME = '[A-Za-z_:][-A-Za-z0-9_:.]*'
const START_TAG = new RegExp(`<(${NAME})((?:\\s+${NAME}\\s*=\\s*(?:"[^"<]*"|'[^'<]*'))*)\\s*(/?)>`, 'y')
const END_TAG = new RegExp(`</(${NAME})\\s*>`, 'y')
const ATTRIBUTE = new RegExp(`(${NAME})\\s*=\\s*(?:"([^"<]*)"|'([^'<]*)')`, 'g')
const ENTITY = /&(?:#(\d+)|#x([0-9A-Fa-f]+)|(lt|gt|amp|quot|apos));/g
const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

const decode = (value) => value.replace(ENTITY, (whole, decimal, hex, named) => {
    if (named) return NAMED_ENTITIES[named]
    const code = decimal ? Number(decimal) : parseInt(hex, 16)
    try { return String.fromCodePoint(code) } catch { return whole }
})
const attributesOf = (text) => {
    const found = {}
    for (const match of text.matchAll(ATTRIBUTE)) found[match[1]] = decode(match[2] ?? match[3] ?? '')
    return found
}

const clipped = (text) => (text.length > NAME_MOST ? `${text.slice(0, NAME_MOST - 1)}…` : text)

/**
 * A testcase's `time`, in seconds as every reporter here writes it (pytest's "0.120", node's "0.000394", Go's "0.004"),
 * kept to the millisecond; null where it is missing or is not a time (negative, "NaN", "1e999"), so such a test is
 * never the slowest by accident.
 */
const secondsIn = (time) => {
    if (time === undefined || !/^\s*[0-9.eE+-]+\s*$/.test(time)) return null
    const seconds = Number(time)
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) / 1000 : null
}

/** What a test came to, from what its testcase holds: the worst of failure, error and skipped, else passed. */
const OUTCOMES = { failure: 'failed', error: 'errored', skipped: 'skipped' }
const RANK = { passed: 0, skipped: 1, errored: 2, failed: 3 }

/**
 * One file's JUnit: `{ junit, cases: [{ name, outcome, seconds, file?, suite? }] }`: `seconds` from the testcase's `time`
 * (null without one), `file` from its own `file` where the reporter writes one (pytest's with junit_family=xunit1,
 * Jest's), and `suite` the innermost testsuite around it that has a name; `junit` false for well-formed XML that is not JUnit (its
 * root is neither testsuites nor testsuite: a coverage report, say), which is passed over. Throws Unreadable, with
 * why, for anything not well formed.
 */
export const parseJUnit = (text) => {
    const lineAt = (offset) => text.slice(0, offset).split('\n').length
    const unreadable = (why, offset) => { throw new Unreadable(offset === undefined ? why : `${why}, at line ${lineAt(offset)}`) }
    const stack = []
    const suites = [] // the names of the testsuites the reader is inside, innermost last
    const cases = []
    let root = null
    let open = null   // the testcase being read: { name, outcome, seconds, file?, suite?, depth }
    let at = text.charCodeAt(0) === 0xfeff ? 1 : 0
    while (at < text.length) {
        const lt = text.indexOf('<', at)
        const end = lt === -1 ? text.length : lt
        if (!stack.length && end > at && /\S/.test(text.slice(at, end))) unreadable(root ? 'it has text after its root element' : 'it has text before its first element', at)
        if (lt === -1) break
        if (text.startsWith('<!--', lt)) {
            const close = text.indexOf('-->', lt + 4)
            if (close === -1) unreadable('a comment never ends', lt)
            at = close + 3
        } else if (text.startsWith('<![CDATA[', lt)) {
            if (!stack.length) unreadable('it has CDATA outside its root element', lt)
            const close = text.indexOf(']]>', lt + 9)
            if (close === -1) unreadable('a CDATA section never ends', lt)
            at = close + 3
        } else if (text.startsWith('<?', lt)) {
            const close = text.indexOf('?>', lt + 2)
            if (close === -1) unreadable('a processing instruction never ends', lt)
            at = close + 2
        } else if (text.startsWith('<!', lt)) {
            unreadable(/^<!DOCTYPE/i.test(text.slice(lt, lt + 9)) ? 'it has a DOCTYPE, which LaneKit does not read' : 'it has a declaration LaneKit does not read', lt)
        } else if (text[lt + 1] === '/') {
            END_TAG.lastIndex = lt
            const tag = END_TAG.exec(text)
            if (!tag) unreadable('a closing tag is not well formed', lt)
            const expected = stack.pop()
            if (expected === undefined) unreadable(`</${tag[1]}> closes nothing`, lt)
            if (expected !== tag[1]) unreadable(`</${tag[1]}> closes <${expected}>`, lt)
            if (open && expected === 'testcase' && stack.length === open.depth) { cases.push(open); open = null }
            if (expected === 'testsuite') suites.pop()
            at = END_TAG.lastIndex
        } else {
            START_TAG.lastIndex = lt
            const tag = START_TAG.exec(text)
            if (!tag) unreadable('a tag is not well formed', lt)
            const [, name, attributes, empty] = tag
            if (!stack.length && root !== null) unreadable('it has more than one root element', lt)
            if (root === null) root = name
            if (name === 'testsuite' && !empty) suites.push(attributesOf(attributes).name ?? '')
            if (name === 'testcase' && !open) {
                const { name: test, classname, time, file } = attributesOf(attributes)
                const named = classname && test ? `${classname}::${test}` : test || classname || '(a test with no name)'
                const suite = suites.findLast(Boolean)
                open = {
                    name: clipped(named), outcome: 'passed', seconds: secondsIn(time),
                    ...(file ? { file: clipped(file) } : {}), ...(suite ? { suite: clipped(suite) } : {}),
                    depth: stack.length
                }
                if (empty) { cases.push(open); open = null }
            } else if (open && OUTCOMES[name] && stack.length === open.depth + 1) {
                if (RANK[OUTCOMES[name]] > RANK[open.outcome]) open.outcome = OUTCOMES[name]
            }
            if (!empty) stack.push(name)
            at = START_TAG.lastIndex
        }
    }
    if (stack.length) unreadable(`it ends inside <${stack.at(-1)}>`)
    if (root === null) unreadable(text.trim() ? 'it holds no element' : 'it is empty')
    return { junit: root === 'testsuites' || root === 'testsuite', cases }
}

/** A bounded read: the file's bytes, or null where it holds more than `most` (it grew since its size was asked). */
const CHUNK = 1024 * 1024
const readAtMost = (file, most) => {
    const fd = fs.openSync(file, 'r')
    try {
        const chunks = []
        let length = 0
        for (;;) {
            const chunk = Buffer.alloc(Math.min(CHUNK, most + 1 - length))
            const read = fs.readSync(fd, chunk, 0, chunk.length, null)
            if (!read) break
            chunks.push(read === chunk.length ? chunk : chunk.subarray(0, read))
            length += read
            if (length > most) return null
        }
        return Buffer.concat(chunks, length)
    } finally {
        fs.closeSync(fd)
    }
}

/** A size as a person reads it: 900 bytes, 12 KB, 3.5 MB, 40 MB. */
const sizeOf = (bytes) => {
    if (bytes < 1024) return `${bytes} bytes`
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
    const mb = bytes / (1024 * 1024)
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/**
 * Keep `test` among `slowest`, the SLOWEST slowest timed tests so far, slowest first; of two as slow, the one read
 * first. A list this short is cheaper to insert into than a heap, and a run of 100,000 tests passes through it.
 */
const keepIfSlow = (slowest, test) => {
    if (test.seconds === null) return
    if (slowest.length >= SLOWEST && test.seconds <= slowest.at(-1).seconds) return
    const at = slowest.findIndex((kept) => test.seconds > kept.seconds)
    const { name, file, suite, seconds } = test
    slowest.splice(at === -1 ? slowest.length : at, 0, { name, ...(file ? { file } : {}), ...(suite ? { suite } : {}), seconds })
    if (slowest.length > SLOWEST) slowest.pop()
}

/**
 * What the JUnit in `dir` says, or null where there is none to read (no XML file at all, or none the run wrote, or
 * only XML that is not JUnit): then the gate says nothing it did not say before.
 *
 *   `{ dir, files, total, passed, failed, errored, skipped, failing: [{ name, outcome }], unreadable: [{ file, why }],
 *      slowest: [{ name, file?, suite?, seconds }], notRead }`: `files` the JUnit files counted, `failing` the first
 *      NAMED tests that failed or errored, in file order, `slowest` the SLOWEST that took longest by their `time`
 *      (fewer only where fewer tests had one: then it holds every timed test), `unreadable` the files that could not be read and why, `notRead` the files past LIMITS.files.
 *
 * `before`, from prepareResults: files that are as they were then are not this run's, and are passed over.
 */
export const readResults = (dir, { before = null, limits = LIMITS } = {}) => {
    const { found, beyond } = xmlFilesIn(dir, limits)
    const result = { dir, files: 0, total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, failing: [], slowest: [], unreadable: [], notRead: beyond, readAtMost: limits.files }
    let spent = 0
    let looked = 0
    for (const file of found) {
        if (before && before.get(file.rel) === signature(file.stat)) continue
        looked++
        const { size } = file.stat
        if (size > limits.fileBytes) { result.unreadable.push({ file: file.rel, why: `it is ${sizeOf(size)}, more than the ${sizeOf(limits.fileBytes)} LaneKit reads of one file` }); continue }
        if (spent + size > limits.totalBytes) { result.unreadable.push({ file: file.rel, why: `LaneKit reads at most ${sizeOf(limits.totalBytes)} of JUnit in all` }); continue }
        let bytes
        try { bytes = readAtMost(file.abs, limits.fileBytes) } catch (error) { result.unreadable.push({ file: file.rel, why: `it could not be opened: ${error.code ?? error.message}` }); continue }
        if (!bytes) { result.unreadable.push({ file: file.rel, why: `it grew past the ${sizeOf(limits.fileBytes)} LaneKit reads of one file` }); continue }
        spent += bytes.length
        let parsed
        try {
            parsed = parseJUnit(bytes.toString('utf8'))
        } catch (error) {
            if (!(error instanceof Unreadable)) throw error
            result.unreadable.push({ file: file.rel, why: error.message })
            continue
        }
        if (!parsed.junit) continue
        result.files++
        for (const test of parsed.cases) {
            result.total++
            result[test.outcome]++
            if ((test.outcome === 'failed' || test.outcome === 'errored') && result.failing.length < NAMED) {
                result.failing.push({ name: test.name, outcome: test.outcome })
            }
            keepIfSlow(result.slowest, test)
        }
    }
    if (!looked || (!result.files && !result.unreadable.length)) return null
    return result
}

// ---------------------------------------------------------------------------
// saying it
// ---------------------------------------------------------------------------

const number = (n) => Number(n).toLocaleString('en-US')

/** "1,617 passed, 2 failed, 1 errored, 3 skipped": passed always, the rest where there are any. */
export const countsSaid = (tests) => {
    if (!tests || !tests.files) return null
    if (!tests.total) return 'no tests ran'
    return [`${number(tests.passed)} passed`,
        tests.failed ? `${number(tests.failed)} failed` : null,
        tests.errored ? `${number(tests.errored)} errored` : null,
        tests.skipped ? `${number(tests.skipped)} skipped` : null].filter(Boolean).join(', ')
}

/** How many failed or errored beyond those named. */
export const moreOf = (tests) => Math.max(0, (tests?.failed ?? 0) + (tests?.errored ?? 0) - (tests?.failing?.length ?? 0))

/** What could not be read, in one sentence, or null. */
export const unreadSaid = (tests) => {
    const unread = tests?.unreadable ?? []
    const left = tests?.notRead ?? 0
    if (!unread.length && !left) return null
    const named = unread.slice(0, UNREAD_NAMED).map((one) => `${one.file} (${one.why})`).join(', ')
    const others = unread.length > UNREAD_NAMED ? `, and ${number(unread.length - UNREAD_NAMED)} more` : ''
    const parts = []
    if (unread.length) {
        parts.push(`${unread.length === 1 ? '1 XML file' : `${number(unread.length)} XML files`} the tests wrote could not be read, so ${unread.length === 1 ? 'it is' : 'they are'} not counted: ${named}${others}`)
    }
    if (left) parts.push(`${number(left)} more XML ${left === 1 ? 'file was' : 'files were'} not read, past the first ${number(tests.readAtMost ?? LIMITS.files)}`)
    return parts.join('; ')
}

/**
 * What the run record keeps of the tests, as the page, the editor and an agent are given it: the counts, the words for
 * them, the tests named and how many more, and what could not be read. Null where there was nothing.
 */
export const testsShown = (tests) => {
    if (!tests || typeof tests !== 'object') return null
    const shown = {
        files: tests.files ?? 0, total: tests.total ?? 0, passed: tests.passed ?? 0, failed: tests.failed ?? 0,
        errored: tests.errored ?? 0, skipped: tests.skipped ?? 0,
        failing: (tests.failing ?? []).slice(0, NAMED).map((test) => ({ name: String(test.name ?? ''), outcome: test.outcome === 'errored' ? 'errored' : 'failed' })),
        slowest: slowestOf(tests)
    }
    return { ...shown, more: moreOf(shown), said: countsSaid(shown), unread: unreadSaid(tests) }
}

/** A run's slowest tests as a record holds them, each well formed, slowest first; [] for a run from before they were kept. */
export const slowestOf = (tests) => (Array.isArray(tests?.slowest) ? tests.slowest : [])
    .filter((test) => test && Number.isFinite(test.seconds))
    .slice(0, SLOWEST)
    .map((test) => ({
        name: String(test.name ?? ''),
        ...(test.file ? { file: String(test.file) } : {}),
        ...(test.suite ? { suite: String(test.suite) } : {}),
        seconds: test.seconds
    }))

/** Seconds as the gate says them: 0.4s and 9.5s under ten, then whole, 12s and 1,100s. */
export const secondsSaid = (seconds) => {
    const tenths = Math.round(seconds * 10) / 10
    return tenths < 10 ? `${tenths.toFixed(1)}s` : `${number(Math.round(seconds))}s`
}

/** Where a test is, where its JUnit says: its file, else its suite; '' where it says neither. */
const whereSaid = (test) => (test.file || test.suite ? `  (${test.file || test.suite})` : '')

/**
 * The gate's lines for where the tests' time went: the slowest few, each with its seconds and where it is. None where the
 * JUnit had no times, or the slowest took under SLOW_ENOUGH, so a quick suite reads as it always has.
 */
export const slowestLines = (tests) => {
    const slowest = slowestOf(tests).slice(0, SLOWEST_SHOWN)
    if (!slowest.length || slowest[0].seconds < SLOW_ENOUGH) return []
    const said = slowest.map((test) => secondsSaid(test.seconds))
    const width = Math.max(...said.map((one) => one.length))
    return ['slowest tests:', ...slowest.map((test, i) => `  ${said[i].padStart(width)}  ${test.name}${whereSaid(test)}`)]
}

/** How many tests that grew are named in a slow-down, at most, and by how much one must have grown to be named. */
export const GREW_NAMED = 5
const GREW_ENOUGH = 1

/**
 * Which tests grew most from run `then` to run `now`, each a record's `tests`: `[{ name, file?, suite?, seconds, was,
 * since }]`, most grown first, at most GREW_NAMED, each grown by GREW_ENOUGH at least. Empty where either kept no times.
 *
 * ONLY THE SLOWEST ARE KEPT, so a test of `now`'s slowest may not be in `then`'s. Where `then` kept fewer than SLOWEST,
 * it kept every timed test it had, and this one was not among them: `since` is 'new', `was` 0. Where it kept SLOWEST,
 * the test took no longer then than the last of them: `since` is 'at most' that, and what it grew by is at least what
 * is said. Otherwise `since` is 'was', exactly. A test that left the slowest is not looked for: a slow-down is what took
 * longer, and whatever took less is not it.
 */
export const testsGrown = (now, then) => {
    const nowSlowest = slowestOf(now)
    const thenSlowest = slowestOf(then)
    if (!nowSlowest.length || !thenSlowest.length) return []
    const key = (test) => `${test.file ?? ''}\n${test.suite ?? ''}\n${test.name}`
    const before = new Map(thenSlowest.map((test) => [key(test), test.seconds]))
    const full = thenSlowest.length >= SLOWEST
    return nowSlowest
        .map((test) => {
            const known = before.get(key(test))
            const [was, since] = known !== undefined ? [known, 'was'] : full ? [thenSlowest.at(-1).seconds, 'at most'] : [0, 'new']
            return { ...test, was, since, grew: test.seconds - was }
        })
        .filter((test) => test.grew >= GREW_ENOUGH)
        .sort((a, b) => b.grew - a.grew)
        .slice(0, GREW_NAMED)
        .map(({ grew, ...test }) => test)
}

/** "0.4s → 612s", "at most 0.2s → 300s", "new → 120s": a grown test's two times, as the gate says them. */
export const grownSaid = (test) =>
    `${test.since === 'new' ? 'new' : `${test.since === 'at most' ? 'at most ' : ''}${secondsSaid(test.was)}`} → ${secondsSaid(test.seconds)}`

/**
 * The lines a terminal and an agent are shown: the counts, each test named that did not pass, how many more, and what
 * could not be read. None where there were no tests to read, so a project without JUnit reads as it always has.
 */
export const testsLines = (tests) => {
    const shown = testsShown(tests)
    if (!shown) return []
    const lines = []
    if (shown.said) lines.push(`tests: ${shown.said}`)
    for (const test of shown.failing) lines.push(`  ${test.outcome.padEnd(8)} ${test.name}`)
    if (shown.more) lines.push(`  and ${number(shown.more)} more`)
    if (shown.unread) lines.push(shown.unread)
    return lines
}
