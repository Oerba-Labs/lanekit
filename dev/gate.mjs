#!/usr/bin/env node
/**
 * Is this branch ready to merge?
 *
 * Run from inside a lane. It rebases onto the integration branch, checks the
 * obligations a clean merge would hide, works out which tier the diff has
 * earned, runs it, records the result against a sha, and stops. **It never
 * merges.** Separating the work is the point; putting a person back at the
 * integration step is the other half of that.
 *
 * WHY IT REBASES FIRST. A branch that passed against a three-day-old base has
 * told you nothing about the tree that will exist after the merge. Since
 * branches land with `--no-ff`, the rebased branch's tree *is* the tree the
 * merge commit carries, so testing it is testing the thing.
 *
 * WHY THE TIER IS DERIVED AND NOT CHOSEN. The expensive checks are worth
 * deferring and the cheap ones are not worth skipping, and a person choosing
 * under time pressure chooses wrong in one predictable direction. `--fast`
 * exists for the iteration loop and is honest about what it did: it prints
 * UNDER-GATED rather than READY, because it cannot certify the branch.
 *
 * WHAT IT REFUSES TO GUESS. A dirty tree, because a result names a sha and
 * uncommitted work is not in one. A rebase that conflicts, because resolving
 * somebody's conflict unattended is worse than stopping.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'

import { configFor } from '../lib/config.mjs'
import { mintRunId, recordRun } from '../lib/runs.mjs'

const DIM = '\x1b[2m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'
const OFF = '\x1b[0m'

const started = Date.now()
const elapsed = () => `${Math.round((Date.now() - started) / 1000)}s`
const log = (message) => console.log(`${DIM}[gate ${elapsed().padStart(4)}]${OFF} ${message}`)

const argv = process.argv.slice(2)
const options = {
    fast: argv.includes('--fast'),
    tier: argv.includes('--tier') ? Number(argv[argv.indexOf('--tier') + 1]) : null,
    rebase: !argv.includes('--no-rebase'),
    json: argv.includes('--json')
}

let config
try {
    config = configFor(process.cwd())
} catch (error) {
    console.error(`\n${RED}  ${error.message}${OFF}\n`)
    process.exit(1)
}

const REPO = config.checkout
const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
const gitTry = (args) => {
    const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' })
    return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

const banner = (word, colour, detail) => {
    const rule = '─'.repeat(68)
    console.log(`\n${rule}`)
    console.log(`  ${colour}${word}${OFF}  ·  ${detail}`)
    console.log(`${rule}\n`)
}

const fail = (stage, message, help) => {
    console.error(`\n${RED}[gate] ${message}${OFF}\n`)
    if (help) console.error(`${help}\n`)
    banner('NOT READY', RED, `${stage}  ·  ${elapsed()}`)
    process.exit(1)
}

// ---------------------------------------------------------------------------
// 1. a result names a sha
// ---------------------------------------------------------------------------

const dirty = git(['status', '--porcelain'])
    .split('\n')
    .filter(Boolean)
    // The lane's shared, rebuildable directories are not the branch's content.
    .filter((line) => !(config.lane.linkOnCreate ?? []).some((rel) => line.includes(rel)))

if (dirty.length) {
    fail('dirty tree', 'the working tree has uncommitted changes.',
        dirty.map((line) => `  ${line}`).join('\n') +
        '\n\n  A gate result names a sha, and these are not in one. Commit or stash first.')
}

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
const base = config.integrationBranch

// ---------------------------------------------------------------------------
// 2. rebase onto the integration branch
// ---------------------------------------------------------------------------

if (branch === base) {
    log(`on ${base} itself — nothing to rebase, and nothing to certify for merging`)
} else if (!options.rebase) {
    log(`skipped the rebase — this result is about ${branch} as it stands, not as it would merge`)
} else {
    const wasAt = git(['rev-parse', 'HEAD'])
    const behind = gitTry(['rev-list', '--count', `${branch}..${base}`])
    if (behind.ok && behind.out === '0') {
        log(`already on top of ${base}`)
    } else {
        const rebase = gitTry(['rebase', base])
        if (!rebase.ok) {
            gitTry(['rebase', '--abort'])
            fail('rebase', `${branch} does not apply to ${base} any more.`,
                `${rebase.err.split('\n').slice(0, 6).map((l) => `  ${l}`).join('\n')}\n\n` +
                `  Nothing was changed — the rebase was aborted and you are back at ${wasAt.slice(0, 7)}.\n` +
                `  Resolve it deliberately: git rebase ${base}`)
        }
        log(`rebased onto ${base} ${DIM}(was ${wasAt.slice(0, 7)} — git reset --hard ${wasAt.slice(0, 7)} puts it back)${OFF}`)
    }
}

const sha = git(['rev-parse', 'HEAD'])

// ---------------------------------------------------------------------------
// 3. what did this branch touch?
// ---------------------------------------------------------------------------

const files = branch === base
    ? git(['diff', '--name-only', 'HEAD~1...HEAD']).split('\n').filter(Boolean)
    : git(['diff', '--name-only', `${base}...HEAD`]).split('\n').filter(Boolean)

if (!files.length) log('no files changed against the integration branch')

const touches = (prefixes) => files.some((file) => prefixes.some((prefix) => file.startsWith(prefix)))
const matching = (prefixes) => files.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))

// ---------------------------------------------------------------------------
// 4. obligations a clean merge would hide
// ---------------------------------------------------------------------------

/**
 * Committed artifacts that a generator owns.
 *
 * This is the category of failure neither a merge nor a test can see: a
 * generated file is committed, its source changes, nobody regenerates, and git
 * reports no conflict while every suite passes. The build simply keeps using
 * the stale artifact and the change is absent.
 *
 * REGENERATE AND COMPARE, rather than "these files must change together".
 * The pairing rule was the obvious design and it is wrong in both directions.
 * It fires falsely on a source edit that produces identical output — a comment
 * in `project.yml` regenerates byte-for-byte, so the rule would demand an edit
 * to the artifact that regenerating cannot produce. And it misses the case that
 * actually bites: an Xcode project globs its sources, so ADDING A FILE changes
 * the generated output without touching the generator's input at all. A new
 * Swift file that nobody regenerated for is not compiled, and the app builds.
 *
 * The generator must be deterministic for this to be usable, which is a
 * property to check before adding one here rather than assume — a generator
 * that embeds a timestamp would fail this on every run.
 *
 * THE TREE IS PUT BACK. The gate refuses a dirty tree, so it must not leave
 * one: a stale artifact is restored and reported rather than silently fixed.
 * Regenerating for you would mean the gate commits work nobody reviewed.
 */
