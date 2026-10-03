# What LaneKit is for, and how each of it is tested

Every thing a person does with LaneKit, on the page or with `lane`, and the tests that show it works. A test is
named by its file and its number in that file (`node --test --test-name-pattern "<words from its name>"` runs one).
Use cases marked **new** came with the page's second round of changes (2 Oct): their tests are new too.

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
| [page](../test/page.test.mjs) | what the page decides from the state alone |
| [rebase](../test/rebase.test.mjs) | moving a lane along main |
| [service](../test/service.test.mjs) | what the page is told, and what it may open |
| [tidy](../test/tidy.test.mjs) | lanes set aside, quiet, or dropped; home |
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

## Gating and landing

| | use case | how | tests |
|---|---|---|---|
| 19 | Gate a lane: on top of main, the tier it earns, its result kept with its commit | **Gate**; `gate` | web 8, flow 10, rebase 4, rebase 7, e2e 3 |
| 20 | **new** See which steps a lane is ready for: Gate held until there is a commit and nothing uncommitted; Land until it is gated green, first in its order, and main's checkout is ready; each saying why | the lane's buttons, drawn held, their reason as their title | page 1, page 2, e2e 3 |
| 21 | Know which lane lands first, and which collide | the landing order | tidy 2, tidy 8 |
| 22 | Land a ready lane, then sweep it | **Land…**, **Land next**, **Sweep…**; `lane land`, `lane sweep` | web 7–9 |
| 23 | Push main, only where the repository takes it | **Push** beside the repository's name; `lane push --main` | flow 20–22 |

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
| 31 | See pull requests anywhere that wait on your review | home's list, a repository's header | github 9 |

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
| 39 | **new** Read a lane as a stack built on where it forked: its files on top, its commits under them, its name at its base, its buttons beside its name | the log | e2e 2, e2e 3 |
| 40 | **new** No *You are here* (work goes on in many places at once), a terminal icon rather than *Goto*, no row saying a repository has no lanes, no count of a lane's files | the log | page 6, e2e 1, e2e 9, vscode 26 |
| 41 | Press while something runs: the press waits its turn, and can be cancelled | the command bar | web 10, rebase 6 |
| 42 | See main's uncommitted files where they are, on main's line, as a lane's are | the main checkout's node | carry 1, e2e 5 |

## Not covered, or not done

- **Fold commits into each other**, ISL's *Fold*/*Combine*: LaneKit has none. **Amend** folds uncommitted files into a
  lane's newest commit only; there is no *Amend to…* (into an older commit) and no *Absorb*.
- **Restacking**: a lane started on top of another keeps the commit it started from when that one is amended or
  rebased; ISL moves what is built on a commit with it.
- **Pulling a lane that has diverged from its copy on origin** is refused and left to a person (`git pull --rebase`,
  in the lane): which side's commits should win is theirs to say.
- **The keyboard** (`j`, `k`, `g`, `l`, `p`, …) has no test of its own.
- **The side bar's layout** is looked at in screenshots only, and **dragging a lane** onto a commit is tested at the
  service and in `ontoOf`, not by a drag in the browser.
- The README's screenshots predate this round: they still show *You are here* and *Goto*.
