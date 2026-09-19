# lanekit

Isolated lanes for a repository, and the machinery around them.

A **lane** is a git worktree with its own branch and its own copy of whatever a
running checkout needs that git does not carry — an environment file, a
database, a port. The point is that two pieces of work can be in flight without
sharing a process, a file or a row.

This package holds only the parts that are the same for every project. What
differs — where the roots are, which files a lane must copy, which environment
keys it must own, what to run to provision one — lives in each repository's own
`lane.config.json`.

## Installing it into a repository

Two files, and nothing else:

- `lane.config.json` at the root, describing the project.
- A shim named after the project (`./orpheus`, `./skyride`), which finds this
  package and hands over.

**No dependency enters the repository.** This package has no runtime
dependencies, so a Python or Swift project does not grow a `node_modules` to
use it. It needs Node on the machine and nothing in the tree.

## Starting a project that has lanes from its first commit

    node <lanekit>/bin/init.mjs "Piano Sheets"

writes both files, a `check` script that is the whole of tier 1 and says it checks
nothing until the project's tests are put in it, and the first commit on `main`. It takes
a port window above any sibling project's (`--port-base` to choose), and refuses a
directory with anything in it: an existing repository's roots, environment file and tests
are decisions already made, and its two files are written by hand against the table below.

## Commands

    <shim> lane new <name>     start a lane: worktree, branch, port, own state
    <shim> lane list           what exists, what each claims, what is serving
    <shim> lane sweep [name]   remove lanes whose branch has landed

`lane new` takes `--base <ref>` to branch from something other than the
integration branch, `--install` to provision rather than share linked
directories, and `--no-provision` to make the worktree and stop.

## What the config says

| key | what it decides |
|---|---|
| `name`, `slug` | display, and the safe-in-a-path form |
| `integrationBranch` | what "landed" means, and what a lane branches from |
| `roots` | the project's directories; refused if one names nothing |
| `lane.portBase` / `portCeiling` | the window a lane's port is allocated from; a machine takes a share of it with `LANEKIT_PORTS="<slug>=<first>-<last> …"`, which names the project, narrows its window and never widens it |
| `lane.copyOnCreate` | gitignored files a checkout needs — copied, never shared |
| `lane.linkOnCreate` | big rebuildable directories — shared by symlink |
| `lane.env` | the file a lane records its port and paths in, and which keys |
| `lane.makeDirs` | directories the environment now points at |
| `lane.provision` | commands that make the lane's stack runnable |
| `lane.seed` | commands that fill what a lane must own (its database, its media); run on every `new` unless `--no-seed` |

`{lane}`, `{main}`, `{port}` and `{name}` are substituted in any configured
value.

## Two decisions worth knowing

**Nothing is written down.** There is no registry of live lanes. Git already
knows which worktrees exist and each lane's environment file already records
what it was given, so a lane is discovered rather than remembered — the failure
mode of a second copy is that it is right until somebody removes a worktree by
hand. The lane prefix is derived from the main checkout's own directory name for
the same reason: the tooling this came from carried that name as a literal, and
it was correct in one checkout and wrong in every clone.

**A port is free only if no lane claims it *and* nobody is serving it.** A lane
removed by hand leaves its server running; a new lane handed that port writes it
into its own environment and spends the afternoon talking to a server running
out of a directory that no longer exists. It answers, which is what makes it
expensive.
