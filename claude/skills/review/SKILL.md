---
name: review
description: Review somebody's pull request in a lane of its own — checked out with its own port and environment, run, gated on top of main and read — then say what you make of it on GitHub, only with the person's yes. Use when asked to review a pull request (by number or link) in a repository that has lanes.
argument-hint: <pull request number>
allowed-tools: mcp__plugin_lanekit_lanekit__lanes, Bash(git log:*), Bash(git diff:*), Bash(git show:*), Read, Grep, Glob
---

Review pull request **$ARGUMENTS**.

1. **Find or make its lane.** `lanes`: a lane *reviewing #N* is it — `pull` it first, to have what the author pushed
   since. Otherwise `new_lane` with `pr: N`, which names it `review-N`. Work only in its folder.
2. **Read the change** in the lane's folder: `git log --oneline main..HEAD`, `git diff main...HEAD`, and each changed
   file whole where the diff alone does not show what it does.
3. **Run it** where behaviour matters: the lane has its own port and environment, so start the app there as the
   project says (its README, or what `lane new` printed as how to serve it) and try what the change claims.
4. **Gate it** with `gate`: the tests the change earns, on top of `main` as it is now. The gate rebases the lane here
   only; `pull` still brings what the author pushes after.
5. **Write the review**: what the change does; what is wrong, each with its file and line and why; what is missing
   (tests, a case not handled); and the risk. Say which points block a merge and which are suggestions.
6. **Ask before sending.** Show the person the review and the verdict you propose — approve, request-changes or
   comment — and send it with `review` only on their yes, with their changes. It goes to GitHub in their name.
7. **When the review is done**, offer to `drop` the lane (its branch stays). Never push a review lane, land it, or
   open a pull request from it: it is the author's work.