const staleArtifacts = []
for (const artifact of config.gate?.generated ?? []) {
    if (!touches(artifact.when)) continue
    log(`checking ${artifact.what} is what its source generates…`)
    const cwd = artifact.cwd ? path.join(REPO, artifact.cwd) : REPO
    const generated = spawnSync(artifact.command, artifact.args ?? [],
        { cwd, encoding: 'utf8' })
    if (generated.status !== 0) {
        fail('generate', `could not regenerate ${artifact.what}.`,
            `  ${(generated.stderr || generated.stdout || '').trim().split('\n').slice(0, 4).join('\n  ')}\n\n` +
            `  This check runs ${artifact.command} to compare the committed artifact\n` +
            '  against what its source produces. Install it, or drop the entry.')
    }
    const changed = gitTry(['status', '--porcelain', '--', ...artifact.outputs]).out
    if (changed) {
        gitTry(['checkout', '--', ...artifact.outputs])
        staleArtifacts.push(artifact)
    }
}

if (staleArtifacts.length) {
    const detail = staleArtifacts.map((artifact) =>
        `  ${artifact.what}\n` +
        `    committed: ${artifact.outputs.join(', ')}\n` +
        `    ${artifact.why}\n` +
        `    fix: ${artifact.cwd ? `cd ${artifact.cwd} && ` : ''}${artifact.command} ${(artifact.args ?? []).join(' ')}`)
        .join('\n\n')
    fail('stale artifact',
        `${staleArtifacts.length} committed artifact${staleArtifacts.length === 1 ? ' is' : 's are'} not what ${staleArtifacts.length === 1 ? 'its source' : 'their sources'} generates.`,
        `${detail}\n\n  Nothing was changed — the working tree was put back as it was.`)
}
const artifactCount = (config.gate?.generated ?? []).length
log(`${artifactCount} generated artifact${artifactCount === 1 ? '' : 's'} checked`)

