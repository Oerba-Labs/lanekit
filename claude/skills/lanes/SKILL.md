---
name: lanes
description: How to work in a repository that has lanes (LaneKit; a lane.config.json at its root) — every change made in a lane of its own, a second checkout beside the repository with its own branch, port and environment, then committed, gated and handed back to land. Use before changing anything in such a repository, when asked about its lanes or what should land, or when work was begun in the main checkout by mistake.
allowed-tools: mcp__plugin_lanekit_lanekit__lanes
---

# Working in lanes

A lane is a second checkout of the repository in a folder beside it (`../<repo>-<lane>`), on a branch of its own,
with its own port and its own copy of what a running app needs (its `.env`, its database). Several pieces of work,
or several agents, run side by side without sharing a file, a process or a database row, and each lands on `main`
only once its gate is green.

LaneKit's MCP tools do everything here; each refuses what LaneKit's page refuses, and says why.

## Before changing anything

1. Call **`lanes`**. It lists every lane with what it needs (ready to land, needs a gate, commit first, waits for
   another lane, reviewing a pull request…), its uncommitted files and its collisions, and the main checkout.
2. **Never change files in the main checkout.** If the work has a lane already, work in that lane's folder. Otherwise
   call **`new_lane`** with a short kebab-case name for the work, then work only in the folder it returns: use its
   absolute path, or move there.
3. Work already begun in the main checkout by mistake moves with **`new_lane`** and `carry: true` (or `files` for some
   of it). A lane whose pull request was merged while work went on in it moves its work with `carry`, `from` and
   `after`, as `lanes` says.

## While working

- Run the app on the lane's own port, from the lane's folder; another lane's server is on another port.
- Commit with **`commit`**, or `git commit` in the lane's folder.
- **`gate`** the lane once it is committed: it rebases onto `main` as it is now and runs the tests the change earns.
  Read its banner: `READY` is green; `UNDER-GATED` and a failure are not, whatever the exit code says.
- When `main` moves on, **`rebase`** the lane; if it stops on conflicts, use the `resolve-conflicts` skill.

## Handing it back

- Say what the gate said, plainly, and **ask the person before `land`, `push`, `pull_request` or `drop`**.
- `land` merges into `main` here and removes the lane's folder; it never pushes. Where `main` takes its changes by
  pull request, `pull_request` and the person's merge on GitHub are the way instead.
- A **review lane** (`reviewing #N`) is somebody else's pull request: never push it, land it or open a pull request
  from it. The `review` skill says what to do with one.

## When a tool refuses

It says why: *commit first*, *gate it first*, *wait for X to land first*, *rebase it first*, *somebody pushed to it*.
Do what it says. Never work around a refusal with plain git (a force-push, a merge by hand): the refusals are what
keep one lane's work from overwriting another's.

## Without the tools

The project's shim does the same from a terminal: `./<project> lane new <name>`, `./<project> gate` in the lane,
`./<project> lane land <name>` in the main checkout (or `lane …` where lanekit is on the PATH).
