<img src="vscode/lanekit-tile.svg" width="72" height="72" alt="LaneKit">

# LaneKit

**Work on several things at once in one repository, each in a lane of its own.**

A lane is a second checkout of your repository, in a folder beside it, on its own branch, with
its own port and its own copy of whatever else a running app needs: its `.env`, its database,
its uploads. Two features, or two AI agents, can be in flight side by side without sharing a
process, a file or a database row, and each lands back on `main` only once its tests pass.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/lanes-dark.png">
  <img alt="The LaneKit page on Piano Sheets, chosen in the switcher along the top beside All and api, whose dot says a gate is running there. It is in two halves, as Sapling's Interactive Smartlog is. On the left, the landing order in groups (Ready: midi-export; Needs a gate: page-turns; Commit first: dark-mode) with Land midi-export…, then main as a line of dots and three lanes, each on a line of its own that curves into main where it started. dark-mode's line is amber and it says Claude needs you: Claude asks to run Bash, above the lane's uncommitted files, ticked, with Commit… and Amend under them. midi-export is ready to land, Claude done in it, with its pull request's badges under its newest commit, which is chosen; the pointer on it shows Gate and Land…, solid as the next step, and its ⋯ is open on Push, Set aside and Drop…. page-turns needs a gate, with OpenCode running an edit in it. On the right, the chosen commit's details: its words, its lane, hash, author and age, Edit message, Uncommit, New lane here, Copy hash, and its files. Along the bottom, the command bar: api's gate running the tests, with its clock." src="docs/images/lanes-light.png">
</picture>

<sub>`lane web`: every lane of every repository on one page, each on a line of its own that
curves into main where it started, as Sapling's Interactive Smartlog draws a stack, with the
agent at work in each. A lane's buttons show when the pointer is on it, as here on midi-export:
its next step solid, the rest behind ⋯.</sub>

## The idea, in one picture

Each lane is a folder next to your repository. It is a real checkout (a git worktree), so you
can open it in an editor, run its server and its tests, while another lane does the same:

```
~/code/
├── piano-sheets/                 the main checkout, on main           port 8300
├── piano-sheets-midi-export/     a lane: branch midi-export           port 8301
└── piano-sheets-dark-mode/       a lane: branch dark-mode             port 8302
```

Every lane starts from `main`, and comes back to it with a merge commit of its own:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/lanes-graph-dark.svg">
  <img alt="main as a line of commits. Two lanes start from it with lane new: midi-export, whose gate says READY and which lane land brings back as a merge commit of its own, and dark-mode, still in progress." src="docs/images/lanes-graph-light.svg">
</picture>

## The loop

| | you run | what happens |
|---|---|---|
| **1. Start** | `./piano-sheets lane new midi-export` | a folder beside the repository, a branch, the next free port, and the lane's own `.env` |
| **2. Work** | `cd ../piano-sheets-midi-export` | edit, run, commit; nothing here touches `main` or any other lane |
| **3. Gate** | `./piano-sheets gate`, in the lane | rebases onto `main`, runs the tests the change earns, and records the result against the commit. It never merges |
| **4. Land** | `./piano-sheets lane land midi-export`, in `main` | merges with `--no-ff` once the gate is green, stops the lane's server, removes its folder, keeps its branch |

`./piano-sheets` is the project's shim: a small script, named after the project, that finds
lanekit on the machine and hands over. What each step prints, from a real run:

<details>
<summary><b>1.</b> <code>lane new</code> makes the lane</summary>

```
$ ./piano-sheets lane new midi-export
[lane] creating piano-sheets-midi-export on a new branch "midi-export" from main
HEAD is now at 4b69b8e Split a long score into pages
[lane] copied 1 gitignored path the checkout needs but git does not carry
[lane] this lane serves on 8301

────────────────────────────────────────────────────────────────
  lane "midi-export" ready
────────────────────────────────────────────────────────────────

  cd ~/code/piano-sheets-midi-export

  port     8301
  branch   midi-export (from main)
```
</details>

<details>
<summary><b>2.</b> <code>lane list</code> and <code>lane queue</code> say what is in flight, and what should land first</summary>

```
$ ./piano-sheets lane list

  LANE         PORT  SERVER
  main         —                the integration branch
  dark-mode    8302  ○ down 1 ahead
  midi-export  8301  ○ down 1 ahead

$ ./piano-sheets lane queue

  LANE         TIER  VERDICT
  dark-mode    1     commit first  server or tooling only
  midi-export  1     land now  server or tooling only
```

