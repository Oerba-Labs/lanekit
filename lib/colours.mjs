/**
 * A lane's colour: one of six, the terminal palette's, from its name, so it stays put across reloads and so the page's
 * line and the editor's terminals agree. Two lanes of a repository whose names fall on the same colour do not share it:
 * each lane, in alphabetical order, takes the first colour free from the one its name falls on, so whoever computes it
 * from the same names gets the same answer (the page, from the repository's lanes; the editor, for a terminal). More
 * than six lanes share. The page carries a copy of this, being a script of its own (web/lanes.js), which
 * test/page.test.mjs holds to this one.
 */
export const HUES = ['cyan', 'magenta', 'yellow', 'green', 'blue', 'red']
export const hueOf = (name) => [...String(name)].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % HUES.length
export const huesOf = (names) => {
    const hues = new Map()
    const taken = new Set()
    for (const name of [...new Set(names)].sort()) {
        const wanted = hueOf(name)
        let hue = wanted
        for (let step = 1; step < HUES.length && taken.has(hue); step++) hue = (wanted + step) % HUES.length
        if (taken.has(hue)) hue = wanted
        hues.set(name, hue)
        taken.add(hue)
    }
    return hues
}
