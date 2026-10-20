# What LaneKit is for, and how each of it is tested

Every thing a person does with LaneKit, on the page or with `lane`, and the tests that show it works. A test is
named by its file and its number in that file (`node --test --test-name-pattern "<words from its name>"` runs one).
Use cases marked **new** came with the page's second round of changes (2 Oct), with review lanes and the Claude Code
plugin (3 Oct), with the page's motion (4 Oct), with the tests' counts from their JUnit (17 Oct), or with the page laid out by its
width (19 Oct). Their tests are
new too.

The tests run against scratch repositories with a bare `origin` and a second clone that pushes to it; GitHub is
lanekit's stand-in for `gh` (`test/fake-gh`); the page's own tests drive it in a real Chrome, as a browser shows it and
as the editor does (`test/e2e.test.mjs`, skipped where there is no Chrome).

| file | what it asks |
|---|---|
| [adopt](../test/adopt.test.mjs) | giving a repository lanes |
| [agents](../test/agents.test.mjs) | the agents' reports |
| [carry](../test/carry.test.mjs) | moving work into a lane, pulling, and pushing over nobody |
| [e2e](../test/e2e.test.mjs) | the page in Chrome, pointer and keyboard |
| [flow](../test/flow.test.mjs) | a lane between being made and landing |
| [github](../test/github.test.mjs) | pull requests, through `gh` |
| [loader](../test/loader.test.mjs) | the extension's loader: installing lanekit, and keeping it current |
| [mcp](../test/mcp.test.mjs) | the MCP server, spoken to as an agent's client speaks to it |
| [page](../test/page.test.mjs) | what the page decides from the state alone |
| [plugin](../test/plugin.test.mjs) | the Claude Code plugin: its manifests, skills, hooks and launcher |
| [rebase](../test/rebase.test.mjs) | moving a lane along main |
| [results](../test/results.test.mjs) | what a gate's tests said, read from the JUnit they wrote into `$LAB_RESULTS` |
| [review](../test/review.test.mjs) | reviewing somebody's pull request in a lane of its own |
| [service](../test/service.test.mjs) | what the page is told, and what it may open |
| [tidy](../test/tidy.test.mjs) | lanes set aside, quiet, or dropped; home |
| [updates](../test/updates.test.mjs) | the editor's own copy of lanekit, cloned and fast-forwarded |
| [vscode](../test/vscode.test.mjs) | the editor's extension |
| [web](../test/web.test.mjs) | `lane web`, over HTTP |

## Starting work

| | use case | how | tests |
|---|---|---|---|
| 1 | Start a lane from main as it is now | `lane new <name>`; **New lane here** on main's newest commit | web 10, adopt 5, e2e 1 |
| 2 | Start a lane from any commit, of main or on top of another lane | **New lane here** on that commit; `--base` | flow 13, vscode 25 |
| 3 | Bring a dropped lane back from its branch | `lane new <name> --existing` | tidy 5 |
| 4 | Give a repository that has none lanes, after a look at what that writes | **Give it lanes…**; `lane adopt --commit` | adopt 1–12, service 11 |
| 5 | **new** Move work begun in the main checkout into a lane of its own, every file or the ticked ones, and leave main clean | **Move to a new lane…** under main's files; `lane new <name> --carry [-- <file>…]` | carry 1–4, carry 12, e2e 5 |

## Working in a lane

| | use case | how | tests |
|---|---|---|---|
| 6 | See what is uncommitted, every file ticked at first, and commit all of it or the ticked files | the lane's files; **Commit…** | flow 11, flow 14, flow 17, e2e 4 |
| 7 | Untick a file without its diff opening | the tick | e2e 4, e2e 9 |
| 8 | Fold the ticked files into the lane's newest commit, or give it new words | **Amend…**, **Edit message**; `lane commit --amend`, `--reword` | flow 11, flow 14 |
| 9 | Take the newest commit back out, its changes kept | **Uncommit**; `lane uncommit` | flow 15 |
| 10 | Throw away what is uncommitted in some files | **Discard…**; `lane discard -- <file>…` | flow 16, flow 17 |
| 11 | Reach a lane's terminal, the files you have open following | the terminal icon, a click on the lane's name, `o` (in the editor) | vscode 8, 20, 28–30, e2e 9 |
| 12 | Start an agent in a lane, see each agent at work, and which needs you | **Agent**; the agents' line | agents 1–17, vscode 31, 37, 39–41 |
| 13 | Read a commit's words and files, and open its diffs | a click on a commit; a file in the details | flow 17, vscode 5, 6, 27, service 4–6, e2e 9 |