The queue asks git to merge every pair of lanes in memory, so it can say which would collide
before either lands, and in which order to land them so no gate has to run twice.
</details>

<details>
<summary><b>3.</b> <code>gate</code> checks the lane as it would merge</summary>

```
$ ./piano-sheets gate
[gate   0s] already on top of main
[gate   0s] 0 generated artifacts checked
[gate   0s] 1 file changed — server or tooling only
[gate   0s] tier 1: the check script
[gate   0s] running ./check…
  check: nothing is checked yet. Put this project's tests in ./check.

────────────────────────────────────────────────────────────────────
  READY  ·  midi-export  ·  tier 1 green on a5aacd3061  ·  0s
────────────────────────────────────────────────────────────────────

  Nothing has been merged. From a checkout of main:
    git merge --no-ff midi-export
```
</details>

<details>
<summary><b>4.</b> <code>lane land</code> merges it and clears it away</summary>

```
$ ./piano-sheets lane land midi-export
[lane] merging midi-export into main at ~/code/piano-sheets
[lane] merged — main is at 84e06c5
[lane] removed midi-export — branch "midi-export" kept

────────────────────────────────────────────────────────────────
  LANDED  ·  midi-export  ·  main at 84e06c5
────────────────────────────────────────────────────────────────
```

`land` refuses a lane whose last green gate is not about the commit it would merge, one that
should land after another, and a `main` with uncommitted changes.
</details>

## Getting started

You need git 2.38 or newer and Node 18 or newer, on macOS or Linux. lanekit lives on the
machine, not in your repository: it has no dependencies, and a Python, Go or Swift project
does not grow a `node_modules` to use it.

```
git clone https://github.com/Oerba-Labs/lanekit.git ~/.lanekit
ln -s ~/.lanekit/dev/lane.mjs ~/.local/bin/lane      # optional: one `lane` for every repository
```

With `lane` on your PATH, it does in a repository with lanes what the project's shim does, and
anywhere it starts one: `lane init` and `lane adopt`, below.

### In a repository you already have: let your agent do it

In Claude Code, OpenCode or any agent that can run commands, from the repository, say:

> Install lanekit in this repository by following
> https://github.com/Oerba-Labs/lanekit/blob/main/INSTALL.md

[INSTALL.md](INSTALL.md) is written for the agent. It writes the files that are the same for
every project with `adopt`, reads your repository for the rest (how the app picks its port,
what a lane must have its own copy of, what the tests are), makes a trial lane to prove it,
and tells you what it decided. To do it yourself, run `lane adopt` in the repository (or
`node ~/.lanekit/bin/adopt.mjs`): `--check` says what it would write first, and `--commit` commits
what it wrote, and only that, so every lane starts with it. Then follow the same document.

Or from LaneKit's page, which lists a repository it finds without lanes under *Without lanes*:
**Give it lanes…** shows what `lane adopt` would write, asks, then writes and commits it, and the
repository joins the others.

### A new project, with lanes from its first commit

```
lane init "Piano Sheets"                  # or node ~/.lanekit/bin/init.mjs "Piano Sheets"
cd piano-sheets
./piano-sheets lane new first-idea
```

`init` writes the config, the shim, a `check` script for the tests, a `.gitignore` and a
README, and makes the first commit. Its port window sits above any other project beside it.

### What your repository gains

