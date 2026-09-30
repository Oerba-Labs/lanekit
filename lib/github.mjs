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

import { execFile } from 'node:child_process'

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
        '--json', 'number,title,state,isDraft,headRefName,url'],
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
        }
    })
}

const RANK = { OPEN: 0, MERGED: 1, CLOSED: 2 }

/** Forget what GitHub said of a repository, so the next ask asks again: after a push or a pull request made here. */
export const forgetGithub = (repo) => { byRepo.delete(repo) }

/**
 * `{ state, error, pullFor(branch) }` for a repository, from what is known now.
 * state: 'ok', 'absent' (no gh here), 'signed-out', 'not-github' (its remote is elsewhere),
 * or 'unknown' while the first ask is out.
 */
export const githubFor = (repo) => {
    checkAuth()
    if (auth.state === 'ok') ask(repo)
    const kept = byRepo.get(repo)
    const pullFor = (branch) => {
        if (!kept) return null
        const mine = kept.prs.filter((pr) => pr.headRefName === branch)
            .sort((a, b) => (RANK[a.state] ?? 3) - (RANK[b.state] ?? 3) || b.number - a.number)
        const pr = mine[0]
        return pr ? { number: pr.number, title: pr.title, state: pr.state, draft: pr.isDraft, url: pr.url } : null
    }
    const state = auth.state === 'ok' && kept?.notGithub ? 'not-github' : auth.state
    return { state, error: kept?.error ?? null, pullFor }
}