## Keeping current

| | use case | how | tests |
|---|---|---|---|
| 14 | Know what origin has without asking | a fetch every few minutes; **Fetch** | flow 8 |
| 15 | **new** Bring main up to origin, fetched first; Pull shown whenever origin is ahead, held while it cannot fast-forward, saying why | **Pull** beside the repository's name, and on origin's row; `lane pull` | flow 7, carry 9, page 3, e2e 6 |
| 16 | **new** Bring in what somebody else pushed to a lane's branch (a colleague, GitHub's Update branch, a suggestion from review), as a fast-forward | **Pull** on the lane, its next step; `lane pull <lane>` | carry 10, page 5, e2e 7 |
| 17 | Replay a lane onto main as it is now; stop on a conflict, resolve, carry on or abort | **Rebase**, **Resolved**, **Continue**, **Abort…**; `lane rebase`, `lane resolve` | flow 1–4, flow 18, rebase 6 |
| 18 | Move a lane onto another commit of main, back or forward | drag the lane onto a commit; `lane rebase --onto` | flow 12, rebase 1–5, rebase 8 |

## Verifying and landing

| | use case | how | tests |
|---|---|---|---|
| 19 | Verify a lane: on top of main, the tier it earns, its result kept with its commit | **Verify**; `gate` | web 8, flow 10, rebase 4, rebase 7, e2e 3 |
| 20 | **new** See which steps a lane is ready for: Verify held until there is a commit and nothing uncommitted; Land until it is verified, first in its order, and main's checkout is ready; each saying why | the lane's buttons, drawn held, their reason as their title | page 1, page 2, e2e 3 |
| 21 | Know which lane lands first, and which collide | the landing order | tidy 2, tidy 8 |
| 22 | Land a ready lane, then sweep it | **Land…**, **Land next**, **Sweep…**; `lane land`, `lane sweep` | web 7–9 |
| 23 | Push main, only where the repository takes it | **Push** beside the repository's name; `lane push --main` | flow 20–22 |
| 61 | **new** Know what the tests said: how many passed, failed, errored and were skipped, and the first five that did not pass, wherever a gate's result is shown; a file that cannot be read said once, and never deciding the gate; nothing new for a project that writes no JUnit | `./check` writes JUnit XML into `$LAB_RESULTS`; the gate, the page, the editor's notice, the `gate` tool | results 1–17, page 9 |

## Pull requests

| | use case | how | tests |
|---|---|---|---|
| 24 | Push a lane, never over origin's copy unasked | **Push**, **Push…**; `lane push`, `--force-with-lease` | flow 5, rebase 5 |
| 25 | **new** Never push over somebody else's commits on a lane's branch, even with a lease LaneKit's own fetch has renewed | Push held, saying what to bring in first; `lane push` refuses without `--force` | carry 11, carry 13, page 5 |
| 26 | Open a pull request (a draft, with reviewers), ask for more reviews, make a draft ready | **Pull request…**, **Request review…**, **Ready for review**; `lane pr` | github 3 |
| 27 | See a pull request's checks, review, threads and comments | its badges under the lane's newest commit | github 2, github 4, flow 19 |
| 28 | Land by pull request where main takes its changes that way | the lane's next step; **Merge…**; `lane merge` | github 5–7 |
| 29 | **new** Clear away a lane whose pull request was merged: pull main, then sweep it (a merge commit), or drop it (squashed) | its next step: **Pull main**, **Sweep…** or **Drop…** | github 5, github 7, page 4, e2e 8 |
| 30 | **new** A pull request merged while work went on in its lane: said, Commit and Push held, and the work since (commits after the one merged, and files) moved to a new lane from main, the old lane left as it was merged | **Move to a new lane…**; `lane new <name> --carry --from <lane> --after <commit>` | github 8, page 4, carry 5, carry 6, e2e 8 |
| 31 | See pull requests anywhere that wait on your review | home's list, a repository's header | github 9, e2e 10 |

