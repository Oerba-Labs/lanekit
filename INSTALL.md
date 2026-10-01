# Installing lanekit into a repository

**This document is for an AI coding agent** (Claude Code, OpenCode, or any agent that can read
files and run commands) asked to give the repository it is working in lanes. A person can
follow it too.

Follow the steps in order. Each ends with something to check. Where a step says to ask the
person, ask and wait; otherwise carry on without stopping. At the end, tell the person what you
did in the shape step 8 gives.

## What you are installing

lanekit gives every piece of work its own **lane**: a git worktree beside the repository, on its
own branch, with its own port and its own copy of whatever else a running checkout needs (an
environment file, a database, an upload folder). Work in one lane cannot touch another, and a
lane lands on the integration branch only once its gate (its tests) passes.

lanekit itself lives **on the machine**, never in the repository. The repository gains a few
small files and no dependency:

| file | what it is |
|---|---|
| `lane.config.json` | what a lane of this project owns and what it borrows from the main checkout |
| `./<slug>` | the shim: finds lanekit on the machine and hands over. Every lane command goes through it |
| `./check` | what the gate runs: the project's tests |
| `.gitignore` | a line for `.lanekit/`, the gate's records, and for the environment file if git would otherwise see it |
| `.claude/commands/lane.md`, `land.md` | `/lane` and `/land` for Claude Code |
| `.opencode/commands/lane.md`, `land.md` | `/lane` and `/land` for OpenCode |

**Done looks like this:** `./<slug> lane new lanekit-trial` makes a lane with a port of its own,
`./<slug> gate` inside it prints `READY`, and the trial lane is cleared away again.

## Rules for the whole install

- **Never commit an environment file or anything secret.** Lanes copy the environment file; they
  never put it in git.
- **Never copy lanekit into the repository**, as a submodule, a vendored folder or a package. The
  shim finds it on the machine.
- **Do not change the application's code without asking.** The one change often needed, making
  the app read its port from the environment, is in step 4.1: propose it, show the diff, wait.
- **Do not push, merge or land anything.** The install ends with one local commit, which the
  person pushes when they choose.
- **Run lanekit's commands from the main checkout**, unless a step says "in the lane". If this
  session is inside a worktree, stop and say so.

## 1. Check the machine and the repository

```sh
git --version                      # 2.38 or newer: the queue uses git merge-tree --write-tree
node --version                     # v18 or newer
git rev-parse --show-toplevel      # must print the folder you are in
test -d .git && echo "main checkout" || echo "a worktree, or not the top"
git status --short                 # what is uncommitted
command -v lsof                    # optional: without it, a port counts as free unless a lane claims it
```

- git or Node too old: stop and tell the person what to upgrade.
- Not the top of a main checkout: `cd` to the checkout that owns the repository, or stop and ask.
- Uncommitted changes: tell the person. The install ends with a commit of its own files only, and
  a lane starts from the last commit, not from the working tree, so their changes would not reach
  the trial lane. Ask whether to carry on.

## 2. Get lanekit onto the machine

Use the first of these that holds a folder called `dev`:

1. `$LANEKIT`
2. `../lanekit`, beside the repository
3. `/opt/lanekit`
4. `~/.lanekit`

The shim looks in the same places in the same order. If none exists:

```sh
git clone https://github.com/Oerba-Labs/lanekit.git ~/.lanekit
```

If one exists and is a git checkout with no local changes, bring it up to date with
`git -C <it> pull --ff-only`; if it has local changes, leave it and say so. The folder you settled
on is `<lanekit>` below.

## 3. Write the files that are the same for every project

```sh
node <lanekit>/bin/adopt.mjs --check      # what it would write; writes nothing
node <lanekit>/bin/adopt.mjs
```

`adopt` writes the files in the table above, **each only where it is missing**, and never
overwrites anything. It reads the integration branch from git (the remote's default branch, else
`main`, else `master`) and chooses an environment file git ignores. It takes a port window of a
hundred above any other lanekit project in the parent folder, and names the project from
`package.json`, else the folder. Options: `--name "<Name>"`, `--port-base <port>`, and
`--agents claude`, `--agents opencode` or `--agents claude,opencode` (the default).

Read everything it prints. Act on each `note` line before going on; each says what is wrong and
what to do. If `lane.config.json` was already there, `adopt` kept it: check it against step 4
rather than starting again.

## 4. Fill in `lane.config.json` by reading the repository

`adopt` wrote a working starting point: every change earns tier 1, which runs `./check`. Now
answer these questions from the repository itself: its README, `package.json`, `pyproject.toml`,
`Makefile`, `Procfile`, `docker-compose.yml`, `.env.example`, and the code that starts the server.
Keep the config's `note` field accurate, since it is what the next reader of the file sees first.

Anywhere in the `lane` section a value may use `{lane}` (the lane's folder), `{main}` (the main
checkout), `{port}` (the lane's port) and `{name}` (the lane's name). In a gate step, `{repo}` is
the checkout being gated.

