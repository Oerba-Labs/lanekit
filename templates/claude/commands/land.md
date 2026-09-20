---
description: Gate this lane and hand it back ready to merge — rebases onto the integration branch, runs the tier the diff earns, then asks before merging
argument-hint: (nothing, or --tier N to force a tier — never --fast, which cannot land)
allowed-tools: Bash(./{{slug}} gate:*), Bash(./{{slug}} lane:*), Bash(git status:*), Bash(git add:*), Bash(git commit:*), Bash(git log:*), Bash(git diff:*), Bash(git rev-parse:*), ExitWorktree, Read, Write, Edit
---

Gate this lane and hand it back. Extra arguments, if any: **$ARGUMENTS**

## 1. Be in a lane

```
git rev-parse --show-toplevel
dirname "$(git rev-parse --path-format=absolute --git-common-dir)"
```

If they are the same, this session is in the main checkout and there is nothing to
land: say so and stop. `/land` runs *inside* a lane.

## 2. Commit what is there

```
git status --short
```

The gate refuses a dirty tree on purpose: a gate result names a sha, and
uncommitted changes are not in one.

If there are changes, summarise them and offer to commit. Write the message in this
repository's own register: `git log --oneline -10` shows the house style. Ignore
untracked paths that `lane.config.json` lists under `linkOnCreate`: they are the
lane's links to main's, and the gate ignores them too.

## 3. Ask the queue before paying for the gate

```
./{{slug}} lane queue
```

Find this lane's line. The gate result names a sha, so the moment another lane
lands, this one's green is void and the gate has to run again.

- **`hold the gate`** — another lane should land first. Report which, and **stop**.
  Gating anyway is the user's call, not yours.
- **`land now`** — a green run already names this exact sha. Go to step 6.
- **`gate now`** or **`rebase first`** — proceed; the gate rebases as its first act.
- **`commit first`** — go back to step 2.

## 4. Gate

```
./{{slug}} gate
```

From inside the lane, and that matters: `./{{slug}}` is the *lane's own* shim, so it
is the lane's tree that gets gated. It rebases onto the integration branch, checks
any generated files the config names, then runs the tier the diff earned.
`lane.config.json` → `gate` says which paths earn which tier and what each runs.

## 5. Report honestly

**If it fails**, say which stage failed and show the real output:

- *rebase conflict* — the branch no longer applies. Name the conflicting files and
  offer to resolve them. Nothing was changed.
- *stale artifact* — a committed generated file is not what its sources generate.
  The banner names the command that regenerates it; run it, commit, gate again.
- *tests or build* — quote the failure and point at the run file the banner names.

Fix it if the fix is obvious and small, then gate again.

**Read the banner, not the exit code.** `UNDER-GATED` means a tier below what the
diff earns was run: green for what it covered, and *not* a green for the branch.
**Never report a lane as ready when the gate was red, or when the only green was
`UNDER-GATED`.**

**If it passes**, report the branch, the sha it is green on, the tier that ran, and
`git diff --stat <integration branch>...HEAD`.

## 6. Check the queue again

```
./{{slug}} lane queue <name>
```

A green gate says this branch is sound. It says nothing about the other lanes, and
that is what the merge turns on. Exit 0 is clear to land. Anything else names what
is in the way: report it and **stop**. Do not merge without asking, even on a green.

## 7. Hand it over — do not merge unasked

The gate stops at READY deliberately: putting a person back at the integration step
is half the point. So **ask** whether to merge. If the user says yes:

1. **ExitWorktree** with `action: "keep"` — back to the main checkout. Keep, not
   remove: the branch is not merged yet, and removing would take the work with it.

2. ```
   ./{{slug}} lane land <name>
   ```

   From the main checkout, standing outside the lane, because landing removes that
   worktree. It re-reads the queue and refuses a lane that is dirty, no longer
   applies, has no green run naming this exact sha, or should land after another;
   it also refuses if main's tree is dirty. Then it merges `--no-ff` and sweeps.
   On a conflict it aborts and leaves the integration branch exactly as it was.

   **`--force` is not a way past a red gate.** It overrides the queue *order* only.
   Do not reach for it unasked.

3. **Read what it says about the sweep.** It stops whatever is listening on the
   lane's port, removes the worktree, and keeps the branch as the record of what
   landed. If it reports the lane merged but *not* swept, say so.

**Landing is not pushing and is not deploying.** Say what was landed, and leave
`git push` and any deploy to the user unless they asked for them.

If they say no, leave everything where it is and say what the branch is called so
they can come back to it.