## Tidying

| | use case | how | tests |
|---|---|---|---|
| 32 | Set a lane aside, and bring it back | **Set aside**, **Bring back**; `lane aside`, `lane resume` | tidy 1, tidy 7 |
| 33 | Notice a lane nobody has touched | *Quiet for…* | tidy 3 |
| 34 | Drop a lane, its branch kept; never one with work in no commit | **Drop…**; `lane drop` | tidy 4–7 |
| 35 | **new** Throw away the main checkout's own uncommitted files, which stop a land and a pull | **Discard…** under main's files; `lane discard --main -- <file>…` | carry 7, carry 12, e2e 6 |
| 36 | **new** Move what was begun in a landed lane to a lane of its own, so it can be swept | **Move to a new lane…** in *Finished lanes* | carry 8 |

## The page

| | use case | how | tests |
|---|---|---|---|
| 37 | See every repository at a glance, and switch between them | Home, the switcher, a tab of its own | tidy 9, vscode 33–35 |
| 38 | Read main's line further back | **N older commits**, **Show where it forked** | service 12, 13, web 3, vscode 16 |
| 39 | **new** Read a lane from its name down, as SourceTree and ISL label a branch: its name, state and buttons at the top of its line, its files under them, its commits under those, the line curving into main where it forked | the log | e2e 2, e2e 3 |
| 66 | **new** Tell lanes apart by colour: each lane's line, dots and name in one of six colours, the one its terminals wear in the editor, two lanes whose names fall together taking different ones; a merge on main read as *Landed* with the lane it brought as a tag in its colour, git's words in its title; an agent that needs you said by the amber badge alone; the colour wherever the lane is named, in the landing order, on Home's cards, in collisions and their brackets | the log, the landing order, Home, the editor's terminals | e2e 2, e2e 12, page 11, vscode (every lane keeps one colour) |
| 40 | **new** No *You are here* (work goes on in many places at once), a terminal icon rather than *Goto*, no row saying a repository has no lanes, no count of a lane's files | the log | page 6, e2e 1, e2e 9, vscode 26 |
| 41 | Press while something runs: the press waits its turn, and can be cancelled; one under way is stopped where it is, with what it ran | the command bar | web 10, web 11, rebase 6 |
| 42 | See main's uncommitted files where they are, on main's line, as a lane's are | the main checkout's node | carry 1, e2e 5 |
| 58 | **new** Follow what changes as it happens, pressed here or done by an agent anywhere: what stays slides to its new place, a new commit fades in washed, what went fades from where it was (an inert copy, found as nothing), a lane landed slides into main's line as `main` slides up to its merge, words that change tick over, and nothing moves where the machine asks for less motion | the log, the landing order, the command bar | e2e 11, e2e 12, e2e 13 |
| 59 | **new** See where something runs: a light down the line of a lane a press runs in (or is about to), and down main's while it is pulled, fetched or pushed; lit and still with less motion | the log | e2e 13 |
| 60 | **new** A commit pressed here is drawn once: dashed until it is made, then settled in place, never drawn beside itself nor gone from the page in between | the lane's commits | page 8, service 14 |
| 62 | **new** Read the page in a narrow window as in the side bar: a lane's next step (its icon, its word first in its title) and ⋯ float over its corner, nothing hidden keeps a line under its name, a commit's details open under its row, and the page goes back to its wide layout as the window widens | any window narrower than 760 pixels, and the side bar | e2e 14 |
| 63 | **new** Keep a lane's toolbar inside the log's column while the details pane is open in a window of middling width: every button but the next step its icon alone, under the lane's name, never under the pane | the toolbar | e2e 15 |
| 64 | **new** Read the page as a column of reading width on a wide screen, Land next beside the landing order, a question's buttons beside its words, the lane under the pointer washed, and the landing order kept under the bar as the log scrolls past it | the page | e2e 16 |
| 67 | **new** A quiet edge to the page: a dot says it is up to date, with words only while the server is lost; the command bar goes two minutes after the last press ends, unless its output is open; an icon alone is as tall as a worded button | the bar, the command bar | e2e 1 |
| 68 | **new** See what waits on you in one line under the switcher: an agent that needs you, a lane that failed verification, a lane ready to land, a pull request waiting on your review, each opening what it names | the strip | e2e 17 |
| 69 | **new** Fold a lane to its name from the mark on its line, or `z`, and unfold it the same way; the page remembers which are folded; what waits on you in it stays in sight | the lane | e2e 18 |
| 70 | **new** Read a commit as a ring, and a filled dot only where something is at work now: a lane with a press under way or an agent thinking or running fills its newest commit and its name's mark; the uncommitted node is a dashed ring | the log | e2e 19 |
| 71 | **new** See a repository's agents in one place without a row of chips under its head: one button saying how many and how many need you, opening each grouped (needs you, at work, idle; the longest waiting first) with where it works, what it is doing, since when and its session, which tells two in the main checkout apart; a press is its terminal in the editor, else its lane; gone with the last agent | the agents button | e2e 20, tidy 11 |
| 72 | **new** Read the landing order in a view of its own, Log and Landing as tabs at its head: a table of every lane in its groups, each with what it needs and why, its verification, commits and files, the lanes it collides with and on which files, its pull request, its agents and its next step, pressed in the log; the lanes not in the order yet last; each row a card in a narrow column; remembered by the page | the Landing view | e2e 21 |
| 65 | **new** Read paths from home (`~/code/api`) wherever the page says one, the whole of it as its tooltip | the bar, a repository's header, Home's cards, Without lanes | page 10 |