### 4.1 How does the app choose its port? `lane.env.file`, `lane.env.portKey`

Find what starts the server (a `dev` or `start` script, `manage.py runserver`, `uvicorn`, `go run`,
`rails server`, a `Procfile`) and follow it to the port.

- **It reads a variable, and loads it from the environment file** (dotenv, pydantic settings,
  Vite, Next.js): set `portKey` to that variable (usually `PORT`). Done.
- **It reads a variable but does not load the file itself**: set `lane.runHint` to a command that
  passes it, for example `"PORT={port} npm run dev"` or `"uvicorn app.main:app --port {port}"`.
  `lane new` prints it for each lane with the port filled in.
- **The port is fixed in the code or the start command**: every lane would start on the same port
  and collide. Tell the person, and propose the smallest change that reads `PORT` with today's
  port as the fallback (`process.env.PORT ?? 3000`, `int(os.environ.get("PORT", "8000"))`). Show
  the diff; make it only on a yes. Without it, lanes still work for editing and testing, not for
  running two servers at once. Say so in the report.

`lane.env.file` must be a file git ignores (`git check-ignore -q <file>` succeeds): each lane
writes its own port into it. `adopt` chose one; change it if the app reads a different file,
such as `.env.local` for Next.js.

### 4.2 What does a running checkout need that git does not carry? `lane.copyOnCreate`

A fresh clone lacks every file git ignores. List the ones the app cannot start or test without:
the environment file, local config (`config/local.yml`, `settings.local.py`), local certificates.

```sh
git status --ignored --short | grep '^!!'
```

Each is **copied** into a new lane from the main checkout, never shared. Leave out dependencies
and build output (next question) and anything the lane must own (4.4).

### 4.3 Which big folders can every lane share? `lane.linkOnCreate`, `lane.provision`

Installed dependencies are large and identical between lanes: `node_modules`, `.venv`,
`vendor/bundle`. List them in `linkOnCreate`: each lane links to the main checkout's copy instead
of installing its own, so a lane is ready in seconds.

The trade, which the person should know: linked folders are shared, so a lane that changes its
dependencies changes them for every lane. For that work, `lane new <name> --install` builds the
lane's own copies by running `lane.provision`: put the install commands there (`npm ci`,
`uv sync`, `bundle install`), as steps like
`{ "what": "installing dependencies", "command": "npm", "args": ["ci"] }`. `provision` runs only
with `--install`, or when `linkOnCreate` is empty.

Do not link build output a running server writes into (`.next`, `target`, `dist`): two lanes
building at once would write over each other.

### 4.4 What must each lane own? `lane.env.perLane`, `lane.makeDirs`, `lane.seed`

Anything that holds state the app writes: its database, its upload folder. Shared with the main
checkout, a migration in one lane breaks every other, and a test in one lane sees another's rows.

Give each lane its own through the environment file, create the folders, and fill them:

```json
"env": { "file": ".env", "portKey": "PORT", "perLane": {
  "DATABASE_URL": "sqlite:///{lane}/data/app.db",
  "UPLOAD_DIR": "{lane}/uploads"
} },
"makeDirs": ["{lane}/data", "{lane}/uploads"],
"seed": [{ "what": "migrating the lane's database", "command": "npm", "args": ["run", "migrate"] }]
```

- **SQLite**: a file under `{lane}`, as above. Seed it by migrating, or by copying the main
  checkout's: `{ "what": "copying main's database", "command": "cp", "args": ["{main}/data/app.db", "{lane}/data/app.db"] }`.
- **Postgres or MySQL**: a database per lane, such as
  `"DATABASE_URL": "postgres://localhost/piano_sheets_{name}"`, with a seed step that creates it
  (`createdb`) and one that migrates it. A lane name may contain dashes; quote it where the
  database requires.
- **Nothing stateful** (a library, a static site, a CLI): leave `perLane`, `makeDirs` and `seed`
  empty.

Use the variable names the app already reads; do not invent new ones. `seed` runs on every
`lane new` (`--no-seed` skips it). Each step is `{ "what", "command", "args", "cwd" }`, with `cwd`
relative to the lane.

### 4.5 What are the tests? `./check`, `gate`

Find the test command (`npm test`, `pytest -q`, `go test ./...`, `cargo test`, `make test`, or what
CI runs) and replace the two placeholder lines of `./check` with it:

```sh
#!/bin/sh
exec npm test
```

Run `./check` once to see it pass on the integration branch; if it fails there, tell the person
rather than change the tests. It must work without a network or a person, because the gate runs
it unattended. If the repository has no tests, leave the placeholder, which passes and says it
checked nothing, and say so in the report.

Tier 1 runs `./check` for every change. Add tier 2 only if some checks are slow and needed only
when one side of the project changes (a front-end build, an end-to-end run):

- `gate.sides.app`: path prefixes of the client (`["web/"]`). A change there earns tier 2.
- `gate.seam`: paths one side shares with the other (an API schema, a generated client). A change
  there earns tier 2 and is reported as risk to the far side.
