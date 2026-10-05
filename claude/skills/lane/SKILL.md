---
name: lane
description: Start a lane for a piece of work — a second checkout with its own branch, port and environment — and move this session into it.
argument-hint: <what the work is, or a kebab-case lane name>
disable-model-invocation: true
allowed-tools: mcp__plugin_lanekit_lanekit__lanes, Bash(git rev-parse:*), Bash(git status:*)
---

Start a lane for: **$ARGUMENTS**

1. **Refuse to nest.** Compare `git rev-parse --show-toplevel` with
   `dirname "$(git rev-parse --path-format=absolute --git-common-dir)"`. If they differ, this session is in a lane
   already: say so, and offer `/lanekit:land` first. Lanes do not nest.
2. **Read the lanes** with `lanes`. If a lane already holds this work, offer to move into it instead.
3. **Pick the name**: two or three words, kebab-case, lowercase letters, digits and dashes. If one was given, use it.
4. **Mind the main checkout.** If `lanes` says it has uncommitted files, ask whether they belong to this work: if so,
   make the lane with `carry: true` (or `files` for some of them), which moves them into it; if not, they stay.
5. **Make it** with `new_lane`. If it refuses, report its words and stop.
6. **Move into it**: the EnterWorktree tool with `path` set to the lane's folder, where there is one (never `name`,
   which would make a second, unprovisioned checkout); otherwise work there by its absolute path.
7. Report the lane's name, folder and port in two lines, then begin the work.