## Installing and updating

| | use case | how | tests |
|---|---|---|---|
| 43 | **new** Install LaneKit (from Open VSX, or a release's `.vsix` in VS Code) on a machine that has no lanekit: it offers to clone it into `~/.lanekit`, or to use a copy you have, and a command asked for meanwhile does what it was asked once lanekit is there | the offer, once by itself and on any command | loader 1–3, updates 1, 3 |
| 44 | **new** Keep the copy of lanekit the editor runs from current: fetched every few hours, fast-forwarded only while it has no changes and no commits of its own, asked once (a copy it installed, never), a reload offered | `lanekit.updates`; **LaneKit: Update lanekit Now** | loader 4–5, updates 4–6 |
| 45 | **new** Reach editors only with commits whose tests passed: a copy LaneKit installs follows `stable`, which CI moves to each commit of main that passed | `.github/workflows/test.yml` | updates 2 |
| 46 | **new** Release the extension to Open VSX, and as a file on a GitHub release (`releases/latest/download/lanekit.vsix`), by a tag | `.github/workflows/extension.yml` | vscode 18 (the `.vsix` as the stores take it) |
| 47 | **new** Keep the extension itself current with no extension store: a newer build of it in the copy of lanekit is built there and installed, once, with a reload offered; never another extension's, one the editor is too old for, in a remote window, or in a development host | the same check as 44 | loader 6–7, updates 7 |

## Reviewing somebody's pull request

| | use case | how | tests |
|---|---|---|---|
| 48 | **new** Check out a pull request waiting on your review in a lane of its own, `review-<number>`, to run, gate and read: one from this repository following its branch, one from a fork from GitHub's copy of its head | **Review in a lane** on Home and in a repository's header (**Its review lane** once made); `lane new --pr <n>` | review 1, review 2, review 7, e2e 10 |
| 49 | **new** Be refused before anything is made: a pull request merged, closed or not there, a number that is not one, `--base`, `--existing` or `--carry` with `--pr`, a folder in the way, a second lane for one pull request | the press's answer; `lane new --pr` | review 3, review 7 |
| 50 | **new** Bring in what the author pushed since: a fast-forward, or their newest outright where the lane has no commits of the reviewer's own (after a force-push, or the gate's rebase); never over the reviewer's own commits | **Pull**, its next step; ⋯ **Pull what its author pushed**; `lane pull <lane>` | review 4, page 7 |
| 51 | **new** Say on GitHub what you make of it: approve, request changes or comment, in your words | **Review…** and its form; `lane review <lane> --approve \| --request-changes \| --comment -m <words>` | review 6, review 7, e2e 10 |
| 52 | **new** Never push, land or open a pull request from somebody else's pull request; keep it out of the landing order; drop it once merged or closed | Land and Push not offered, **Drop…** its next step once done; `lane push`, `lane land`, `lane pr` refuse | review 1, review 5, review 7, page 7, e2e 10 |

