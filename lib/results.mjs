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

/** What a test came to, from what its testcase holds: the worst of failure, error and skipped, else passed. */
const OUTCOMES = { failure: 'failed', error: 'errored', skipped: 'skipped' }
const RANK = { passed: 0, skipped: 1, errored: 2, failed: 3 }

/**
 * One file's JUnit: `{ junit, cases: [{ name, outcome }] }`, `junit` false for well-formed XML that is not JUnit (its
 * root is neither testsuites nor testsuite: a coverage report, say), which is passed over. Throws Unreadable, with
 * why, for anything not well formed.
 */
export const parseJUnit = (text) => {
    const lineAt = (offset) => text.slice(0, offset).split('\n').length
    const unreadable = (why, offset) => { throw new Unreadable(offset === undefined ? why : `${why}, at line ${lineAt(offset)}`) }
    const stack = []
    const cases = []
    let root = null
    let open = null   // the testcase being read: { name, outcome, depth }
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
            at = END_TAG.lastIndex
        } else {
            START_TAG.lastIndex = lt
            const tag = START_TAG.exec(text)
            if (!tag) unreadable('a tag is not well formed', lt)
            const [, name, attributes, empty] = tag
            if (!stack.length && root !== null) unreadable('it has more than one root element', lt)
            if (root === null) root = name
            if (name === 'testcase' && !open) {
                const { name: test, classname } = attributesOf(attributes)
                const named = classname && test ? `${classname}::${test}` : test || classname || '(a test with no name)'
                open = { name: named.length > NAME_MOST ? `${named.slice(0, NAME_MOST - 1)}…` : named, outcome: 'passed', depth: stack.length }
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
 * What the JUnit in `dir` says, or null where there is none to read (no XML file at all, or none the run wrote, or
 * only XML that is not JUnit): then the gate says nothing it did not say before.
 *
 *   `{ dir, files, total, passed, failed, errored, skipped, failing: [{ name, outcome }], unreadable: [{ file, why }],
 *      notRead }`: `files` the JUnit files counted, `failing` the first NAMED tests that failed or errored, in file
 *      order, `unreadable` the files that could not be read and why, `notRead` the files past LIMITS.files.
 *
 * `before`, from prepareResults: files that are as they were then are not this run's, and are passed over.
 */
export const readResults = (dir, { before = null, limits = LIMITS } = {}) => {
    const { found, beyond } = xmlFilesIn(dir, limits)
    const result = { dir, files: 0, total: 0, passed: 0, failed: 0, errored: 0, skipped: 0, failing: [], unreadable: [], notRead: beyond, readAtMost: limits.files }
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
        failing: (tests.failing ?? []).slice(0, NAMED).map((test) => ({ name: String(test.name ?? ''), outcome: test.outcome === 'errored' ? 'errored' : 'failed' }))
    }
    return { ...shown, more: moreOf(shown), said: countsSaid(shown), unread: unreadSaid(tests) }
}

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