| file | what it is |
|---|---|
| `lane.config.json` | what a lane of this project owns and borrows: [the config](#the-config) |
| `./<project>` | the shim, the one command everything goes through |
| `./check` | what the gate runs: put the project's tests in it |
| `.claude/commands/`, `.opencode/commands/` | `/lane` and `/land` for Claude Code and OpenCode |

## Working with an agent

`/lane <what the work is>` starts a lane and moves the agent into it; `/land` gates the lane,
reports honestly, and asks before merging. They are committed with the repository, so they
exist in every checkout, every lane and every agent's sandbox. Two agents given one lane each
cannot overwrite each other's files, restart each other's servers or migrate each other's
database, and the queue says which should land first.

Each agent says what it is doing, and the page draws it on the lane it works in: thinking,
running a tool, done, or waiting on you, which turns its lane's line amber, as dark-mode's is in
the picture at the top. *In your editor*, below, says how the agents report, and what a click
on one does there.

## See every lane at once

```
./piano-sheets lane web              # this repository, on http://127.0.0.1:13338
node ~/.lanekit/dev/lane.mjs web --scan ~/code
```

The page in the picture above, for every repository in a folder:

- **A repository with no lanes yet** is listed apart, under *Without lanes*, with **Give it
  lanes…**: it shows what `lane adopt` would write, asks, then writes it and commits only that, and
  opens what is left to decide (how the app picks its port, its tests), which INSTALL.md walks through.
- **More than one repository** brings a switcher along the top: *Home*, then each repository with the
  number of lanes in it, and a dot on one not shown while something runs there. Choosing one shows it
  alone and gives the page its name for a title (*api · LaneKit*). The address keeps the choice
  (`?repo=api`), so a browser tab can stay open on each; `[` and `]` step through them, *Home* among
  them. A Cmd- or Ctrl-click on one, or the ↗ beside its **Fetch**, opens it in a tab of its own.
- **Home** shows each repository as a card of how it stands, without its log: how many lanes it has
  (and how many are set aside or finished), main against origin and anything in its checkout that
  would stop a land, its landing order by group with each lane's name, its agents with any waiting on
  you first, and what is running in it. A card whose agent needs you is edged in amber. A click on a
  card, or Enter on it (`j` and `k` move between them), opens its repository; a lane's name opens it
  with that lane in front; in the editor, **Open in a tab** gives it a tab of its own.
- **Pull requests waiting on your review**, anywhere on GitHub (`gh search prs
  --review-requested=@me`, asked every few minutes while a page is open), are listed above Home's
  cards, newest first, each a link to it, with its repository (one of yours here opens from its
  name), its author and its age. A repository's card, and its own header, say how many of its own
  wait on you.
- **Each repository** opens with its **landing order**, grouped by what each lane needs: *Ready*,
  *Needs a gate*, *Commit first*, *Waiting* (each with the lanes it waits for: "dark-mode after
  midi-export"), *Rebase first*, *Part-way* (a rebase not finished), and *Quiet*. An order only holds
  between lanes that change the same files, so it is said only there, the costlier first; two such
  lanes are joined by a bracket in the margin. **Land next** lands the first ready one, after a
  check. A lane with nothing in it, or one set aside, is not in it.
- **A lane nobody has touched for a while is *quiet***: two weeks, or `lane.staleAfterDays` in its
  config, since its newest commit, its newest uncommitted change, or (with neither) its making. It
  says "Quiet for 4 weeks" first among its facts, and moves to the end of the landing order.
- **A lane not being worked on** can be **set aside**: out of the landing order and the log, listed
  apart under *Set aside* with **Bring back**, and nothing removed (it is kept in the clone's own git
  settings). Or **dropped**, after a check: what serves on its port stops and its folder goes, and its
  branch is kept, with the page saying whether origin has a copy or the branch here is the only one.
  A lane with uncommitted work is not dropped; commit or discard it first. `lane new <name>
  --existing` brings a dropped lane back from its branch; deleting the branch is a step of its own.
- **Each lane** is drawn as a stack built on where it started: its uncommitted files on top, its
  commits under them as dots on a line of its own, newest first, and at its base its name as a tag,
  its state and its buttons, where its line curves into main's at the commit it started from. A
  commit is its words and its age (*22m*, *3d*); its hash is in its tooltip. Under the name, quietly:
  its last gate, whether it is pushed (or what origin has of it that it lacks), its pull request when
  `gh` is signed in, and what serves on its port while anything does. While a press runs in it, it says
  so live: *Gating · running the tests… · 12 s*. A failed gate shows the failing step and its last
  lines, kept with the run, so it is still there tomorrow.
- **A commit chosen opens its details beside the log**, as Interactive Smartlog's right-hand side
  does: its whole message, its lane, hash, author and age, the files it changed (each opens its
  difference in the editor), and what can be done with it: its terminal (in the editor), **View
  changes**, **New lane here**, **Copy hash**, and on a lane's newest commit **Edit message** and
  **Uncommit**. In the
  side bar the details open under the row instead. A double click opens a commit's changes.
- **A commit's commands sit beside it**, after its words and its age, as ISL sets them, when the
  pointer is on it: **Uncommit** on a lane's newest, its terminal on a lane's newest and main's (in
  the editor), and a new lane from it and its hash to the clipboard, as icons. Words longer than a line's worth are clipped; the whole of them
  is in the tooltip and the details. Each command carries an icon of its own.
- **The command bar along the bottom** says what is running, with its step and a clock, how the
  last command went (✓ or ✗, as you would type it), and what waits its turn: a press made while
  its repository is busy joins a line, is checked again when its turn comes, and can be cancelled
  with its ×. The output opens with a click, and by itself when something you pressed fails.
- **What a press will do is drawn at once**, before it has: a commit appears in its lane, dashed,
  as its files leave the list; a rebased lane moves above its new commit; a new lane appears where
  it will start. The next reading after it ends says what really happened.
- **Its buttons show when the pointer or the keyboard is on it**, the way Sapling's Interactive
  Smartlog does, so a page of lanes reads calmly until you reach for one, and sit beside its name
  and state, never across the page from them. They are lane's own commands, run as a terminal would
  run them, with their output underneath: **Gate**, **Land**, **Sweep**, **Rebase** (a lane that is
  behind), **Push** (one with commits origin lacks), **Pull** (one whose copy on origin has commits
  somebody else pushed: a colleague, GitHub's *Update branch*, a suggestion from review), **Pull
  request** (one pushed without one), **Pull** for main (main behind origin), **Push** for main (main
  ahead of origin) and **Fetch**. A button is drawn even while what it needs is not there yet, held,
  with what it waits for as its title: **Gate** until the lane has a commit and nothing uncommitted,
  **Land** until it is gated green on its newest commit and first among those it collides with, and
  both of Land and Pull while main's checkout is on another branch, part-way through something, or
  has uncommitted files. A push never replaces commits on origin that are not the lane's own: a
  rebased lane's old commits are each the same change as one of its new ones, and anything else is
  somebody's work, which is brought in first. Land and Sweep check first with `--dry-run` and ask; a push that would
  replace origin's copy of a rebased branch asks too, and so does a push of main. A rebase that conflicts stops with the files named, and waits for **Continue** or
  **Abort**. The one thing to do next is solid (**Gate** when it needs a gate, **Land** when it is
  ready, **Rebase** when it conflicts with main); what is done now and then, **Push**, **Pull
  request**, **Set aside** and **Drop**, sits behind **⋯** at the toolbar's end.
- **Its state is said once**, beside its name ("Needs a gate", "Ready to land"), with the gate's
  last result under it only where there is one. A lane whose agent waits on you says so there too
  ("Claude needs you"), and its line turns amber, so a glance down the page finds it.
- **A new lane starts from a commit.** Point at any commit, of main or of a lane, choose **New lane
  here**, and type its name in that row: the lane starts from that commit, on top of it.
- **A lane can be dragged onto a commit of main** to rebase it there: while it is dragged, a ghost
  of it is drawn where it would start, and the drop asks first. A lane with uncommitted work, or
  in the middle of something, stays where it is. **Back onto an older commit** is allowed, and the
  question says so: the lane keeps its own commits and leaves main's newer ones out from under it,
  a place to work from (to see whether a newer commit of main broke it, or to keep going while main
  is broken) but never to land from, since the gate moves a lane onto main's newest before it tests.
  If its commits need what it leaves behind, the rebase stops on the files that conflict, and
  **Abort** puts it back exactly; a pushed lane moved back asks before its next push replaces
  origin's copy.
- **What is uncommitted is a node of its own on the lane's line**: each file ticked, in the colour
  of what happened to it (M, A, D, U), with **Select all**, **Deselect all** and **Discard…** above
  (Discard asks, and throws away only the ticked files), and **+ Commit…** and **↓ Amend** under
  them, which open the message form for the ticked files: **Commit** or **Amend**, a title, and a
  description. Amend and Edit message start from the newest commit's own words. Clicking a tick only
  ticks; clicking a file opens its difference.
- **What is uncommitted in the main checkout** is drawn the same way, on main's line just above the
  commit it was begun on, rather than said in a word above: each file ticked, **Select all**,
  **Deselect all**, **Discard…**, and under them **Move to a new lane…**, which makes a lane from that
  commit with the ticked files and takes them out of the main checkout (`lane new <name> --carry`).
  There is no Commit there: nothing reaches main without a gate. Until it is clean, Land and Pull
  wait, and say so.
- **A rebase stopped on a conflict** lists its files, each with **✓ Resolved**, which LaneKit
  refuses while a conflict marker is left in the file; then **Continue** carries on.
- **A pull request has badges** under its lane's newest commit: its checks (✓, ✗ or •), Open,
  Draft, Merged or Closed, its review in a few words ("Waiting on carol · 1 of 2", "Approved by
  alice", "Changes requested by bob", with everyone in it on hover), its review threads not yet
  resolved, its comments, and its number, each a link to it. How many approvals it needs, whether
  its code owners must approve and whether every thread must be resolved come from main's rules on
  GitHub. **Pull request…** (behind ⋯, once a lane is pushed) opens one from its commits' own words,
  as a draft if ticked, with reviewers if named; on an open one, **Request review…** asks more, and
  **Ready for review** takes a draft out of draft.
- **Where main takes its changes by pull request** (GitHub says it may not be pushed to), a lane
  lands by its pull request instead of **Land**, and its state and its one solid button follow it:
  *Ready for a pull request* (**Pull request…**, pushing it first), *Not all on #12 yet* (**Push**),
  *Draft pull request* (**Ready for review**), *Waiting for review* (**Request review…** while
  nobody is asked), *Changes requested*, *Checks failing* or *Behind main on GitHub* (**Rebase**),
  and *Approved: ready to merge* (**Merge…**, and **Merge feature…** in the landing order). Merge
  asks, then merges it on GitHub (a merge commit where the repository allows one, as Land makes, so
  the lane is then landed and swept as usual; squashed or rebased otherwise, and the lane says
  *Merged on GitHub*, to drop) and brings main here up to it. It merges only at the lane's own
  commit, and never steps past a rule. A pull request merged on GitHub some other way is said too.
- **A pull request merged while work went on in its lane** says *Merged on GitHub, with work since*:
  the commits made after the one GitHub merged, and the files not committed, are in no pull request
  now. Commit and Push are held there, and its one solid button is **Move to a new lane…**, which
  makes a lane from main's newest commit, replays those commits onto it, moves the files, and leaves
  the old lane exactly as it was merged, to drop or sweep (`lane new <name> --carry --from <lane>
  --after <commit>`). If any of it no longer applies, nothing moves. A landed lane with something
  begun in it since offers the same, under *Finished lanes*.
- **Origin's main** wears a tag where it is; when origin has commits main lacks, a dashed row above
  main's newest says how many, with **Pull**, which fetches first and then fast-forwards; it is there
  whenever origin is ahead, held and saying why while it cannot run. Main's line ends dashed where
  its history goes on.
- **Main is pushed only where the repository takes it.** With commits origin lacks (a land makes
  one), **Push** beside the repository's name asks, then sends them as a fast-forward, never forced.
  On GitHub, main's rules are read first: where it takes its changes by pull request, through a merge
  queue, only from some people, only once checks pass, or takes no merge commits, there is no Push,
  and the header says which, unless its ruleset lets you past or you are an admin of a protection that
  does not hold admins. Where GitHub cannot say (another host, `gh` signed out), the push is tried and
  the remote's own answer shown.
- **Main's line shows its newest twelve commits**, and its foot says how many of how many ("12 of
  1,204 shown") beside **25 older commits**, which reads that much further back each time, as far
  as 500. Once it reads further back, **Newest only** goes back to the twelve, at the foot and beside
  the repository's name; where it reaches main's first commit the line stops there. How far back is
  kept for every page LaneKit answers, the side bar's and each tab's, until it is asked back or
  restarts. A lane that forked further back than the log reads is listed under *Forked from further
  back*, with **Show where it forked**, which reads down to its commit in one press and shows it
  there; a lane can be dragged onto any commit the log shows.
- **It stays current by itself:** while it is open, each repository is fetched every five minutes,
  so "behind origin" is true without anybody asking; nothing is pulled or merged by it.
- **The keyboard:** `j` and `k` move between lanes, `Enter` opens one, `g` gates, `l` lands, `r`
  rebases, `p` pushes (or pulls what origin has of it), `c` commits, `u` uncommits, `o` is its terminal
  and `a` starts an agent in it (in the editor), `f` fetches, `n` names a new lane from the lane's
  newest commit (or main's), `[` and `]` show the repository before or the next, `Esc` closes the
  details, `?` lists them; in the message form,
  `⌘ Enter` commits.

It listens on the loopback only. `--ssh-host <host>` adds a link that opens a lane in VS Code over
Remote-SSH, and `--browser-editor <prefix>` one to a browser editor.

## In your editor

`vscode/` is LaneKit's extension for VS Code and for browser editors such as code-server. The
LaneKit icon in the activity bar opens the same page in an **editor tab** of its own, the way
Sapling's Interactive Smartlog sits in the editor, and closes the side bar again; set
`lanekit.opensIn` to `sideBar` to keep it in the side bar instead, laid out for a narrow column, as
in the picture. There its clicks drive the editor:

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/lanekit-sidebar-dark.png">
  <img alt="LaneKit in the editor's side bar, on Piano Sheets, with the switcher above it and Goto beside Fetch for the main checkout. The landing order in groups (Ready: midi-export; Needs a gate: page-turns; Commit first: dark-mode), then dark-mode marked You are here, its line amber because Claude needs you there, asking to run Bash, with its uncommitted files ticked; midi-export ready to land, Claude done in it, with its pull request's badges; and page-turns under the pointer, OpenCode running in it, offering Gate, its next step, and a ⋯ for the rest. All three curve into main. The command bar along the bottom." src="docs/images/lanekit-sidebar-light.png" width="320" align="right">
</picture>

- a commit opens as the diffs of what it changed; a lane's **Changes** opens everything it
  holds that the integration branch does not, committed or not, against its files as they are,
  so you can edit them in the diff; an uncommitted file opens its own difference;
- a click on a lane's name is its terminal; nothing says where you are, since work goes on in many
  places at once;
- **a repository in a tab of its own**: each tab is titled with the repository its switcher shows
  (*api · LaneKit*), and a Cmd- or middle-click on one in the switcher, the ↗ beside its **Fetch**, the
  status bar's menu, or **LaneKit: Show a Repository in a Tab of Its Own…** opens one for that
  repository alone, or brings forward the one already open. A lane asked for from the status bar
  goes to the tab showing its repository, and each tab comes back on its repository after a reload;
- in the side bar, where there is no room for a toolbar, the pointer on a lane shows the next
  thing to do and a **⋯** that opens the rest;
- **the terminal icon** is the way to a lane's terminal (it was called Goto, after Interactive
  Smartlog's): your terminal follows and takes the focus: a shell waiting at its prompt in another
  checkout is sent `cd` to the same folder in the lane; one running something (a server, an agent)
  is never typed into, and the terminal you last used in the lane comes forward instead, or one
  opens there. Each file you have open from another checkout reopens from that lane, where it was; a
  file with unsaved changes stays where it is, and nothing on disk changes. It is on every lane's
  toolbar, on the repository's heading for its main checkout, on a lane's newest commit (and main's)
  under the pointer, in the details, and `o`. A terminal LaneKit opens in a lane is named for it and
  wears a colour of its own that all of the lane's terminals share;
- **Agent** starts Claude Code or OpenCode in the lane, in a terminal named for both
  (`midi-export · Claude`), so the terminal list says which agent works where. Where tmux 3 or newer
  is installed the agent runs in a tmux session of its own, which the terminal only shows: closing
  the terminal, or the editor, detaches the agent rather than ending it, and a click on the agent
  finds the terminal showing it or attaches a new one. The session ends when the agent does.
  `lanekit.agentsInTmux` turns it off;
- **the agents at work** are drawn on the lane each works in, Claude Code's and OpenCode's alike:
  **Thinking**, **Running** a tool, **Needs you** (a permission or a question, and what it asks to
  use), **Done** or **Failed**, since when; a click on one brings forward its terminal. One coming
  to need you is said in a notification with **Show**, unless its terminal is the one in front, and
  the status bar counts the agents and those waiting on you, a click listing them all. An agent in
  a repository without lanes, or in no repository, is counted and said too, named by its folder.
  Each agent says this itself, into your own `~/.local/state/lanekit/agents/`, nothing in any
  repository: its state, the name of its tool, its folder, its machine and its process, never what
  the tool was given or what anybody said. An agent that ends, or dies, drops off. It says so
  through a hook in your Claude Code settings and a plugin among your OpenCode plugins, installed
  once a machine: the extension asks the first time it finds lanes on a machine
  (`lanekit.reportAgents` answers instead, `always` or `never`), or run
  `node ~/.lanekit/bin/agent-reports.mjs`;
- a rebase that stopped on a conflict opens its files (**Conflicts**), where each conflict can be
  accepted one way, the other, or both; a file and line in a failed gate's output opens there;
- the status bar names the lane the file in front of you is in, and what it needs ("ready to
  land"); a click opens that lane's menu: Terminal, Changes, Start agent, Gate, Land, Rebase, Push, **New
  lane from here** (on top of this one), or the lane in a new window of its own;
- the palette's **LaneKit: …** commands act on the lane in front of you, with the page's own
  checks, and a press that ends while LaneKit is out of sight says how it ended;
- `lanekit.opensIn`, `tab` by default, says where the icon, the status bar's lane menu and a
  notification's **Show** open LaneKit: an editor tab, or `sideBar`;
- `lanekit.gateOnCommit`, off by default, gates a lane by itself when a commit lands in it.

No server and no port: the extension runs the page's service itself, reads git in a worker
thread so the editor never waits, tells every page open when anything changed, and finds
repositories in the folders the window has open, a lane's own folder included. It runs lanekit
from the checkout on the machine (`lanekit.path`, else the places the shim looks: `$LANEKIT`,
`/opt/lanekit`, `~/.lanekit`), so it and the `lane` commands are always one version. It stays
off in a folder the editor has not been told to trust, since it runs the repository's own
commands.

```
node ~/.lanekit/vscode/pack.mjs       # writes vscode/lanekit-<version>.vsix, no dependencies
code --install-extension ~/.lanekit/vscode/lanekit-0.16.0.vsix
```

<br clear="right">

## Commands

```
./<project> lane new <name>      start a lane: a folder, a branch, a port, its own state
./<project> lane new <name> --carry [-- <file>…]   …with what is uncommitted in the main checkout, moved into it
./<project> lane new <name> --carry --from <lane> [--after <commit>]   …with a lane's files, and its commits after one
./<project> lane list            what exists, each lane's port, and what is serving
./<project> lane queue [name]    which lane should land next, and which would collide
./<project> gate                 in a lane: is this branch ready to merge?
./<project> lane land <name>     in main: merge a lane whose gate is green, then sweep it
./<project> lane rebase <name>   replay a lane onto main as it is now; --continue or --abort after a conflict
./<project> lane push <name>     send a lane's branch to origin; --force-with-lease once it was rebased,
                                 never over somebody else's commits there unless --force
./<project> lane pr <name>       open a pull request for a pushed lane, through gh: --draft, --reviewer
                                 alice,org/team (on an open one too), --ready for a draft, --push first
./<project> lane merge <name>    merge a lane's pull request on GitHub, at its own commit, then bring main here up to it
./<project> lane pull [name]     fast-forward main to origin (or a lane to its copy there), fetched first
./<project> lane push --main     send main to origin, a fast-forward, where its rules on GitHub allow
./<project> lane commit <name>   commit what is uncommitted: -m <message>, --amend, --reword, -- <file>…
./<project> lane uncommit <name> take the newest commit back out, its changes left uncommitted
./<project> lane discard <name> -- <file>…   throw away what is uncommitted in those files; --main for the main checkout's
./<project> lane resolve <name> -- <file>…   mark conflicted files resolved, once no marker is left
./<project> lane aside <name>    set a lane aside: out of the landing order, nothing removed
./<project> lane resume <name>   bring a lane set aside back
./<project> lane drop <name>     remove a lane's folder and keep its branch; --dry-run says what it would do
./<project> lane sweep [name]    remove lanes whose branch has landed
./<project> lane web             a page of every lane (in your editor: LaneKit's side bar)
./<project> check                what the gate runs
```

`lane new` takes `--base <ref>` to start from something other than the integration branch,
`--existing` to make a lane of a branch that is there already (one dropped earlier), `--carry` to
move work begun elsewhere into it (it moves all of it, or, where any of it no longer applies,
nothing),
`--install` to build the lane's own copies of what would otherwise be shared, `--no-seed` to
skip filling what it must own, and `--no-provision` to make the folder and stop. `gate` takes
`--fast` (tier 1 whatever the change earns; it says `UNDER-GATED` rather than `READY`),
`--tier <n>` and `--json`. `land` and `sweep` take `--dry-run`.

## The config

`lane.config.json`, at the root of the repository, holds everything that differs between
projects. A web app with a server, a SQLite database per lane and a slower build for changes
to its front end might say:

```json
{
  "name": "Piano Sheets",
  "slug": "piano-sheets",
  "integrationBranch": "main",
  "roots": { "server": "server", "app": "web" },
  "gate": {
    "sides": { "app": ["web/"] },
    "seam": ["server/api/", "web/src/api/"],
    "generated": [],
    "tiers": {
      "1": { "label": "the tests", "steps": [{ "what": "running ./check", "command": "{repo}/check", "args": [] }] },
      "2": { "label": "the tests and the web build", "steps": [
        { "what": "running ./check", "command": "{repo}/check", "args": [] },
        { "what": "building the web app", "command": "npm", "args": ["run", "build"], "cwd": "web" }
      ] }
    }
  },
  "lane": {
    "portBase": 8301,
    "portCeiling": 8399,
    "copyOnCreate": [".env"],
    "linkOnCreate": ["node_modules"],
    "env": { "file": ".env", "portKey": "PORT", "perLane": { "DATABASE_PATH": "{lane}/data/app.db" } },
    "makeDirs": ["{lane}/data"],
    "seed": [{ "what": "migrating the lane's database", "command": "npm", "args": ["run", "migrate"] }],
    "provision": [{ "what": "installing dependencies", "command": "npm", "args": ["ci"] }],
    "runHint": "npm run dev"
  }
}
```

| key | what it decides |
|---|---|
| `name`, `slug` | what is shown, and the form safe in a path: the shim and every lane folder are named from it |
| `integrationBranch` | what a lane starts from, and what "landed" means |
| `roots` | the project's directories, used as `{server}` and `{app}` in the gate's steps; refused if one names nothing |
| `gate.tiers` | what the gate runs. Tier 1 is every change; tier 2 is earned by a change to `gate.sides.app` or to `gate.seam`, the files one side shares with the other |
| `gate.generated` | committed files a generator owns: regenerated and compared, so a stale one is caught |
| `lane.portBase`, `portCeiling` | the window a lane's port comes from. A machine can take a share of it with `LANEKIT_PORTS="<slug>=<first>-<last>"`, which narrows it and never widens it |
| `lane.staleAfterDays` | optional: after how many days with nothing done in it a lane is called quiet; fourteen when left out |
| `lane.copyOnCreate` | files git ignores that a running checkout needs: copied into each lane, never shared |
| `lane.linkOnCreate` | big folders every lane can share, linked from the main checkout; `lane new --install` builds the lane's own and runs `lane.provision` |
| `lane.env` | the file a lane writes its port into (`portKey`), and values each lane must have its own of (`perLane`) |
| `lane.makeDirs` | folders the lane's values point at, made when it is |
| `lane.seed` | what fills what a lane owns, its database or its media: run on every `lane new` |
| `lane.runHint` | how to start the app, printed when a lane is made |

In any of these, `{lane}` is the lane's folder, `{main}` the main checkout, `{port}` the lane's
port and `{name}` its name; in a gate step, `{repo}` is the checkout being gated.
[INSTALL.md](INSTALL.md) says how to find each answer in a repository.

## Two decisions worth knowing

**Nothing is written down.** There is no registry of lanes. Git already knows which worktrees
exist, and each lane's environment file already records what it was given, so a lane is found
rather than remembered. A second copy would be right until somebody removed a worktree by hand.

**A port is free only if no lane claims it *and* nothing is serving on it.** A lane removed by
hand leaves its server running; a new lane handed that port would spend the afternoon talking
to a server running out of a folder that no longer exists. It answers, which is what makes it
expensive.

## Contributing

`node --test` runs the tests, on scratch repositories; `test/e2e.test.mjs` drives the page itself in
a headless Chrome over the DevTools protocol, and is skipped where there is none (`LANEKIT_CHROME`
names one). [docs/use-cases.md](docs/use-cases.md) lists what LaneKit is for and the tests that show
each works. lanekit is plain JavaScript with no dependencies and no build step, and is kept that way.

## Licence

lanekit is released under the Apache License, Version 2.0 ([LICENSE](LICENSE)). Copyright 2026
Andrei Villasana.