## From Claude Code

| | use case | how | tests |
|---|---|---|---|
| 53 | **new** Install LaneKit in Claude Code from its own marketplace, following `stable` | `/plugin marketplace add Oerba-Labs/lanekit`, `/plugin install lanekit@lanekit` | plugin 1, plugin 2, plugin 7 |
| 54 | **new** Start, land and review by a word: the ones that change what lands only when a person types them, the ones that read or help whenever the conversation calls for them, none letting a land, drop, push or review past without asking | `/lanekit:lane`, `/lanekit:land`, `/lanekit:land-ready`; `/lanekit:lanes`, `/lanekit:review`, `/lanekit:resolve-conflicts` | plugin 3 |
| 55 | **new** Let an agent work lanes through tools rather than a shell, with the page's rules and in its words: made, carried into, committed, refused a land before its gate, gated, landed; each tool saying whether it only reads, reaches GitHub or removes something | the MCP server, `lanekit` (`bin/mcp.mjs`) | mcp 1–3 |
| 56 | **new** See the agent's state on the page and in the editor with nothing set up by hand, each event said once, even where lanekit's own hooks report already | the plugin's hooks | plugin 4, plugin 6 |
| 57 | **new** Run one lanekit for the agent, the editor and `lane`: the machine's copy where it has what is asked for, else the plugin's own | `bin/plugin-run.mjs` | plugin 5, plugin 6 |

## Not covered, or not done

- **Fold commits into each other**, ISL's *Fold*/*Combine*: LaneKit has none. **Amend** folds uncommitted files into a
  lane's newest commit only; there is no *Amend to…* (into an older commit) and no *Absorb*.
- **Restacking**: a lane started on top of another keeps the commit it started from when that one is amended or
  rebased; ISL moves what is built on a commit with it.
- **Pulling a lane that has diverged from its copy on origin** is refused and left to a person (`git pull --rebase`,
  in the lane): which side's commits should win is theirs to say.
- **The keyboard** (`j`, `k`, `g`, `l`, `p`, …) has no test of its own.
- **The side bar's layout** is tested as a narrow window's, which shares it (e2e 14), not in the side bar itself; its own
  sizes, its bar's line shown only while LaneKit does not answer, and Changes and Agent as icons are looked at in
  screenshots only. **Dragging a lane** onto a commit is tested at the
  service and in `ontoOf`, not by a drag in the browser.
- **The page's motion** is tested by what it starts (each animation's name, what it is on, whether it slides), not by
  how it looks part-way, which was looked at by hand in frames held still. A commit pressed on the page settling into
  its dashed row is looked at by hand: the press is quicker than any reading, so the page cannot be sure of drawing the
  dashed row first (what it draws from the state is tested, 60). Home's cards, the side bar and the details pane move
  too, untested.
- The README's screenshots predate this round: they still show *You are here* and *Goto*.
- **The tests' counts in the editor's notice** (a gate that ends while LaneKit is out of sight) are tested where the
  service hands them to the notice (results 15), not in the notice itself; JUnit from Xcode and Jest is read by the
  same rules as pytest's, `node --test`'s and Go's, and has no fixture of its own.
- **The workflows** (`.github/workflows/`) run on GitHub only: `node --test` does not run them, and Open VSX
  takes the `.vsix` only where its token is set (`OVSX_PAT`).
- **The VS Code Marketplace** is not published to: VS Code installs the extension from a release's file, and it
  keeps itself current from `stable` (47). Its install command, run in a real editor, is tested only in a stand-in.
- **A review's comments on lines** are not LaneKit's: **Review…** sends one review of the whole pull request; comments
  on a line are written on GitHub, or in the editor's GitHub extension.
- **Review in a lane** is offered only for a repository LaneKit has here; a pull request waiting on you anywhere else
  is listed, with a link to it.
- **The plugin's marketplace** serves `stable`, so an install has main's newest commit that passed CI, never one
  newer. Claude Code installing it from GitHub is not tested. Its validator is, and the server and the launcher are
  started in the tests as Claude Code starts them.