- `gate.tiers["2"]`: the steps, as `{ "what", "command", "args", "cwd" }`, usually tier 1's step
  plus the slow ones. `cwd` is relative to the checkout being gated.
- `roots`: the project's parts, as in `{ "server": "api", "app": "web" }`, available as `{server}`
  and `{app}` in the steps. Each must exist. Leave it `{}` when unused.

`gate.generated` catches a committed file that a generator owns going stale. Leave it empty unless
the repository commits generated code and the generator is deterministic.

### 4.6 The port window. `lane.portBase`, `lane.portCeiling`

Keep what `adopt` chose unless the app's own port, or something else the person runs, falls inside
it. The main checkout keeps using whatever port it uses today; lanes take ports from the window.

### Check

```sh
node -e 'JSON.parse(require("fs").readFileSync("lane.config.json", "utf8"))' && ./<slug> lane list
```

`lane list` loads and checks the config. It names the key at fault if a root does not exist or a
window is inverted.

## 5. Commit the install

A lane starts from the last commit on the integration branch, so the shim and the config must be
committed before a lane can have them. Stage the files by name, never with `git add -A`:

```sh
git add lane.config.json <slug> check .gitignore .claude/commands .opencode/commands
git status --short                  # only those, and nothing secret
git commit -m "Give the repository lanes (lanekit)"
```

Commit on the integration branch, locally; do not push. If the person works through pull requests
and does not want local commits on the integration branch, ask before committing.

## 6. Prove it with a trial lane

```sh
./<slug> lane new lanekit-trial
```

It prints the lane's folder and port. Then check:

```sh
cat ../<checkout folder>-lanekit-trial/<env file>   # this lane's own PORT, and each perLane value
cd ../<checkout folder>-lanekit-trial
./<slug> gate                                        # prints READY
```

If you set a `runHint`, start the app in the lane with the port it printed, check it answers on
that port (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:<port>/`), and stop it again.

Then clear the trial away, from the main checkout:

```sh
cd -
./<slug> lane sweep lanekit-trial
git branch -d lanekit-trial
```

If a step fails, read the message: lanekit says what it refused and why. Fix the config, commit
the fix as a second commit, and try again. Never work around a failure with a bare
`git worktree add`, which makes a checkout with no port and the main checkout's environment.

## 7. Common refusals

| message | what to do |
|---|---|
| `no lane.config.json in … or any directory above it` | run the command from inside the checkout |
| `roots.<key> names "…", which is not in …` | fix or remove that entry in `roots` |
| `the lane tooling is not on this machine` | step 2: clone lanekit to `~/.lanekit`, or set `LANEKIT` |
| `LANEKIT_PORTS gives … outside the window` | the machine's `LANEKIT_PORTS` names this project with ports outside its window: correct that entry |
| `no free port between …` | sweep finished lanes, `lane drop` ones no longer wanted, or raise `lane.portCeiling` |
| `the working tree has uncommitted changes` (gate) | commit in the lane first: a gate result names a commit |
| `… is on "…", not <branch>` (land) | switch the main checkout to the integration branch |

## 8. Tell the person

Report in this shape, briefly:

- **Installed**: lanekit from `<lanekit>` at commit `<git -C <lanekit> rev-parse --short HEAD>`,
  with the files committed in `<commit>` (not pushed).
- **Each lane**: its port from `<first>–<last>`, written to `<env file>` as `<portKey>`; its own
  `<database, uploads…>`; shares `<linked folders>`; copies `<copied files>`.
- **The gate**: tier 1 runs `<test command>` (or: "checks nothing yet: there are no tests").
  Tier 2, if any, and what earns it.
- **Proposed, not done**: anything waiting on them, such as reading the port from the
  environment.
- **How to use it**: `/lane <what the work is>` starts a lane and moves the agent into it; `/land`
  gates it and asks before merging; `./<slug> lane web` shows every lane on one page.

## Afterwards: working in lanes

- Start a piece of work with `/lane <what it is>`, or `./<slug> lane new <name>` from the main
  checkout and then work in the folder it prints.
- **Inside a lane, run the lane's own `./<slug>`**: which copy runs decides which checkout is
  acted on.
- While iterating, `./<slug> gate --fast` runs tier 1 whatever the change earns and says
  `UNDER-GATED` when it earns more. The full `./<slug> gate` is what certifies a commit.
- When the work is done, `/land` commits, gates and reports, then asks before merging. Land only
  when the person says so: `./<slug> lane land <name>`, from the main checkout.
- A lane behind the integration branch: `./<slug> lane rebase <name>`. On a conflict it stops with the files
  named; resolve them, then `--continue` (or `--abort` to put the lane back). Never resolve somebody's
  conflict without saying so.
- To share a lane: `./<slug> lane push <name>`, then `./<slug> lane pr <name>` for a pull request. A lane
  rebased after it was pushed needs `--force-with-lease`; ask the person first.
- `./<slug> lane queue` says which lane should land first, and which lanes would collide.
