---
name: resolve-conflicts
description: Finish a lane's rebase that stopped on conflicts — each conflicted file resolved, marked resolved, and the rebase continued — or abort it to put the lane back exactly. Use when lanes says a lane is part-way through a rebase, or a rebase reports conflicting files.
allowed-tools: mcp__plugin_lanekit_lanekit__lanes, Read, Grep, Bash(git diff:*), Bash(git log:*), Bash(git status:*)
---

1. **See what stopped**: `lanes` names the lane and its conflicted files. In the lane's folder,
   `git log --oneline -1 REBASE_HEAD` (or `git status`) says which of the lane's commits is being replayed.
2. **Understand both sides** of each file: between `<<<<<<<` and `=======` is `main` as it is now; between `=======`
   and `>>>>>>>` is the lane's commit. Read the commits that made each (`git log -p main -- <file>`) when the intent
   is not plain from the text.
3. **Resolve** each file so both intents survive, removing every marker. When the two genuinely disagree, ask the
   person rather than choosing.
4. **Mark them** with `resolve` (it refuses a file with a marker left), then `rebase` with `continue`. Another commit
   may stop on its own conflicts: repeat.
5. **Or put it back**: `rebase` with `abort` returns the lane exactly as it was before the rebase. Offer this whenever
   the resolution is not clear.
6. Once it is through, **gate** the lane again: a resolution is new code.