// ---------------------------------------------------------------------------
// 5. the tier
// ---------------------------------------------------------------------------

const seam = matching(config.gate?.seam ?? [])
const sides = config.gate?.sides ?? {}
const relevant = files.filter((file) => !file.endsWith('.md'))
const touchesApp = relevant.some((file) => (sides.app ?? []).some((p) => file.startsWith(p)))

/**
 * WHY THE SEAM CANNOT EARN MORE THAN THE APP BUILD, YET.
 *
 * In the project this came from, a change on the client↔server seam earned the
 * full end-to-end pass, because there was one to run. Here there are no iOS
 * tests at all, so the most any tier can do is compile the app. The seam is
 * still reported — knowing a change can break the far side with nothing to
 * catch it is worth saying out loud, and it is the argument for the tests that
 * would let this mean something.
 */
const earned = touchesApp || seam.length ? 2 : 1
const why = seam.length
    ? `touches the client↔server seam (${seam.join(', ')})`
    : touchesApp ? 'changes the app' : 'server or tooling only'

const chosen = options.fast ? 1 : (options.tier ?? earned)
const short = chosen < earned

log(`${files.length} file${files.length === 1 ? '' : 's'} changed — ${why}`)
if (seam.length && chosen === earned) {
    console.log(`${YELLOW}  the seam is covered only by the app compiling — nothing here exercises it against the server${OFF}`)
}

const tiers = config.gate?.tiers ?? {}
const plan = tiers[String(chosen)]
if (!plan) fail('config', `no tier ${chosen} in lane.config.json.`)

log(`tier ${chosen}: ${plan.label}`)

// ---------------------------------------------------------------------------
// 6. run it
// ---------------------------------------------------------------------------

const expand = (value) => value
    .replace(/\{repo\}/g, REPO)
    .replace(/\{app\}/g, path.join(REPO, config.roots.app ?? ''))
    .replace(/\{server\}/g, path.join(REPO, config.roots.server ?? ''))

const failures = []
for (const step of plan.steps ?? []) {
    log(`${step.what}…`)
    const cwd = step.cwd ? path.join(REPO, step.cwd) : REPO
    const result = spawnSync(expand(step.command), (step.args ?? []).map(expand),
        { cwd, stdio: 'inherit' })
    if (result.status !== 0) failures.push({ what: step.what, status: result.status })
}

// ---------------------------------------------------------------------------
// 7. write it down, then say what happened
// ---------------------------------------------------------------------------

const passed = failures.length === 0
const record = {
    id: mintRunId(`tier${chosen}`),
    kind: `tier${chosen}`,
    tier: chosen,
    branch,
    sha,
    worktree: REPO,
    result: passed ? 'passed' : 'failed',
    narrowed: short,
    earned,
    why,
    files: files.length,
    startedAt: new Date(started).toISOString(),
    durationSeconds: Math.round((Date.now() - started) / 1000),
    failures
}
const recordFile = recordRun(record, REPO)

if (options.json) console.log(JSON.stringify({ ...record, certifies: passed && !short }, null, 2))

if (!passed) {
    console.error(`\n${RED}[gate] ${failures.map((f) => f.what).join(', ')} failed${OFF}\n`)
    banner('NOT READY', RED, `${branch}  ·  tier ${chosen} failed  ·  ${elapsed()}`)
    console.log(`  run  → ${path.relative(REPO, recordFile)}\n`)
    process.exit(1)
}

if (short) {
    banner('UNDER-GATED', YELLOW, `${branch}  ·  tier ${chosen} green, but the diff earns ${earned}  ·  ${elapsed()}`)
    console.log(`  This run is green for what it covered and is ${YELLOW}not${OFF} a green for the branch.`)
    console.log(`  Run the full gate before landing: it is what certifies the sha.\n`)
    process.exit(0)
}

banner('READY', GREEN, `${branch}  ·  tier ${chosen} green on ${sha.slice(0, 10)}  ·  ${elapsed()}`)
console.log(`  run  → ${path.relative(REPO, recordFile)}`)
console.log(`\n  ${DIM}Nothing has been merged. From a checkout of ${base}:${OFF}`)
console.log(`    git merge --no-ff ${branch}\n`)
