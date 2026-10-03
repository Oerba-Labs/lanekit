/**
 * What the lanes page draws, for every repository with lanes in some folders: each one's
 * state (state.mjs) and what GitHub says of its branches (github.mjs).
 *
 * SYNCHRONOUS, AND SO RUN WHERE THAT COSTS NOTHING. Reading a repository is a few git
 * commands a lane, each waited for. `lane web` is a process of its own and waits for them
 * in place; the editor's extension host is shared by every extension in the window, so
 * there it runs in a worker thread (read-worker.mjs) and the editor never waits.
 */

import { branchRulesKnown, forgetGithub, githubFor, githubSlugKnown, reviewsWaiting } from './github.mjs'
import { commitsAfter, findReposIn, repoState } from './state.mjs'

/**
 * `forget`: repositories whose GitHub answers are stale (a push, a pull request made here), asked again now.
 * `depths`: how far down its integration branch's line to read a repository, by its path, where a page asked further back.
 */
export const readRepos = (dirs, forget = [], depths = {}) => { for (const repo of forget) forgetGithub(repo); return readRepos1(dirs, depths) }

const readRepos1 = (dirs, depths) => findReposIn(dirs).map((repo) => {
    const state = repoState(repo, { spineLength: depths[repo] })
    if (state.error) return { ...state, github: { state: 'unknown', error: null } }
    const github = githubFor(repo)
    return {
        ...state,
        // Its integration branch's rules, as GitHub says them: whether it may be pushed to straight, and what a pull
        // request into it needs. Null where GitHub cannot say.
        github: { state: github.state, error: github.error, rules: branchRulesKnown(repo, state.integrationBranch), slug: githubSlugKnown(repo, state.integrationBranch) },
        lanes: state.lanes.map((lane) => {
            const pull = github.pullFor(lane.branch)
            // Merged on GitHub: how many commits the lane has made since the one it was merged at, which no pull request has.
            const sinceMerge = pull?.state === 'MERGED' && lane.exists ? commitsAfter(repo, pull.head, lane.branch) : null
            return { ...lane, pull, sinceMerge }
        })
    }
})

/** Everything a reading gives the page: the repositories, and the pull requests anywhere that wait on this person's review. */
export const readAll = (dirs, forget = [], depths = {}) => ({ repos: readRepos(dirs, forget, depths), reviews: reviewsWaiting() })
