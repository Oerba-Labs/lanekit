/**
 * What GitHub says about each branch's pull request, when this machine can ask.
 *
 * THROUGH `gh`, NOT A TOKEN OF OUR OWN. The GitHub CLI already holds whoever signed in
 * on this machine, and asking through it means this package never sees, stores or
 * passes on a credential. Without `gh`, or signed out, the page says which, and every
 * lane simply has no pull request to show.
 *
 * ASKED IN THE BACKGROUND, AT MOST ONCE A MINUTE a repository, and only while a page
 * is asking for state: a page left open all day should not become a poller of GitHub,
 * and a slow answer must never hold up the lanes, which are local and instant. The
 * first ask returns nothing and starts the question; the answer is there on the next.
 */

import { execFile, spawnSync } from 'node:child_process'

const FRESH_MS = 60_000
const AUTH_FRESH_MS = 5 * 60_000

const env = { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1' }

let auth = { state: 'unknown', at: 0, asking: false }
const byRepo = new Map()

const checkAuth = () => {
    if (auth.asking || Date.now() - auth.at < AUTH_FRESH_MS) return
    auth.asking = true
    execFile('gh', ['auth', 'status'], { env, timeout: 15_000 }, (error) => {
        const state = !error ? 'ok' : error.code === 'ENOENT' ? 'absent' : 'signed-out'
        auth = { state, at: Date.now(), asking: false }
    })
}

const ask = (repo) => {
    const kept = byRepo.get(repo) ?? { prs: [], at: 0, asking: false, error: null }
    if (kept.asking || Date.now() - kept.at < FRESH_MS) return
    kept.asking = true
    byRepo.set(repo, kept)
    execFile('gh', ['pr', 'list', '--state', 'all', '--limit', '100',
        '--json', 'number,title,state,isDraft,headRefName,headRefOid,url,author'],
    { cwd: repo, env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
        kept.asking = false
        kept.at = Date.now()
        if (error) {
            const said = (stderr || error.message || '').trim()
            // Not a failure: a repository whose remote is elsewhere simply has no pull requests.
            kept.notGithub = /none of the git remotes|no git remotes found/i.test(said)
            kept.error = kept.notGithub ? null : said.split('\n')[0].slice(0, 200)
            return
        }
        kept.notGithub = false
        try {
            kept.prs = JSON.parse(stdout)
            kept.error = null
        } catch {
            kept.error = 'gh answered with something that is not JSON'
            return
        }
        // The open ones again, with what their badges say: their checks, their comments, their review (who was asked,
        // what each reviewer last said), and whether GitHub would merge it now. Apart, so a repository's hundred
        // closed pull requests are not asked for every check they ever ran.
        if (!kept.prs.some((pr) => pr.state === 'OPEN')) { kept.extra = new Map(); kept.threads = new Map(); return }
        execFile('gh', ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,statusCheckRollup,comments,reviewDecision,reviewRequests,latestReviews,mergeStateStatus'],
            { cwd: repo, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (more, out) => {
                if (more) return
                try {
                    kept.extra = new Map(JSON.parse(out).map((pr) => [pr.number, {
                        checks: checksOf(pr.statusCheckRollup), comments: (pr.comments ?? []).length, review: pr.reviewDecision || null,
                        requested: (pr.reviewRequests ?? []).map(reviewerOf).filter(Boolean),
                        reviews: (pr.latestReviews ?? []).map((review) => ({ who: review.author?.login ?? null, state: review.state })).filter((review) => review.who),
                        mergeState: pr.mergeStateStatus || null
                    }]))
                } catch { /* the badges go without; the pull requests are still there */ }
            })
        // Its review threads left open, which gh's lists do not carry: asked of GitHub's GraphQL, for the open ones.
        execFile('gh', ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${THREADS_QUERY}`],
            { cwd: repo, env, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (more, out) => {
                if (more) return
                try { kept.threads = unresolvedOf(JSON.parse(out)) } catch { /* said as unknown */ }
            })
    })
}

/** A reviewer asked for, by the name GitHub knows them by: a person's login, or a team's slug. */
export const reviewerOf = (request) => request?.login ?? request?.slug ?? request?.name ?? null

const THREADS_QUERY = 'query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(states: OPEN, first: 50, ' +
    'orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { number reviewThreads(first: 100) { nodes { isResolved } } } } } }'
/** Each open pull request's review threads not yet resolved, by its number, from the GraphQL answer. */
export const unresolvedOf = (answer) => new Map((answer?.data?.repository?.pullRequests?.nodes ?? [])
    .map((pr) => [pr.number, (pr.reviewThreads?.nodes ?? []).filter((thread) => !thread.isResolved).length]))

/** A pull request's checks in a word: none, pending, failing or passing, as its badge shows them. */
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
export const checksOf = (rollup) => {
    const all = Array.isArray(rollup) ? rollup : []
    if (!all.length) return 'none'
    if (all.some((check) => FAILED.has(check.conclusion) || FAILED.has(check.state))) return 'failing'
    if (all.some((check) => (check.status && check.status !== 'COMPLETED') || check.state === 'PENDING' || check.state === 'EXPECTED')) return 'pending'
    return 'passing'
}

const RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 }

/**
 * Ask GitHub again of a repository at the next reading: after a push, a pull request or a merge made here. What it
 * said is kept until the new answer comes, so a lane's pull request, and the next step it decides, does not go for
 * the second it takes.
 */
export const forgetGithub = (repo) => { const kept = byRepo.get(repo); if (kept) kept.at = 0 }

/**
 * `{ state, error, pullFor(branch) }` for a repository, from what is known now.
 * state: 'ok', 'absent' (no gh here), 'signed-out', 'not-github' (its remote is elsewhere),
 * or 'unknown' while the first ask is out.
 */
export const githubFor = (repo) => {
    checkAuth()
    if (auth.state === 'ok') ask(repo)
    const kept = byRepo.get(repo)
    const said = (pr) => {
        const extra = kept.extra?.get(pr?.number) ?? null
        return pr ? {
            number: pr.number, title: pr.title, state: pr.state, draft: pr.isDraft, url: pr.url,
            // The commit it is at: for one merged, the commit it was merged at, after which a lane's commits are in no pull request.
            head: pr.headRefOid ?? null,
            checks: extra?.checks ?? null, comments: extra?.comments ?? null, review: extra?.review ?? null,
            requested: extra?.requested ?? [], reviews: extra?.reviews ?? [], mergeState: extra?.mergeState ?? null,
            threads: kept.threads?.has(pr.number) ? kept.threads.get(pr.number) : null,
            author: pr.author?.login ?? null
        } : null
    }
    const pullFor = (branch) => {
        if (!kept) return null
        const mine = kept.prs.filter((pr) => pr.headRefName === branch)
            .sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || b.number - a.number)
        return said(mine[0])
    }
    // A review lane's pull request, by its number: its branch is the reviewer's own name for it.
    const pullNumbered = (number) => (kept ? said(kept.prs.find((pr) => pr.number === Number(number))) : null)
    const state = auth.state === 'ok' && kept?.notGithub ? 'not-github' : auth.state
    return { state, error: kept?.error ?? null, pullFor, pullNumbered }
}

// ---------------------------------------------------------------------------
// whether the integration branch may be pushed to straight, or takes its changes another way
// ---------------------------------------------------------------------------

const RULES_FRESH_MS = 10 * 60_000

/** The kinds of rule that stop a push straight to a branch, as each is said. A land makes a merge commit. */
const BLOCKS = {
    pull_request: 'takes its changes by pull request',
    merge_queue: 'takes its changes through a merge queue',
    update: 'may be updated only by those its rules let past',
    required_status_checks: 'takes a commit only once its checks have passed on it',
    required_deployments: 'takes a commit only once a deployment of it has succeeded',
    required_linear_history: 'takes no merge commits, and a land makes one'
}

/**
 * Whether this person may push straight to `branch`, from what GitHub said of it: the rules its rulesets apply to it
 * (`rules`, null where they could not be read), whether this person may bypass each ruleset (`bypass`, by its id, as
 * GitHub says it: always, pull_requests_only or never), and its classic protection (`isProtected`, and `protection`
 * where it could be read, which takes an admin). `{ allowed, why }`: allowed is null where GitHub could not say, and
 * then a push is tried and what origin answers is shown as it said it.
 */
export const pushRuleOf = ({ branch, rules = null, bypass = {}, isProtected = null, protection = null }) => {
    if (rules === null && isProtected === null) return { allowed: null, why: `GitHub could not say whether ${branch} may be pushed to` }
    for (const rule of rules ?? []) {
        if (!BLOCKS[rule.type] || bypass[rule.ruleset_id] === 'always') continue
        return { allowed: false, why: `${branch} ${BLOCKS[rule.type]}` }
    }
    if (isProtected && !protection) return { allowed: null, why: `${branch} is protected, and GitHub says how only to its admins` }
    if (isProtected) {
        // Its protection was read, which only an admin may do; an admin is let past it unless it holds admins too.
        if (protection.enforce_admins?.enabled !== true) return { allowed: true, why: `${branch} is protected, and lets you, an admin, past it` }
        if (protection.required_pull_request_reviews) return { allowed: false, why: `${branch} ${BLOCKS.pull_request}` }
        if (protection.required_status_checks) return { allowed: false, why: `${branch} ${BLOCKS.required_status_checks}` }
        if (protection.required_linear_history?.enabled) return { allowed: false, why: `${branch} ${BLOCKS.required_linear_history}` }
        if (protection.restrictions) return { allowed: null, why: `${branch} may be pushed to only by some people` }
    }
    return { allowed: true, why: null }
}

/**
 * What a pull request into `branch` needs before GitHub merges it, from the same answers as pushRuleOf: how many
 * approvals (the most any rule asks), whether its code owners must approve, and whether its review threads must all be
 * resolved. Null where nothing asks for a review, or GitHub could not say.
 */
export const reviewNeedsOf = ({ rules = null, protection = null }) => {
    const asks = (rules ?? []).filter((rule) => rule.type === 'pull_request').map((rule) => rule.parameters ?? {})
    const classic = protection?.required_pull_request_reviews
    if (classic) asks.push({ required_approving_review_count: classic.required_approving_review_count, require_code_owner_review: classic.require_code_owner_reviews })
    const threads = asks.some((ask) => ask.required_review_thread_resolution) || protection?.required_conversation_resolution?.enabled === true
    if (!asks.length && !threads) return null
    return {
        approvals: Math.max(0, ...asks.map((ask) => Number(ask.required_approving_review_count) || 0)),
        codeOwners: asks.some((ask) => ask.require_code_owner_review),
        threads
    }
}

/**
 * Where a branch is pushed: its upstream's remote and the branch there, and, when that remote is on GitHub (or a
 * GitHub Enterprise host gh is signed in to), its host and owner/name. The remote's URL is read as it is written,
 * not as `insteadOf` rewrites it: the rewritten one is where git goes, the written one is which repository it is.
 */
export const pushTargetOf = (cwd, branch) => {
    const config = (key) => {
        const result = spawnSync('git', ['config', '--get', key], { cwd, encoding: 'utf8' })
        return result.status === 0 ? result.stdout.trim() : null
    }
    const remote = config(`branch.${branch}.remote`)
    const merge = config(`branch.${branch}.merge`)
    if (!remote || !merge) return null
    const url = config(`remote.${remote}.url`) ?? ''
    const found = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url)
    const hosted = found && !url.startsWith('/') && !url.startsWith('.') && !url.startsWith('file:')
    return { remote, merge, github: hosted ? { host: found[1], slug: `${found[2]}/${found[3]}` } : null }
}

/** One `gh api` route of a repository on GitHub, as `{ ok, json }`: waited for, for the command line. */
export const ghApiNow = ({ host, slug }) => (route) => {
    const result = spawnSync('gh', ['api', '--hostname', host, `repos/${slug}/${route}`], { env, encoding: 'utf8', timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })
    if (result.status !== 0) return { ok: false }
    try { return { ok: true, json: JSON.parse(result.stdout) } } catch { return { ok: false } }
}
/** The same, in the background, for a page's reading. */
const ghApi = ({ host, slug }) => (route) => new Promise((resolve) => {
    execFile('gh', ['api', '--hostname', host, `repos/${slug}/${route}`], { env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) return resolve({ ok: false })
        try { resolve({ ok: true, json: JSON.parse(stdout) }) } catch { resolve({ ok: false }) }
    })
})

/** Whether `branch` may be pushed to straight (pushRuleFrom's answer), and what a pull request into it needs. */
export const pushRuleFrom = async (api, branch) => (await branchRulesFrom(api, branch)).push

/**
 * What GitHub says of `branch`'s rules and protection, asked through `api` (ghApiNow, ghApi, or a stand-in), decided:
 * `{ push: { allowed, why }, review: { approvals, codeOwners, threads } | null }`.
 */
export const branchRulesFrom = async (api, branch) => {
    const name = encodeURIComponent(branch)
    const rules = await api(`rules/branches/${name}`)
    const bypass = {}
    const sets = rules.ok && Array.isArray(rules.json) ? new Set(rules.json.filter((rule) => BLOCKS[rule.type]).map((rule) => rule.ruleset_id)) : new Set()
    for (const id of sets) {
        const set = await api(`rulesets/${encodeURIComponent(id)}`)
        if (set.ok) bypass[id] = set.json.current_user_can_bypass
    }
    const about = await api(`branches/${name}`)
    const isProtected = about.ok ? Boolean(about.json.protected) : null
    const protection = isProtected ? await api(`branches/${name}/protection`) : null
    const answers = {
        branch, rules: rules.ok && Array.isArray(rules.json) ? rules.json : null, bypass, isProtected,
        protection: protection?.ok ? protection.json : null
    }
    return { push: pushRuleOf(answers), review: reviewNeedsOf(answers) }
}

/** Each repository's rules for its integration branch, asked in the background at most every ten minutes. */
const ruleByRepo = new Map()   // `${repo}\0${branch}` -> { rule: { push, review }, at, asking }
const askRule = (repo, branch) => {
    const key = `${repo}\0${branch}`
    const kept = ruleByRepo.get(key) ?? { rule: null, at: 0, asking: false }
    if (kept.asking || Date.now() - kept.at < RULES_FRESH_MS) return
    const target = pushTargetOf(repo, branch)
    kept.at = Date.now()
    kept.slug = target?.github?.slug ?? null
    ruleByRepo.set(key, kept)
    if (!target?.github) { kept.rule = null; return }
    kept.asking = true
    branchRulesFrom(ghApi(target.github), branch)
        .then((rule) => { kept.rule = rule })
        .catch(() => { kept.rule = null })
        .finally(() => { kept.asking = false; kept.at = Date.now() })
}
/**
 * What is known of `branch`'s rules, `{ push, review }`: null until GitHub has been asked, or where it is not GitHub.
 * `slug`, its owner/name there, is known without asking.
 */
export const branchRulesKnown = (repo, branch) => {
    if (auth.state === 'ok') askRule(repo, branch)
    return ruleByRepo.get(`${repo}\0${branch}`)?.rule ?? null
}
/** Its owner/name on GitHub, as its integration branch's remote names it, once the rules have been asked for. */
export const githubSlugKnown = (repo, branch) => ruleByRepo.get(`${repo}\0${branch}`)?.slug ?? null

// ---------------------------------------------------------------------------
// pull requests waiting on this person's review, anywhere on GitHub
// ---------------------------------------------------------------------------

const REVIEWS_FRESH_MS = 3 * 60_000
const waitingOnMe = { list: [], at: 0, asking: false }

/** One pull request from gh's search, as home shows it. */
export const waitingOf = (found) => ({
    repo: found.repository?.nameWithOwner ?? found.repository?.name ?? null,
    number: found.number, title: found.title, url: found.url,
    author: found.author?.login ?? null, at: Date.parse(found.updatedAt) || null, draft: Boolean(found.isDraft)
})

/**
 * Open pull requests anywhere on GitHub that ask this person for a review (gh search prs --review-requested=@me),
 * newest first: asked in the background at most every three minutes, while a page is asking, as everything here is.
 * Empty until the first answer, and while gh is not signed in; an answer that fails keeps the last one.
 */
export const reviewsWaiting = () => {
    checkAuth()
    if (auth.state === 'ok' && !waitingOnMe.asking && Date.now() - waitingOnMe.at >= REVIEWS_FRESH_MS) {
        waitingOnMe.asking = true
        execFile('gh', ['search', 'prs', '--review-requested=@me', '--state=open', '--sort', 'updated', '--limit', '30',
            '--json', 'number,title,url,repository,author,updatedAt,isDraft'],
        { env, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
            waitingOnMe.asking = false
            waitingOnMe.at = Date.now()
            if (error) return
            try { waitingOnMe.list = JSON.parse(stdout).map(waitingOf).sort((a, b) => (b.at ?? 0) - (a.at ?? 0)) } catch { /* the last answer stays */ }
        })
    }
    return auth.state === 'ok' ? waitingOnMe.list : []
}
