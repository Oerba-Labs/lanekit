---
description: Start an isolated lane — a worktree with its own branch, port and environment — and move this session into it
argument-hint: <what the work is, or a kebab-case lane name>
allowed-tools: Bash(./{{slug}} lane:*), Bash(git status:*), Bash(git rev-parse:*), Bash(git branch:*), Bash(git worktree:*), EnterWorktree, Read, Edit, Write
---

Start a lane for: **$ARGUMENTS**

A lane is a git worktree with its own branch, its own port and its own environment
file, so this work is separated from everything else in flight. `lane.config.json`
at the root says what a lane of {{name}} owns and what it borrows from main; read
its `note` before assuming either.

Follow these steps in order. Each check exists because skipping it produces a mess
that is annoying to unpick.

## 1. Refuse to nest

```
git rev-parse --show-toplevel
dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
```

The second is the main checkout, derived the way the tooling derives it. If they
differ, this session is **already in a lane**. Stop and say so, and offer to finish
it with `/land` first. Lanes do not nest.

If the first command fails, this session is not inside the repository at all:
`cd` into the project's checkout and start again.

## 2. Pick the name

Derive a short kebab-case name from the request: two or three words, no branch
prefix, lowercase letters, digits and dashes only, starting with a letter or
digit. If the user clearly gave a name already, use it verbatim.

Check it is free: `git branch --list <name>` must be empty, and the directory
`../<main checkout's directory name>-<name>` must not exist. The prefix is the main
checkout's own directory name, which is not always the project's slug. If the name
is taken, add a distinguishing word rather than a number.

## 3. Warn about work left behind

```
git status --short
```

Uncommitted changes in the main checkout **do not come with you**: the lane
branches from a ref, not from the working tree. If the tree is dirty, say exactly
what would be left behind and ask whether to continue, commit first, or stash. Do
not decide this silently.

## 4. Create it

```
./{{slug}} lane new <name>
```

From the main checkout's root, so it is main's copy of the tooling that creates the
lane. It adds the worktree, copies and links what the config says, allocates a port
nobody claims and nobody is serving, writes the lane's environment file, and runs
the config's `seed` steps, which fill what a lane must own.

Two flags worth knowing, neither of them a default: `--base <ref>` branches from
something other than the integration branch, and `--install` builds the lane's own
copies of what would otherwise be linked from main. Reach for `--install` only when
this work changes dependencies: linked directories are shared, so a change there
otherwise lands on every lane at once.

If it fails, report the actual error and stop. Do not fall back to a bare
`git worktree add`: that produces a checkout with no port and main's environment.

## 5. Move this session into it

Use the **EnterWorktree** tool with `path` set to the absolute lane directory the
command printed.

Use `path`, never `name`: `name` would create a *second*, unprovisioned worktree
under `.claude/worktrees/` and you would spend the session in the wrong one.
Outside Claude Code, `cd` there instead.

## 6. Confirm, then start

Report in two or three lines: the lane name, its path, its port, and that the
session is now working inside it. Then begin the work that was asked for.

**Which copy of `./{{slug}}` you run decides which checkout is acted on.** Inside
the lane, run the lane's. While iterating, `./{{slug}} gate --fast` runs tier 1
whatever the diff earns; it prints `UNDER-GATED` rather than `READY` when the diff
earns more, because it cannot certify the branch and `lane land` will refuse it.

When the work is done, `/land` gates it at the tier it earns and hands it back.
