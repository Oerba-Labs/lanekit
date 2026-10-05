---
name: land
description: Gate the lane this session works in and hand it back ready to land — committed, gated at the tier it earns, checked against the landing order — then ask before merging.
disable-model-invocation: true
allowed-tools: mcp__plugin_lanekit_lanekit__lanes, Bash(git status:*), Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*)
---

1. **Be in a lane.** If `git rev-parse --show-toplevel` is the main checkout, there is nothing to land: say so.
   Otherwise the lane is the one whose folder this is (`lanes` lists each with its folder).
2. **Commit what is there.** If `git status --short` shows changes, summarise them and offer to commit, in the
   repository's own style (`git log --oneline -10`). The gate refuses uncommitted work: a result names a commit.
3. **Ask the landing order** with `lanes`. *Waits for another lane*: report which, and stop. *Ready to land*: a green
   gate names this very commit already; go to step 5. Otherwise go on.
4. **Gate** it with `gate`. Read the banner, not the exit code: `READY` is green; `UNDER-GATED` is not a green for
   the branch. On a failure, say which stage failed with its real output (a rebase conflict names its files; a test
   names its failure), fix what is obvious and small, and gate again.
5. **Check again** with `lanes`: another lane landing meanwhile voids this one's green.
6. **Ask** whether to land it. Only on a yes, `land` it, and say what it reported. Landing pushes nothing: leave the
   push, and any deploy, to the person unless they ask.
