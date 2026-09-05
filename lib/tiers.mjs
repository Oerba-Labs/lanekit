/**
 * Which tier a set of changed files earns.
 *
 * ONE DEFINITION, READ BY TWO THINGS. The gate runs a tier; the queue predicts
 * what each lane will cost so it can order them. In the project this package
 * came from those were two copies of the same seven lists, kept in step by a
 * test that parsed one file as text — necessary there, because the gate must
 * not read compiled output and the queue's copy was TypeScript. Nothing here is
 * compiled, so there is no reason to spell it twice and every reason not to:
 * a queue predicting a different tier than the gate runs is a queue that orders
 * work by a cost nobody pays.
 */

/** Documentation cannot break either side, and should not move a tier. */
const IGNORED = ['.md']

export const relevantFiles = (files) =>
    files.filter((file) => !IGNORED.some((suffix) => file.endsWith(suffix)))

const matching = (files, prefixes = []) =>
    files.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)))

/**
 * The tier, why it was earned, and the seam files that forced it.
 *
 * The seam is where a change on one side is a change on the other without a
 * single file on the far side being touched — an API client and the routes it
 * calls. It is reported separately from the tier because the two answer
 * different questions: the tier is what will be run, the seam is what is at
 * risk, and a project whose highest tier cannot exercise the seam needs to be
 * told so rather than reassured by a green.
 */
export const tierFor = (files, config) => {
    const gate = config.gate ?? {}
    const relevant = relevantFiles(files)
    const seam = matching(relevant, gate.seam)
    const touchesApp = matching(relevant, gate.sides?.app ?? []).length > 0

    if (seam.length) {
        return { tier: 2, seam, why: `touches the client↔server seam (${seam.join(', ')})` }
    }
    if (touchesApp) return { tier: 2, seam: [], why: 'changes the app' }
    return { tier: 1, seam: [], why: 'server or tooling only' }
}
