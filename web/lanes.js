// The lanes page. Plain JavaScript, no build: lanekit has no dependencies and no build
// step, and this file is served as it is written.
//
// TWO PLACES, ONE PAGE. In a browser it asks `lane web` over HTTP. Inside VS Code it is a
// tab of LaneKit's editor extension (vscode/host.mjs) and asks it by message: the extension runs
// the same service in the editor, tells the page when anything changed, and opens what the
// page points at — a commit's changes, a lane's, a file's diff, a folder, a terminal — in
// the editor itself. The drawing is the same in both; only `host` differs.
//
// Every value a server said is put on the page as text (textContent, or a string handed to
// append, which makes a text node): a commit subject is somebody's words, never markup.
// Every address asked for is relative to where the page was served.
'use strict'

const ASK_EVERY_MS = 4000
const ASK_HIDDEN_MS = 15000
// Inside the editor the extension says when something changed; this only covers a lost message.
const ASK_IN_EDITOR_MS = 30000
const REDRAW_ANYWAY_MS = 30000
const STACK_SHOWN = 3

const $ = (id) => document.getElementById(id)

const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
        else node.setAttribute(key, value === true ? '' : String(value))
    }
    for (const child of children.flat(Infinity)) {
        if (child === null || child === undefined || child === false) continue
        node.append(child)
    }
    return node
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const ago = (ms) => {
    if (!ms) return ''
    const seconds = Math.round((Date.now() - ms) / 1000)
    if (seconds < 45) return 'just now'
    const minutes = Math.round(seconds / 60)
    if (minutes < 60) return `${minutes} min ago`
    const hours = Math.round(minutes / 60)
    if (hours < 24) return `${hours} h ago`
    const days = Math.round(hours / 24)
    if (days < 30) return plural(days, 'day') + ' ago'
    return new Date(ms).toLocaleDateString()
}
const exactly = (ms) => (ms ? new Date(ms).toLocaleString() : '')
/** A commit's age as the log shows it, ISL's way: 22m, 3h, 5d, 2w, 4mo, 1y. The exact time is its title. */
const short = (ms) => {
    if (!ms) return ''
    const minutes = Math.floor((Date.now() - ms) / 60000)
    if (minutes < 1) return 'now'
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}h`
    const days = Math.floor(hours / 24)
    if (days < 14) return `${days}d`
    if (days < 60) return `${Math.floor(days / 7)}w`
    if (days < 365) return `${Math.floor(days / 30)}mo`
    return `${Math.floor(days / 365)}y`
}

const state = (tone, word, extra = '') => el('span', { class: `state ${tone} ${extra}`.trim(), text: word })

// Only an address that is plainly a web page becomes a link; anything else stays words.
const safeHref = (url) => (typeof url === 'string' && /^https:\/\//.test(url) ? url : null)

// ---------------------------------------------------------------------------
// the host: lane web over HTTP, or the editor by message
// ---------------------------------------------------------------------------

const browserHost = () => ({
    inEditor: false,
    state: async () => {
        const response = await fetch('api/state', { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
    },
    press: async (body) => {
        const response = await fetch('api/jobs', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-lanes': '1' },
            body: JSON.stringify(body)
        })
        return { status: response.status, body: await response.json() }
    },
    job: async (id, from) => {
        const response = await fetch(`api/jobs/${encodeURIComponent(id)}?from=${from}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        return response.json()
    },
    cancel: async (id) => (await fetch(`api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', headers: { 'x-lanes': '1' } })).ok,
    commit: async (repoPath, sha) => {
        const response = await fetch(`api/commit?repo=${encodeURIComponent(repoPath)}&sha=${encodeURIComponent(sha)}`, { cache: 'no-store' })
        if (!response.ok) throw new Error(response.status === 404 ? 'That commit is not here.' : String(response.status))
        return response.json()
    },
    history: async (repo, way, lane) => {
        const response = await fetch('api/history', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-lanes': '1' },
            body: JSON.stringify({ repo, way, lane })
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(body.error ?? String(response.status))
        return body
    },
    copy: (text) => navigator.clipboard.writeText(text),
    on: () => {},
    remember: () => {},
    recall: () => null,
    showing: () => {}
})

const editorHost = (api) => {
    let sequence = 0
    const waiting = new Map()
    const listeners = new Map()
    window.addEventListener('message', (event) => {
        const message = event.data
        if (!message || typeof message !== 'object') return
        if (message.type === 'reply') {
            const asked = waiting.get(message.id)
            if (!asked) return
            waiting.delete(message.id)
            if (message.ok) asked.resolve(message.value); else asked.reject(new Error(message.error || 'the editor refused'))
            return
        }
        for (const listener of listeners.get(message.type) ?? []) listener(message)
    })
    const ask = (method, params) => new Promise((resolve, reject) => {
        const id = ++sequence
        waiting.set(id, { resolve, reject })
        api.postMessage({ type: 'request', id, method, params })
    })
    return {
        inEditor: true,
        state: () => ask('state'),
        press: (body) => ask('press', body),
        job: async (id, from) => {
            const job = await ask('job', { id, from })
            if (!job) throw new Error('no such job')
            return job
        },
        open: (what, params) => ask('open', { what, ...params }),
        cancel: (id) => ask('cancel', { id }),
        commit: (repoPath, sha) => ask('commit', { repo: repoPath, sha }),
        history: (repo, way, lane) => ask('history', { repo, way, lane }),
        copy: (text) => ask('copy', { text }),
        on: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        remember: (value) => api.setState(value),
        recall: () => api.getState(),
        // What the page shows, for its tab's title: one repository, by its id and its name, or every one.
        showing: (repo, title) => api.postMessage({ type: 'showing', repo, title }),
        tab: (repo) => ask('tab', { repo }),
        ready: () => api.postMessage({ type: 'ready' })
    }
}

// eslint-disable-next-line no-undef
const host = typeof acquireVsCodeApi === 'function' ? editorHost(acquireVsCodeApi()) : browserHost()
if (host.inEditor) document.body.classList.add('in-editor')

/** Ask the editor to open something; what it refuses is said on the page. */
const openIn = (what, params) => host.open(what, params).catch((error) => notice(error.message))

/**
 * Make a drawn node open something in the editor, by a click or by Enter: a commit, a file,
 * the uncommitted changes. In a browser the node is left as it was drawn.
 */
const opens = (node, title, action) => {
    if (!host.inEditor) return node
    node.classList.add('opens')
    node.setAttribute('role', 'button')
    node.tabIndex = 0
    node.title = title
    // What has a click of its own keeps it: a file's tick only ticks, and never opens its diff as well.
    node.addEventListener('click', (event) => { if (!event.target.closest('a, button, input, label, select, textarea')) action() })
    node.addEventListener('keydown', (event) => {
        if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); action() }
    })
    return node
}

// ---------------------------------------------------------------------------
// motion: what changed between one drawing and the next, moved there rather than jumped to
// ---------------------------------------------------------------------------

/*
 * Each drawing replaces what it draws, so by itself a change lands in one frame: a commit an agent made, a lane started,
 * landed or pulled, and the eye is left to find what moved (the owner, 4 Oct: smoother, and easier to follow as it
 * happens). So what is drawn carries a key of what it is (data-anim): a lane, a commit, a file, a state's words. Just
 * before a drawing every keyed thing's place is read, and just after it what is still there slides from where it was to
 * where it is, what came fades in, what went fades from where it was (an inert copy of it, for a moment), a lane that
 * landed slides into main's line, and words that changed (data-sig) tick over. A commit that comes back under the same
 * words with another hash (data-alias: made, amended, rebased) is the same row, settling. Where a drawing asks
 * (data-anim-kids) its children are keyed by their place, so a lane's name and facts move with what grew above them.
 *
 * Nothing moves off the screen, in a page nobody sees, or in a repository just switched to; where the machine asks for
 * less motion nothing slides, and things only fade. The page is never held for it: what is drawn is there, and
 * pressable, at once.
 */
const MOVE_MS = 240
const EASE = 'cubic-bezier(0.2, 0, 0, 1)'
const lessMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null
// A dot on a line (a commit's, a state's) pops by itself where the browser animates a pseudo-element.
const POPS = typeof KeyframeEffect === 'function' && 'pseudoElement' in KeyframeEffect.prototype
// The page's own loops (a state's pulse, the command bar's spinner, a busy lane's line), kept in time with the clock
// rather than started again by each drawing that makes their node anew, which made them jump.
const LOOPS = new Set(['pulse', 'spin', 'flow'])

const motion = (() => {
    let depth = 0
    let hushed = true                 // the first drawing arrives whole
    const ghosts = new Map()          // a copy of what went -> where it fades: put back if a drawing meanwhile took it away
    const away = new WeakMap()        // a part of the page sliding out -> its animation, cancelled if it is shown again
    const still = () => Boolean(lessMotion?.matches)
    const onScreen = (box) => box.width + box.height > 0 && box.bottom > -40 && box.top < innerHeight + 40
    const run = (node, keyframes, options) => { try { return node.animate(keyframes, options) } catch { return null } }

    /** Every keyed thing's place, its words, what held it, and what of its own motion is under way. */
    const read = () => {
        const keyed = new Map()
        const aliases = new Map()
        // A fade or a tick part-way goes on in the node drawn in its place, from where it was. A slide does not: the place
        // read below is where it was drawn, part-way or not, and the next slide starts there.
        const effects = new Map()
        for (const one of document.getAnimations()) {
            const target = one.effect?.target
            if (!target || !/^motion-(?!move)/.test(one.id) || one.playState !== 'running') continue
            if (!effects.has(target)) effects.set(target, [])
            effects.get(target).push({ id: one.id, keyframes: one.effect.getKeyframes(), timing: one.effect.getTiming(), pseudo: one.effect.pseudoElement, time: one.currentTime })
        }
        for (const node of document.querySelectorAll('[data-anim]')) {
            const scope = node.closest('[data-anim-scope]')
            const parents = []
            for (let up = node.parentElement; up && up !== scope; up = up.parentElement) parents.push(up)
            keyed.set(node.dataset.anim, { node, scope, parents, box: node.getBoundingClientRect(), sig: node.dataset.sig, effects: effects.get(node) ?? [] })
            const alias = node.dataset.alias
            if (alias) aliases.set(alias, aliases.has(alias) ? null : node.dataset.anim)
        }
        return { keyed, aliases }
    }

    /** A drawing's children keyed by their place where it asks: a lane's first div.facts, its second p.collide. */
    const keyChildren = () => {
        for (const parent of document.querySelectorAll('[data-anim-kids]')) {
            const prefix = parent.dataset.anim ?? parent.dataset.animScope
            const counts = new Map()
            for (const kid of parent.children) {
                if (ghosts.has(kid)) continue
                const kind = `${kid.localName}.${kid.classList[0] ?? ''}`
                const n = counts.get(kind) ?? 0
                counts.set(kind, n + 1)
                if (!kid.dataset.anim) kid.dataset.anim = `${prefix}>${kind}:${n}`
            }
        }
    }

    const slide = (node, x, y, ms = MOVE_MS) => run(node, [{ transform: `translate(${x}px, ${y}px)` }, { transform: 'none' }],
        { duration: ms, easing: EASE, composite: 'add', id: 'motion-move' })
    /** A dot popped: grown from nothing as a commit comes, or shrunk back as a state changes. */
    const pop = (node, from) => {
        if (POPS) run(node, [{ scale: from }, { scale: '1' }], { pseudoElement: '::before', duration: 380, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', id: 'motion-pop' })
    }
    /** Faded in; around anything in it that was drawn elsewhere and slides in (main's name, onto a new commit), not over it. */
    const fade = (node, stayed) => {
        if (![...stayed].some((inner) => node.contains(inner))) {
            run(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 220, delay: 40, easing: 'ease-out', fill: 'backwards', id: 'motion-fade' })
            return
        }
        for (const kid of node.children) if (!stayed.has(kid)) fade(kid, stayed)
    }
    /** A commit that came, washed in the accent and fading to its own ground, so a glance finds it. */
    const wash = (node) => {
        const tint = getComputedStyle(document.body).getPropertyValue('--accent-wash').trim()
        if (tint) run(node, [{ backgroundColor: tint }, { backgroundColor: 'transparent' }], { duration: 1600, easing: 'ease-out', id: 'motion-wash' })
    }
    /** What came: faded in, a commit washed with its dot popped, a lane risen from where it forks, a question dropped into place. */
    const arrive = (node, stayed, calm) => {
        fade(node, stayed)
        if (node.matches('li.commit, li.stack-commit')) {
            if (!node.matches('.pending')) wash(node)
            if (!calm) pop(node, '0')
        } else if (!calm && node.matches('li.lane')) slide(node, 0, 14, 320)
        else if (!calm && node.matches('.confirm, .more-menu, .details-inline, .message-form')) slide(node, 0, -6, 200)
    }
    /** Words that changed where they stand (a lane's state, its gate, a count): the new ones tick over, and a state's dot pops. */
    const tick = (node, calm) => {
        run(node, [{ opacity: 0.2 }, { opacity: 1 }], { duration: 360, easing: 'ease-out', id: 'motion-tick' })
        if (calm) return
        if (node.matches('.state')) pop(node, '1.9')
        // The command bar's ✓ or ✗, as its spinner stops.
        else if (node.matches('.mark')) run(node, [{ scale: '0.4' }, { scale: '1' }], { duration: 380, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)', id: 'motion-pop' })
    }
    /** A commit drawn again under the same words with another hash (made at last, amended, rebased): it settles in place. */
    const settle = (node, calm) => {
        run(node, [{ opacity: 0.55 }, { opacity: 1 }], { duration: 300, easing: 'ease-out', id: 'motion-tick' })
        if (!calm) pop(node, '0.4')
    }
    const carry = (node, { id, keyframes, timing, pseudo, time }) => {
        const again = run(node, keyframes, { ...timing, id, ...(pseudo ? { pseudoElement: pseudo } : {}) })
        if (again && time !== null) again.currentTime = time
    }

    /**
     * What went: a copy of it where it was, inert and fading, inside copies of what held it (emptied of their own look),
     * so the rules that drew it draw it again. A lane that landed slides into main's line as it goes.
     */
    const leave = (old, calm, landed) => {
        const scope = old.scope
        const copy = old.node.cloneNode(true)
        let shell = copy
        for (const parent of [...old.parents, scope]) {
            const outer = parent.cloneNode(false)
            outer.classList.add('leaving-shell')
            outer.append(shell)
            shell = outer
        }
        const ghost = el('div', { class: 'leaving', 'aria-hidden': 'true' }, shell)
        ghost.inert = true
        // Nothing of it is found as the thing itself: no key, no id, no field's name, nothing for the keyboard.
        for (const node of ghost.querySelectorAll('*')) {
            for (const name of node.getAttributeNames()) if (/^(data-|id$|name$|for$|list$|tabindex$)/.test(name)) node.removeAttribute(name)
        }
        Object.assign(copy.style, { width: `${old.box.width}px`, height: `${old.box.height}px`, margin: '0', position: 'relative', top: 'auto', left: 'auto', right: 'auto', bottom: 'auto' })
        scope.append(ghost)
        const at = scope.getBoundingClientRect()
        let [left, top] = [old.box.left - at.left, old.box.top - at.top]
        Object.assign(ghost.style, { left: `${left}px`, top: `${top}px` })
        const drawn = copy.getBoundingClientRect()
        left += old.box.left - drawn.left
        top += old.box.top - drawn.top
        Object.assign(ghost.style, { left: `${left}px`, top: `${top}px` })
        // Mostly gone early, so what moves into its place is not read through it; a lane that landed keeps going a while longer.
        const to = calm ? { transform: 'none' } : landed ? { transform: 'translateX(-28px) scaleY(0.96)' } : { transform: 'translateY(-4px)' }
        const going = run(ghost, [{ opacity: 1, transform: 'none' }, { opacity: landed ? 0.5 : 0.25, offset: 0.3 }, { opacity: 0, ...to }],
            { duration: landed ? 420 : 220, easing: 'cubic-bezier(0.2, 0, 0.4, 1)', fill: 'forwards', id: 'motion-leave' })
        ghosts.set(ghost, scope)
        const gone = () => { ghosts.delete(ghost); ghost.remove() }
        if (going) going.finished.then(gone, gone); else gone()
    }

    /** After a drawing: each keyed thing from where it was to where it is, what came in, and what went out. */
    const play = (was) => {
        keyChildren()
        for (const [ghost, scope] of ghosts) if (!ghost.isConnected && scope.isConnected) scope.append(ghost)
        if (!was) return
        const calm = still()
        const nodes = [...document.querySelectorAll('[data-anim]')]
        const boxes = nodes.map((node) => node.getBoundingClientRect())
        const present = new Set(nodes.map((node) => node.dataset.anim))
        const taken = new Set()       // old keys a new thing took the place of, by its alias
        const shifted = new Map()     // node -> how far from where it is it is drawn now, with what holds it
        const came = new Set()
        const stayed = new Set()
        const arrivals = []
        const places = new Map()      // parent -> where each of its keyed children was and is, and whether it slid
        nodes.forEach((node, index) => {
            const box = boxes[index]
            const holder = node.parentElement?.closest('[data-anim]')
            const held = shifted.get(holder) ?? [0, 0]
            shifted.set(node, held)
            let old = was.keyed.get(node.dataset.anim)
            let morphed = false
            if (!old && node.dataset.alias) {
                const from = was.aliases.get(node.dataset.alias)
                if (from && !present.has(from) && !taken.has(from)) { old = was.keyed.get(from); taken.add(from); morphed = true }
            }
            if (!old) {
                came.add(node)
                // It comes with what holds it, when that came too.
                if (!came.has(holder) && onScreen(box)) arrivals.push(node)
                return
            }
            stayed.add(node)
            if (old.node === node) return
            const [dx, dy] = [old.box.left - box.left, old.box.top - box.top]
            const [x, y] = [dx - held[0], dy - held[1]]
            const slid = !calm && (Math.abs(x) >= 1 || Math.abs(y) >= 1) && (onScreen(box) || onScreen(old.box))
            if (slid) {
                slide(node, x, y)
                shifted.set(node, [dx, dy])
            }
            if (!places.has(node.parentElement)) places.set(node.parentElement, [])
            places.get(node.parentElement).push({ node, from: old.box, to: box, slid })
            for (const effect of old.effects) carry(node, effect)
            if (!onScreen(box)) return
            if (morphed) settle(node, calm)
            else if (old.sig !== undefined && node.dataset.sig !== old.sig) tick(node, calm)
        })
        // Things that change places with each other (a lane newer now than the one above it, a lane moving group in the
        // landing order) pass each other dimmed, so neither is read through the other on the way.
        // Read as a page is: line by line (two things on one line, whatever their heights), then along the line.
        const order = (a, b) => (Math.abs(a.top - b.top) > Math.min(a.height, b.height) / 2 ? a.top - b.top : a.left - b.left)
        for (const all of places.values()) {
            // What is not drawn (an empty line of agents) has no place to pass.
            const siblings = all.filter((one) => one.from.height + one.from.width > 0 && one.to.height + one.to.width > 0)
            if (siblings.length < 2 || !siblings.some((one) => one.slid)) continue
            const before = [...siblings].sort((a, b) => order(a.from, b.from))
            const after = [...siblings].sort((a, b) => order(a.to, b.to))
            for (const one of siblings) {
                if (one.slid && before.indexOf(one) !== after.indexOf(one)) {
                    run(one.node, [{ opacity: 1 }, { opacity: 0.3, offset: 0.45 }, { opacity: 1 }], { duration: MOVE_MS, easing: 'ease-in-out', id: 'motion-dip' })
                }
            }
        }
        // Too many at once (a page of older commits read, a list shown whole) arrive as they are.
        if (arrivals.length <= 40) for (const node of arrivals) arrive(node, stayed, calm)

        const gone = [...was.keyed].filter(([key]) => !present.has(key) && !taken.has(key))
        const goneKeys = new Set(gone.map(([key]) => key))
        // A lane gone as a new commit comes onto main's line beside it has landed there.
        const grew = new Set([...came].filter((node) => node.matches('li.commit')).map((node) => node.closest('[data-anim-scope]')))
        const leaving = gone.filter(([, old]) => {
            if (!onScreen(old.box) || !old.scope?.isConnected || old.scope.closest('[hidden]')) return false
            // Only the outermost of what went: what it held goes with it.
            const holder = old.parents.find((up) => up.dataset?.anim)
            return !holder || !goneKeys.has(holder.dataset.anim)
        })
        if (leaving.length <= 24) for (const [, old] of leaving) leave(old, calm, old.node.matches('li.lane') && grew.has(old.scope))
    }

    /** Each loop of the page's own as far along as the clock says, whichever drawing made its node. */
    const keepTime = () => {
        for (const one of document.getAnimations()) {
            if (LOOPS.has(one.animationName) && one.startTime !== 0) try { one.startTime = 0 } catch { /* not started yet */ }
        }
    }

    /** A drawing, between a reading of where everything is and the motion from there; one inside another is part of it. */
    const moving = (draw) => {
        if (depth > 0) return draw()
        depth++
        let was = null
        try { if (!hushed && !document.hidden) was = read() } catch { was = null }
        try {
            return draw()
        } finally {
            depth--
            hushed = false
            try { play(was) } catch { /* motion is never worth a page left half drawn */ }
            keepTime()
        }
    }

    /** A part of the page shown (the output, a notice, the details): slid in from its edge rather than appearing. */
    const appear = (node, x = 0, y = 0) => {
        if (!node.hidden && !away.has(node)) return
        away.get(node)?.cancel()
        away.delete(node)
        node.hidden = false
        if (document.hidden) return
        run(node, [{ opacity: 0, transform: still() ? 'none' : `translate(${x}px, ${y}px)` }, { opacity: 1, transform: 'none' }], { duration: 200, easing: EASE, id: 'motion-appear' })
    }
    /** And hidden: slid back out, then hidden; shown again meanwhile, it stays. */
    const disappear = (node, x = 0, y = 0, then = () => {}) => {
        if (node.hidden || away.has(node)) return
        const going = document.hidden ? null : run(node, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: still() ? 'none' : `translate(${x}px, ${y}px)` }],
            { duration: 160, easing: 'ease-in', fill: 'forwards', id: 'motion-away' })
        const done = () => { away.delete(node); going?.cancel(); node.hidden = true; then() }
        if (!going) { done(); return }
        away.set(node, going)
        going.finished.then(done, () => {})
    }
    const fadeIn = (node) => run(node, [{ opacity: 0 }, { opacity: 1 }], { duration: 180, easing: 'ease-out', id: 'motion-fade' })

    return { moving, appear, disappear, fadeIn, hush: () => { hushed = true } }
})()
const moving = motion.moving

/** A drawn node given a key of what it is, and words that, when they change, tick over (true: its own text). */
const keyed = (node, key, sig) => {
    if (!node) return node
    node.dataset.anim = key
    if (sig !== undefined && sig !== null) node.dataset.sig = sig === true ? node.textContent : String(sig)
    return node
}
// The parts of the page that are kept between drawings, where what went from them fades.
for (const [id, scope] of [['repos', 'page'], ['cmdbar', 'commands'], ['switcher', 'switcher']]) $(id).dataset.animScope = scope

// ---------------------------------------------------------------------------
// what the page remembers between answers
// ---------------------------------------------------------------------------

let current = null
let lastDrawn = ''
let lastDrawnAt = 0
/** Keep a part of what this page remembers across a reload of its tab: the editor keeps one value for the whole page. */
const keep = (part) => host.remember({ ...(host.recall() ?? {}), ...part })
// `${repo}/${lane}` showing every commit, `…:changes` every uncommitted file; never a lane's ⋯ menu left open by a page before.
const expanded = new Set((host.recall()?.expanded ?? []).filter((key) => !key.endsWith(':more') && !key.endsWith(':files')))
const toggle = (key) => {
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key)
    keep({ expanded: [...expanded] })
    draw(true)
}
// Which repository the page shows: one, by its id, or every one of them (null). A browser keeps it in the address
// (?repo=api), so a tab can be open on each and bookmarked; the editor keeps it with its tab, and a tab opened for
// one repository starts on it (the extension says which in data-repo).
const firstShown = () => {
    if (!host.inEditor) return new URLSearchParams(location.search).get('repo') || null
    const kept = host.recall()
    if (kept && 'only' in kept) return kept.only
    return document.documentElement.dataset.repo || null
}
let only = firstShown()
const pending = new Map()       // `${repo}/${lane}` -> { verb, stage, jobId }
let naming = null               // { repo, sha, from }: the commit row a new lane is being named on
const sections = new Map()      // repo id -> the parts of its section that are kept
let shownJob = null
let shownFrom = 0
// What the details pane shows, ISL's way: a commit chosen ({ repo, sha, lane }), or a lane's message being
// written ({ repo, lane, form: 'commit' | 'amend' | 'reword' }). The side bar shows it under the row instead.
let selected = null
const detailsCache = new Map()  // `${repo path}@${sha}` -> { value }: a commit's words and files, which never change
const drafts = new Map()        // `${lane key}:${form}` -> { title, description }: a message being written, kept across redraws
const unchecked = new Map()     // lane key -> paths left out of the next commit or discard; every file is in by default
let optimistic = []             // what a press accepted will do, drawn before it has: { jobId, body, at }
let dragging = null             // { repo, lane } while a lane is dragged

// A press made while its repository is busy waits its turn (the service queues it), so buttons stay pressable;
// only a full line, five waiting, stops them.
const QUEUE_FULL = 5
const busyIn = (repoId) => (current?.jobs ?? []).filter((job) => job.repo === repoId && job.state === 'queued').length >= QUEUE_FULL
const jobById = (id) => (current?.jobs ?? []).find((job) => job.id === id)
const pressedHere = new Set()   // jobs this page pressed: one of them failing opens its output
const showWhenDone = new Set()  // jobs whose output is the point of them (adopt's: what to decide next), opened when they end

// ---------------------------------------------------------------------------
// asking
// ---------------------------------------------------------------------------

const notice = (message, tone = 'risk') => {
    const box = $('notice')
    clearTimeout(notice.timer)
    // Its words stay while it slides away, and go with it.
    if (!message) { motion.disappear(box, 0, -6); return }
    box.textContent = message
    box.classList.toggle('ok', tone === 'ok')
    motion.appear(box, 0, -6)
    notice.timer = setTimeout(() => motion.disappear(box, 0, -6), 10000)
}

const took = (state) => {
    current = state
    for (const job of state.jobs ?? []) doneHere(job)
    settleOptimistic()
    const updated = $('updated')
    updated.classList.remove('lost')
    updated.textContent = 'Up to date'
    draw()
    drawAgents()
}

const refresh = async () => {
    try {
        took(await host.state())
    } catch {
        // A page waiting across a restart of its own server loses it for seconds: say so and
        // ask again, never take the silence for an answer.
        const updated = $('updated')
        updated.classList.add('lost')
        updated.textContent = host.inEditor ? 'LaneKit did not answer; asking again' : 'Cannot reach the lanes server; asking again'
    }
}

const loop = async () => {
    await refresh()
    setTimeout(loop, host.inEditor ? ASK_IN_EDITOR_MS : document.hidden ? ASK_HIDDEN_MS : ASK_EVERY_MS)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })

// The editor tells the page what changed, and which lane to show when asked from outside it.
host.on('state', (message) => took(message.state))
host.on('agents', (message) => {
    if (!current) return
    current = { ...current, agents: message.agents }
    drawAgents()
})
host.on('job', (message) => {
    if (message.job && current) {
        const jobs = current.jobs ?? (current.jobs = [])
        const at = jobs.findIndex((job) => job.id === message.job.id)
        const before = at >= 0 ? jobs[at] : null
        if (at >= 0) jobs[at] = message.job; else jobs.unshift(message.job)
        if (!before || before.step !== message.job.step || before.state !== message.job.state) draw(true)
        doneHere(message.job)
        failedHere(message.job)
    }
    if (message.id === shownJob) followJob(message.id)
})
/** A press whose output is the point of it opens that output when it ends, well or badly. */
const doneHere = (job) => {
    if (!job || job.state !== 'done' || !showWhenDone.has(job.id)) return
    showWhenDone.delete(job.id)
    pressedHere.delete(job.id)
    if (shownJob !== job.id) showJob(job.id)
}
/** A press made on this page that ended badly opens its output, once: what went wrong is there. */
const failedHere = (job) => {
    if (!job || job.state !== 'done' || job.code === 0 || !pressedHere.has(job.id)) return
    pressedHere.delete(job.id)
    if (shownJob !== job.id) showJob(job.id)
}

// A running press's clock, each second, without redrawing anything else.
const secondsSince = (at) => `${Math.max(0, Math.round((Date.now() - at) / 1000))} s`
setInterval(() => {
    // Only a clock that says since when: the copy of one fading where it was says nothing, and stops.
    for (const node of document.querySelectorAll('.live-clock[data-since]')) node.textContent = secondsSince(Number(node.dataset.since))
}, 1000)
host.on('focus', (message) => focusLane(message.repo, message.lane))

const press = async (body) => {
    let pressed
    try {
        pressed = await host.press(body)
    } catch {
        notice(host.inEditor ? 'LaneKit did not answer; nothing was run.' : 'The lanes server did not answer; nothing was run.')
        return null
    }
    const answer = pressed.body
    if (pressed.status >= 400) {
        notice(answer?.error ?? `Refused (${pressed.status}).`)
        return null
    }
    notice('')
    // ISL's way: what it will do is drawn at once, and the command bar says how it is going; the output opens by
    // itself only if it fails (followed in host.on('job') and drawCommandBar).
    pressedHere.add(answer.id)
    expect(body, answer)
    if (current) {
        const jobs = current.jobs ?? (current.jobs = [])
        if (!jobs.some((job) => job.id === answer.id)) jobs.unshift(answer)
    }
    draw(true)
    await refresh()
    return answer
}

// ---------------------------------------------------------------------------
// the drawer: what a press ran, as it runs
// ---------------------------------------------------------------------------

const showJob = (id) => {
    shownJob = id
    shownFrom = 0
    $('job-out').textContent = ''
    motion.appear($('job'), 0, 24)
    followJob(id)
    drawCommandBar()
}

// One ask at a time: the editor's "more output" arrives while an ask is out, and two asks
// from the same place would print the same output twice.
let following = null
let followAgain = false
const followJob = async (id) => {
    if (shownJob !== id) return
    if (following === id) { followAgain = true; return }
    following = id
    let job = null
    try {
        job = await host.job(id, shownFrom)
    } catch {
        job = null
    }
    following = null
    if (!job) { setTimeout(() => followJob(id), 2000); return }
    if (shownJob !== id) return
    const out = $('job-out')
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 8
    if (job.gap) out.append('… (the start of this output was too long to keep)\n')
    out.append(job.output)
    shownFrom = job.next
    if (atBottom) out.scrollTop = out.scrollHeight

    const what = `${job.verb}${job.dryRun ? ' (check)' : ''}${job.lane ? ` · ${job.lane}` : ''}`
    const box = $('job-state')
    if (job.state === 'running') {
        box.className = 'state info'
        box.textContent = `Running ${what}`
        if (followAgain) { followAgain = false; followJob(id) } else setTimeout(() => followJob(id), host.inEditor ? 3000 : 1000)
    } else {
        followAgain = false
        box.className = `state ${job.code === 0 ? 'done' : 'risk'}`
        box.textContent = job.code === 0 ? `Finished ${what}` : `Failed ${what} (exit ${job.code})`
        refresh()
    }
    $('job-command').textContent = job.command
}

$('job-close').addEventListener('click', () => {
    shownJob = null
    motion.disappear($('job'), 0, 24, drawCommandBar)
})
document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('job').hidden) $('job-close').click()
})

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

/** What a lane's state is, in a dashboard's words: [tone, word, detail]. */
const statusOf = (lane) => {
    if (lane.kind === 'missing') return ['risk', 'Folder is gone', 'git worktree prune, in the main checkout, clears it away']
    if (lane.aside) return ['quiet', 'Set aside', null]
    if (lane.operation) return ['warn', lane.operation === 'rebase' ? 'Mid-rebase' : 'Mid-merge', 'Finish or abort it in the lane before anything else']
    if (lane.kind === 'landed') return lane.dirty ? ['warn', 'Landed, with work since', 'Move it to a new lane before this one is swept: a sweep would delete it'] : ['done', 'Landed', null]
    if (lane.kind === 'fresh' && !lane.dirty) return ['quiet', 'Nothing committed yet', null]
    const queue = lane.queue
    if (!queue) return ['quiet', 'Not planned', null]
    switch (queue.verdict) {
        case 'land now': return ['done', 'Ready to land', null]
        case 'gate now': return ['info', 'Needs a gate', queue.why ? `Earns tier ${queue.tier}: ${queue.why}` : null]
        case 'hold the gate': {
            const first = queue.collisions.map((collision) => collision.lane).join(', ')
            return ['warn', `Wait for ${first || 'another lane'}`, 'It should land first: landing this one now would void its gate']
        }
        case 'commit first': return ['warn', 'Uncommitted changes', 'The gate and a land both need them committed']
        case 'rebase first': return ['risk', 'Conflicts with main', 'It no longer merges cleanly: rebase it in the lane']
        case 'parked': return ['warn', 'Parked', queue.why]
        default: return ['quiet', queue.verdict, queue.why]
    }
}

/** Where GitHub said main may not be pushed to straight, a lane lands by its pull request, merged on GitHub. */
const byPullRequest = (repo) => repo.github?.rules?.push?.allowed === false
/**
 * A lane going on by its pull request: its state in a word, and the one thing to press next (`next`: pr, push,
 * push-force, update, ready, review, merge, rebase, pull, carry or drop), or none while it waits on somebody.
 *
 * Said wherever main lands: a pull request merged on GitHub, with any work made since (commits after the one it was
 * merged at, or files not committed) to carry into a new lane, since none of it is in a pull request now; and a lane
 * whose copy on origin has commits it lacks, which pushing would take away. The rest only where main lands by pull
 * request, and only once nothing here comes first (uncommitted work, a conflict with main, a lane part-way). Null where
 * the usual words say it. Plain data in and out, so lanekit's tests run it as it is written here (test/github.test.mjs).
 */
const prStepOf = (repo, lane) => {
    const pr = lane.pull
    const base = repo.integrationBranch
    const up = lane.upstream
    // A review of somebody's pull request: what its author pushed since, brought here; else what you make of it.
    if (lane.review && !lane.operation) {
        const by = pr?.author ? ` by ${pr.author}` : ''
        if (pr && pr.state !== 'OPEN') return { tone: 'done', word: `#${lane.review} ${pr.state === 'MERGED' ? 'merged' : 'closed'}`, detail: 'Nothing left to review: drop this lane', next: 'drop' }
        if (up && up.behind > 0 && !up.ahead) return { tone: 'info', word: `Reviewing #${lane.review}${by}`, detail: `${up.behind} new from its author: pull ${up.behind === 1 ? 'it' : 'them'} first`, next: 'update' }
        return { tone: 'info', word: `Reviewing #${lane.review}${by}`, detail: pr?.title ?? null, next: 'verdict' }
    }
    if (lane.kind !== 'working' || lane.operation) return null
    if (pr?.state === 'MERGED') {
        const behind = repo.main?.upstream?.behind > 0
        const since = lane.sinceMerge ?? 0
        const left = [since ? `${since} ${since === 1 ? 'commit' : 'commits'} made since` : null, lane.dirty ? `${lane.dirty} uncommitted ${lane.dirty === 1 ? 'file' : 'files'}` : null].filter(Boolean)
        if (left.length) {
            return {
                tone: 'risk', word: 'Merged on GitHub, with work since',
                detail: `#${pr.number} was merged without ${left.join(' and ')}, which no pull request has: ${behind ? `pull ${base}, then ` : ''}move ${left.length > 1 || since > 1 || lane.dirty > 1 ? 'them' : 'it'} to a new lane`,
                next: behind ? 'pull' : 'carry'
            }
        }
        return behind
            ? { tone: 'done', word: 'Merged on GitHub', detail: `Pull ${base} to bring it here`, next: 'pull' }
            : { tone: 'done', word: 'Merged on GitHub', detail: `Squashed or rebased there, so its commits are not ${base}'s own: drop it, and its branch stays`, next: 'drop' }
    }
    if (lane.dirty) return null
    // Its copy on origin has commits this lane lacks: brought here first, never pushed over.
    if (up && up.behind > 0 && !up.ahead) return { tone: 'info', word: `${up.behind} new on ${up.name}`, detail: 'Somebody pushed to it: pull, and it fast-forwards', next: 'update' }
    if (up && up.behind > 0 && up.foreign) return { tone: 'risk', word: `Diverged from ${up.name}`, detail: `${up.name} has ${up.foreign} ${up.foreign === 1 ? 'commit' : 'commits'} of somebody else's that this lane lacks: bring ${up.foreign === 1 ? 'it' : 'them'} in (git pull --rebase, in the lane) before pushing`, next: null }
    if (repo.github?.rules?.push?.allowed !== false) return null
    const verdict = lane.queue?.verdict
    if (verdict === 'commit first' || verdict === 'rebase first' || verdict === 'parked') return null
    const open = pr?.state === 'OPEN' ? pr : null
    if (!open) return verdict === 'land now' ? { tone: 'done', word: 'Ready for a pull request', detail: `${base} takes its changes by pull request`, next: 'pr' } : null
    if (up && up.behind > 0) return { tone: 'warn', word: 'Rebased since it was pushed', detail: `#${open.number} has its old commits until it is pushed again`, next: 'push-force' }
    if (!up || up.ahead > 0) return { tone: 'info', word: `Not all on #${open.number} yet`, detail: 'Push what is new, and the pull request has it', next: 'push' }
    if (open.draft) return { tone: 'quiet', word: 'Draft pull request', detail: 'Ready for review when it is', next: 'ready' }
    if (open.mergeState === 'DIRTY') return { tone: 'risk', word: `Conflicts with ${base} on GitHub`, detail: 'Rebase it here, then push it', next: lane.behind > 0 ? 'rebase' : null }
    if (open.review === 'CHANGES_REQUESTED') return { tone: 'warn', word: 'Changes requested', detail: 'Work in the lane, commit, and push', next: null }
    if (open.checks === 'failing') return { tone: 'risk', word: 'Checks failing on GitHub', detail: null, next: null }
    if (open.mergeState === 'BEHIND') return { tone: 'warn', word: `Behind ${base} on GitHub`, detail: `${base} wants it up to date: rebase it here, then push it`, next: lane.behind > 0 ? 'rebase' : null }
    if (open.review === 'REVIEW_REQUIRED') return { tone: 'info', word: 'Waiting for review', detail: null, next: open.requested?.length ? null : 'review' }
    if (open.checks === 'pending') return { tone: 'info', word: 'Checks running on GitHub', detail: null, next: null }
    return { tone: 'done', word: open.review === 'APPROVED' ? 'Approved: ready to merge' : 'Ready to merge', detail: null, next: 'merge' }
}

/**
 * Why a lane's buttons are not pressable yet, in a few words, or null where they are: they are drawn either way, so
 * what a lane still needs is said on the button itself (the owner, 2 Oct). Plain data in and out, so lanekit's tests
 * run them as they are written here (test/page.test.mjs).
 *
 * The main checkout first, for whatever lands or pulls there: on the integration branch, not part-way, and clean.
 */
const mainBlockOf = (repo) => {
    const main = repo.main ?? {}
    const base = repo.integrationBranch
    if (main.onIntegration === false) return `The main checkout is on ${main.branch}, not ${base}`
    if (main.operation) return `The main checkout is part-way through a ${main.operation}`
    if (main.dirty) return `The main checkout has ${main.dirty} uncommitted ${main.dirty === 1 ? 'file' : 'files'}: move them to a lane, or discard them, first`
    return null
}
/** A gate names a commit: one of the lane's own, with nothing uncommitted beside it. */
const gateBlockOf = (lane) => {
    if (lane.operation) return `Finish its ${lane.operation} first`
    if (lane.pull?.state === 'MERGED') return `#${lane.pull.number} is merged on GitHub already`
    if (lane.dirty) return 'Commit first: a gate result names a commit, and uncommitted changes are in none'
    if (!(lane.ahead > 0)) return 'Nothing committed yet to gate'
    return null
}
/** A land needs a lane gated green on its newest commit, first among those it collides with, and a main ready for it. */
const landBlockOf = (repo, lane) => {
    const base = repo.integrationBranch
    if (lane.operation) return `Finish its ${lane.operation} first`
    if (lane.pull?.state === 'MERGED') return `#${lane.pull.number} is merged on GitHub already`
    if (lane.dirty) return 'Commit first: a land takes commits, and uncommitted changes are in none'
    if (!(lane.ahead > 0)) return 'Nothing committed yet to land'
    const main = mainBlockOf(repo)
    if (main) return main
    const queue = lane.queue
    switch (queue?.verdict) {
        case 'land now': return null
        case 'gate now': return lane.gate?.current && lane.gate.result === 'failed' ? 'Its gate failed on this commit: fix it, commit, and gate it again' : 'Gate it first: a land needs a green gate on its newest commit'
        case 'hold the gate': return `Wait for ${(queue.collisions ?? []).map((collision) => collision.lane).join(' and ') || 'another lane'} to land first: they change the same files`
        case 'rebase first': return `Rebase it first: it no longer merges cleanly with ${base}`
        case 'commit first': return 'Commit first: a land takes commits, and uncommitted changes are in none'
        case 'parked': return 'Finish its rebase first'
        default: return 'The landing order has no word on it yet'
    }
}
/** Pull, for main: a fast-forward to origin's, so main behind it, not ahead as well, and its checkout ready. */
const pullBlockOf = (repo) => {
    const up = repo.main?.upstream
    const base = repo.integrationBranch
    if (!up?.behind) return 'Nothing to pull'
    if (up.ahead) return `${base} and ${up.name} have diverged, ${up.ahead} here and ${up.behind} there: that needs a person, not a fast-forward`
    return mainBlockOf(repo)
}

/** A lane's last gate, where there is one. None is not said: the lane's state says what it needs instead. */
const gateOf = (lane) => {
    const gate = lane.gate
    if (!gate) return null
    const when = gate.at ? ` · ${ago(gate.at)}` : ''
    let node
    if (gate.result === 'passed' && gate.current && !gate.narrowed) node = state('done', `Gate passed · tier ${gate.tier}${when}`, 'small')
    else if (gate.result === 'passed' && gate.current) node = state('warn', `Under-gated: tier ${gate.tier} of ${gate.earned}${when}`, 'small')
    else if (gate.result === 'passed') node = state('quiet', `Last gate passed, on an older commit${when}`, 'small')
    else if (gate.current) node = state('risk', `Gate failed · tier ${gate.tier}${when}`, 'small')
    else node = state('quiet', `Last gate failed, on an older commit${when}`, 'small')
    node.title = exactly(gate.at)
    return node
}

const pushedOf = (lane) => {
    const up = lane.upstream
    if (!up) return el('span', { text: 'Not pushed' })
    if (up.behind && up.ahead && up.foreign) return state('risk', `Diverged from ${up.name}: ${up.ahead} here, ${up.behind} there`, 'small')
    if (up.behind && up.ahead) return el('span', { text: `Rebased since it was pushed`, title: `${up.name} has its old commits until it is pushed again` })
    if (up.ahead) return el('span', { text: `${plural(up.ahead, 'commit')} not pushed` })
    if (up.behind) return state('info', `${up.behind} new on ${up.name}`, 'small')
    return el('span', { text: 'Pushed' })
}

const pullOf = (lane) => {
    const pr = lane.pull
    if (!pr) return null
    const word = pr.draft && pr.state === 'OPEN' ? 'draft' : pr.state.toLowerCase()
    const href = safeHref(pr.url)
    const label = `#${pr.number} ${word}`
    const node = href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label }) : el('span', { text: label })
    node.title = pr.title
    return node
}

/** What serves on a lane's port, said only while something does: an idle port is its name's title, not a line. */
const serverOf = (lane) => (lane.port && lane.serving ? state('done', `Serving on ${lane.port}`, 'small') : null)
const portOf = (lane) => (lane.port ? `${lane.name}: port ${lane.port}${lane.serving ? ', serving' : ', nothing serving on it'}` : `${lane.name}: no port`)

// ---------------------------------------------------------------------------
// agents: each one at work, on the lane it works in, with what it is doing
// ---------------------------------------------------------------------------

const AGENT_NAMES = { claude: 'Claude', opencode: 'OpenCode' }
const AGENT_STATES = { ready: ['quiet', 'Ready'], thinking: ['info', 'Thinking'], running: ['info', 'Running'], 'needs-you': ['warn', 'Needs you'], done: ['done', 'Done'], failed: ['risk', 'Failed'] }
const agentsOf = (repoId, laneName) => (current?.agents ?? []).filter((agent) => agent.repo === repoId && agent.lane === laneName)

/** One agent: its name, its state (the tool it runs or asks for beside it), since when; in the editor, a click for its terminal. */
const agentChip = (repo, agent) => {
    const [tone, word] = AGENT_STATES[agent.state] ?? ['quiet', agent.state]
    const name = AGENT_NAMES[agent.agent] ?? agent.agent
    const busy = agent.state === 'thinking' || agent.state === 'running'
    const chip = el('span', {
        class: `agent-chip${busy ? ' busy' : ''}${agent.state === 'needs-you' ? ' needs-you' : ''}`,
        'data-anim': `agent:${agent.key}`, 'data-sig': `${agent.state} ${agent.tool ?? ''}`
    },
        icon('agent'),
        el('span', { class: 'agent-name', text: name }),
        state(tone, agent.tool && (agent.state === 'running' || agent.state === 'needs-you') ? `${word} · ${agent.tool}` : word, 'small'),
        el('span', { class: 'when', text: short(agent.since) }))
    const about = `${name} in ${agent.lane ?? `${repo.id}'s main checkout`}: ${word.toLowerCase()} since ${exactly(agent.since)}`
    if (!host.inEditor) { chip.title = about; return chip }
    return opens(chip, `${about}. Click for its terminal`, () => openIn('agent-terminal', { repo: repo.path, key: agent.key }))
}

const wantsOf = (repoId, laneName) => agentsOf(repoId, laneName).filter((agent) => agent.state === 'needs-you')
/** A lane whose agent waits on you, said beside its name, where a glance down the page finds it: always there, and
    empty (and so not drawn) while nobody waits, so the next word from an agent is drawn into it. */
const wantsWords = (repoId, laneName) => {
    const wanting = wantsOf(repoId, laneName)
    if (!wanting.length) return ''
    return wanting.length === 1 ? `${AGENT_NAMES[wanting[0].agent] ?? wanting[0].agent} needs you` : `${wanting.length} agents need you`
}
const wantsBadge = (repoId, laneName) => el('span', { class: 'wants-badge', 'data-wants': `${repoId}/${laneName}`, text: wantsWords(repoId, laneName) })

/** Every lane's ⋯ menu closed; whether one was open. A click anywhere else, or Escape, closes them. */
const closeMenus = () => {
    const open = [...expanded].filter((key) => key.endsWith(':more'))
    for (const key of open) expanded.delete(key)
    if (open.length) host.remember({ expanded: [...expanded] })
    return open.length > 0
}
document.addEventListener('click', (event) => { if (!event.target.closest?.('.more-wrap') && closeMenus()) draw(true) })
// Escape closes one wherever the keyboard is, its own ⋯ button included.
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && closeMenus()) { event.preventDefault(); draw(true) } })

/** A lane's name; in the editor a click on it is its terminal, the thing most often done with a lane (the owner, 1 Oct). */
const laneName = (repo, lane) => {
    const name = el('span', { class: 'tag lane-name', text: lane.name, title: portOf(lane) })
    if (!host.inEditor || !lane.exists) return name
    return opens(name, `${portOf(lane)}. Click for its terminal: your terminal moves to ${lane.name}, and the files you have open reopen from it`,
        () => openIn('goto', { repo: repo.path, lane: lane.name }))
}

/** A lane's agents (or the main checkout's, with no lane), on a line of their own: there and empty when there are none,
    so the next word from an agent is drawn into it. */
const agentsRow = (repo, laneName) => el('div', { class: 'agents', 'data-agents': `${repo.id}/${laneName ?? ''}` },
    agentsOf(repo.id, laneName).map((agent) => agentChip(repo, agent)))

/** The agents alone, drawn again where they are: they change every few seconds while one works, and a whole page
    drawn again under a pointer loses a click. */
const drawAgents = () => moving(redrawAgents)
const redrawAgents = () => {
    for (const row of document.querySelectorAll('.agents[data-agents]')) {
        const at = row.dataset.agents.indexOf('/')
        const repo = current?.repos.find((candidate) => candidate.id === row.dataset.agents.slice(0, at))
        if (repo) row.replaceChildren(...agentsOf(repo.id, row.dataset.agents.slice(at + 1) || null).map((agent) => agentChip(repo, agent)))
    }
    for (const badge of document.querySelectorAll('.wants-badge[data-wants]')) {
        const at = badge.dataset.wants.indexOf('/')
        const words = wantsWords(badge.dataset.wants.slice(0, at), badge.dataset.wants.slice(at + 1))
        badge.textContent = words
        badge.closest('li.lane')?.classList.toggle('wants-you', Boolean(words))
    }
    for (const row of document.querySelectorAll('.home-agents[data-home-agents]')) {
        const repo = current?.repos.find((candidate) => candidate.id === row.dataset.homeAgents)
        if (!repo) continue
        const glance = glanceOf(repo, current.agents ?? [], current.jobs ?? [], current.reviews ?? [])
        row.replaceChildren(...homeAgentsOf(repo, glance))
        row.closest('.home-card')?.classList.toggle('wants-you', glance.needsYou > 0)
    }
    markPointer()
}

/**
 * A lane's terminal, in the editor, as an icon: the terminal in use follows to this lane (or, with no lane, to the main
 * checkout) and takes the focus, or one opens there, and the files open from elsewhere reopen from it; no window opens.
 * It was called Goto, after ISL's, until the owner said (2 Oct) that a terminal is what it is for: work goes on in many
 * places at once, so there is no one place you are to move.
 */
const terminalButton = (repo, lane, extra = {}) => host.inEditor && (!lane || lane.exists)
    ? iconButton('terminal', `Terminal in ${lane ? lane.name : `${repo.id}'s main checkout`}`, {
        ...extra,
        title: `Terminal in ${lane ? lane.name : `${repo.id}'s main checkout`}: your terminal moves there and comes forward, and the files you have open reopen from it`,
        onclick: (event) => { event.stopPropagation(); openIn('goto', { repo: repo.path, lane: lane?.name }) }
    }, true)
    : null

const openLinks = (repo, lane) => {
    if (host.inEditor) {
        // In the editor: its changes as diffs, an agent in it, and its terminal.
        if (!lane.exists) return []
        const holds = lane.kind === 'working' || lane.dirty > 0
        return [
            holds ? iconButton('diff', 'Changes', {
                title: `Everything ${lane.name} holds that ${repo.integrationBranch} does not, committed or not, side by side`,
                onclick: () => openIn('changes', { repo: repo.path, lane: lane.name })
            }) : null,
            iconButton('agent', 'Agent', {
                title: `Start Claude Code or OpenCode in ${lane.name}, in a terminal named for it and in its colour`,
                onclick: () => openIn('agent', { repo: repo.path, lane: lane.name })
            }),
            terminalButton(repo, lane)
        ]
    }
    const links = []
    const open = current?.open ?? {}
    if (open.sshHost) {
        links.push(el('a', {
            class: 'btn', text: 'VS Code',
            href: `vscode://vscode-remote/ssh-remote+${encodeURIComponent(open.sshHost)}${encodeURI(lane.path)}`,
            title: `Open ${lane.path} in VS Code on this Mac`
        }))
    }
    if (open.browserEditor && !/^\s*[a-z]+:/i.test(open.browserEditor)) {
        links.push(el('a', {
            class: 'btn', text: 'Browser', target: '_blank', rel: 'noopener',
            href: `${open.browserEditor}${encodeURIComponent(lane.path)}`,
            title: `Open ${lane.path} in the browser editor`
        }))
    }
    return links
}

const showCommit = (repo, commit) => () => openIn('commit', { repo: repo.path, sha: commit.sha })

const DOING = { gate: 'Gating', land: 'Landing', rebase: 'Rebasing', push: 'Pushing', pr: 'Opening a pull request', sweep: 'Sweeping', new: 'Making it', pull: 'Pulling', fetch: 'Fetching', review: 'Sending the review' }
const runningIn = (repo, lane) => (current?.jobs ?? []).find((job) => job.state === 'running' && job.repo === repo.id && job.lane === lane.name)

/** What a press is doing to a lane, live: the verb, the gate's step, and a clock. */
const liveOf = (repo, lane) => {
    const job = runningIn(repo, lane)
    if (!job) return null
    const key = `${repo.id}/${lane.name}`
    return el('p', { class: 'live', 'data-anim': `${key}:live` },
        keyed(state('info', `${DOING[job.verb] ?? job.verb}${job.dryRun ? ' (a check)' : ''}`, 'small'), `${key}:live-verb`, true),
        job.step ? el('span', { class: 'live-step', text: job.step, 'data-anim': `${key}:live-step`, 'data-sig': job.step }) : null,
        el('span', { class: 'live-clock', 'data-since': String(job.startedAt), text: secondsSince(job.startedAt) }),
        el('button', { type: 'button', class: 'btn link', text: 'Output', onclick: () => showJob(job.id) }))
}

// A file and a line in a tool's output: src/app.js:12, ./web/x.ts:3:7, /work/repo-lane/y.py:40.
const FILE_AT = /((?:\.{1,2}\/|\/)?(?:[\w@.-]+\/)*[\w@.-]+\.[A-Za-z][\w]*):(\d+)(?::(\d+))?/g

/** A failed step's last lines; in the editor each file reference opens at its line. */
const tailOf = (repo, lane, text) => {
    const pre = el('pre', { class: 'tail' })
    for (const line of String(text ?? '').split('\n')) {
        let from = 0
        for (const match of line.matchAll(FILE_AT)) {
            pre.append(line.slice(from, match.index))
            const ref = el('span', { class: 'ref', text: match[0] })
            pre.append(opens(ref, `Open ${match[1]} at line ${match[2]}`,
                () => openIn('file-at', { repo: repo.path, lane: lane.name, path: match[1], line: Number(match[2]), column: Number(match[3] ?? 1) })))
            from = match.index + match[0].length
        }
        pre.append(line.slice(from) + '\n')
    }
    return pre
}

/** Why the lane's gate on this commit failed: each failing step, and its last lines. */
const failureOf = (repo, lane) => {
    const gate = lane.gate
    if (!gate || gate.result !== 'failed' || !gate.current || !gate.failures?.length) return null
    return el('div', { class: 'failure' }, gate.failures.flatMap((failure) => [
        el('div', { class: 'files-head', text: `${failure.what} failed${failure.status !== null && failure.status !== undefined ? ` (exit ${failure.status})` : ''}` }),
        failure.tail ? tailOf(repo, lane, failure.tail) : null
    ]))
}

/** A new lane's name, typed in the row of the commit it will start from. Enter makes it; Escape leaves it. */
const namingForm = (repo, commit, from) => {
    const draftKey = `name:${repo.id}:${commit.sha}`
    const input = el('input', {
        name: 'name', placeholder: 'its name, like practice-mode', autocomplete: 'off', spellcheck: 'false', pattern: '[a-z0-9][a-z0-9\\-]*', required: true,
        'data-draft': draftKey, oninput: (event) => drafts.set(draftKey, { title: event.target.value }),
        title: 'Lowercase letters, digits and dashes: it becomes a folder and a branch', 'aria-label': `A name for a new lane from "${commit.subject}"`
    })
    const form = el('form', {
        class: 'name-lane',
        onsubmit: async (event) => {
            event.preventDefault()
            if (!form.reportValidity()) return
            const name = input.value.trim()
            naming = null
            draw(true)
            await press({ repo: repo.id, verb: 'new', name, base: commit.sha })
        },
        onkeydown: (event) => { if (event.key === 'Escape') { event.preventDefault(); naming = null; draw(true) } }
    }, input,
    el('button', { type: 'submit', class: 'btn primary', text: 'Make it' }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { naming = null; draw(true) } }),
    el('span', { class: 'muted from', text: from ? `on top of ${from}` : `from ${commit.subject}`, title: `${commit.short} ${commit.subject}` }))
    input.value = drafts.get(draftKey)?.title ?? ''
    if (!input.value) setTimeout(() => input.focus(), 0)
    return form
}
const isNaming = (repo, commit) => naming && naming.repo === repo.id && naming.sha === commit.sha
const startNaming = (repo, commit, from = null) => { naming = { repo: repo.id, sha: commit.sha, from }; draw(true) }

/**
 * What a commit row offers on hover, ISL's way, in place of its age: Uncommit on a lane's newest commit, a new lane
 * from it, and its hash to the clipboard. A click on the row itself chooses it; in the editor a double click opens it.
 */
const rowActions = (repo, commit, from = null, lane = null) => {
    if (commit.pending) return null
    const newest = Boolean(lane && lane.stack?.[0]?.sha === commit.sha && lane.ahead > 0 && !lane.operation && !lane.pending)
    const tip = !lane && repo.spine?.[0]?.sha === commit.sha
    return el('span', { class: 'row-actions' },
        newest || tip ? terminalButton(repo, lane, { class: 'btn quiet' }) : null,
        newest ? iconButton('uncommit', 'Uncommit', {
            class: 'btn solid', disabled: busyIn(repo.id),
            title: 'Take this commit back out, its changes left uncommitted',
            onclick: (event) => { event.stopPropagation(); uncommitLane(repo, lane) }
        }) : null,
        iconButton('branch', 'New lane here', {
            class: 'btn quiet', disabled: busyIn(repo.id),
            title: from ? `New lane here: on top of ${from}, from this commit` : 'New lane here: a lane of its own, starting from this commit',
            onclick: (event) => { event.stopPropagation(); startNaming(repo, commit, from) }
        }, true),
        iconButton('copy', `Copy ${commit.short}'s hash`, {
            class: 'btn quiet',
            onclick: (event) => { event.stopPropagation(); copyHash(commit.sha) }
        }, true))
}

/**
 * Dragging a lane over main's log draws it where it would start, ISL's preview: a ghost of the lane above the commit
 * under the pointer, which a drop asks about. Listened for once, on the log, which a redraw keeps.
 */
const LANE_DRAG = 'text/x-lanekit-lane'
/**
 * Where a lane dropped on a commit of main would move: back (onto a commit older than the one it starts from), forward,
 * or where it is, and past which of main's commits: those it would no longer have under it, or those it would gain.
 * Plain data in and out, and nothing else of the page's, so lanekit's tests run it as it is written here
 * (test/rebase.test.mjs). The log is newest first: a commit further down it is older.
 */
const ontoOf = (spine, base, sha) => {
    const to = spine.findIndex((commit) => commit.sha === sha)
    const from = spine.findIndex((commit) => commit.sha === base)
    if (to === -1) return { way: 'unknown', count: 0, commits: [] }
    if (from === -1) return { way: 'forward', count: null, commits: [] }
    if (to === from) return { way: 'here', count: 0, commits: [] }
    if (to > from) return { way: 'back', count: to - from, commits: spine.slice(from, to) }
    return { way: 'forward', count: from - to, commits: spine.slice(to, from) }
}
const clearPreview = (log) => {
    for (const node of (log ?? document).querySelectorAll('li.drag-ghost')) node.remove()
    for (const node of (log ?? document).querySelectorAll('li.drop-here')) node.classList.remove('drop-here')
}
const previewAt = (log, row) => {
    const ghost = log.querySelector('li.drag-ghost')
    if (ghost?.dataset.sha === row.dataset.sha) return
    clearPreview(log)
    const repo = current?.repos.find((candidate) => candidate.id === dragging?.repo)
    const lane = repo?.lanes.find((candidate) => candidate.name === dragging?.lane)
    if (!lane || lane.base === row.dataset.sha) return
    row.classList.add('drop-here')
    const move = ontoOf(repo.spine, lane.base, row.dataset.sha)
    const where = move.way === 'back' ? `would move back here, ${plural(move.count, 'commit')} of ${repo.integrationBranch} fewer under it`
        : move.way === 'forward' && move.count ? `would move forward here, onto ${plural(move.count, 'newer commit')}` : 'would start here'
    const shadow = el('li', { class: 'lane drag-ghost', 'data-sha': row.dataset.sha, 'aria-hidden': 'true' },
        el('ul', { class: 'stack' }, (lane.stack ?? []).slice(0, STACK_SHOWN).map((commit) => el('li', { class: 'stack-commit' }, el('span', { class: 'subject', text: commit.subject })))),
        el('div', { class: 'lane-head' }, el('div', { class: 'lane-title' }, el('span', { class: 'tag lane-name', text: lane.name }), el('span', { class: 'muted small', text: where }))),
        forkCurve())
    row.before(shadow)
}
const listenForDrops = (log) => {
    log.addEventListener('dragover', (event) => {
        if (!dragging || !event.dataTransfer?.types?.includes(LANE_DRAG)) return
        const row = event.target.closest?.('li.commit[data-sha], li.drag-ghost')
        if (!row || !log.contains(row)) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (!row.classList.contains('drag-ghost')) previewAt(log, row)
    })
    log.addEventListener('dragleave', (event) => { if (!log.contains(event.relatedTarget)) clearPreview(log) })
    log.addEventListener('drop', (event) => {
        const sha = log.querySelector('li.drag-ghost')?.dataset.sha
        clearPreview(log)
        const key = event.dataTransfer?.getData(LANE_DRAG)
        const repo = current?.repos.find((candidate) => key?.startsWith(`${candidate.id}/`))
        const commit = repo?.spine.find((candidate) => candidate.sha === sha)
        if (!key || !commit) return
        event.preventDefault()
        pending.set(key, { verb: 'rebase-onto', stage: 'confirm', sha: commit.sha, short: commit.short, subject: commit.subject })
        draw(true)
        focusLane(repo.id, key.slice(repo.id.length + 1))
    })
}

/** What a commit is, for its title: the words, who, when, and the hash the log no longer prints. */
const aboutCommit = (commit) => `${commit.subject}\n${commit.short} · ${commit.author} · ${exactly(commit.at)}`

const commitRow = (repo, commit, className, label) => {
    const upstream = repo.main?.upstream
    const remote = upstream?.sha === commit.sha ? upstream.name : null
    // Main's name and origin's are keyed apart from the row they are on: when main moves, they slide up to its new commit.
    const row = el('li', { class: `commit ${className}`, 'data-sha': commit.sha, 'data-anim': `${repo.id}@${commit.sha}` },
        label ? el('span', { class: 'tag', text: label, 'data-anim': `${repo.id}:tag:${label}` }) : null,
        remote ? el('span', { class: 'tag remote', text: remote, title: `Where ${remote} is, as of the last fetch`, 'data-anim': `${repo.id}:tag:${remote}` }) : null,
        isNaming(repo, commit) ? namingForm(repo, commit, naming.from) : [
            el('span', { class: 'subject', text: commit.subject }),
            el('span', { class: 'when', text: short(commit.at), title: exactly(commit.at) }),
            rowActions(repo, commit)
        ])
    return isNaming(repo, commit) ? row : selectable(row, repo, commit)
}

/** "N uncommitted", which in the editor opens them against the checkout's own commit. */
const STATUS_WORD = { M: 'changed', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed', '?': 'new' }
const CHANGES_SHOWN = 8

/** The files of a lane the next commit or discard takes: the ticked ones, every file by default. */
const chosenOf = (key, lane) => {
    const out = unchecked.get(key) ?? new Set()
    return (lane.changes ?? []).map((change) => change.path).filter((file) => !out.has(file))
}
const setChosen = (key, lane, paths) => {
    const all = (lane.changes ?? []).map((change) => change.path)
    unchecked.set(key, new Set(all.filter((file) => !paths.includes(file))))
    draw(true)
}
/** Every file, or the ticked few: none named means every file to the service, as it does to lane. */
const pathsFor = (key, lane) => {
    const chosen = chosenOf(key, lane)
    return chosen.length === (lane.changes ?? []).length ? undefined : chosen
}
/** A word with a mark, ISL's way of offering a thing to do with the files: not a button's box. */
const verbLink = (name, label, title, onclick, disabled = false) => el('button', { type: 'button', class: 'btn link verb', disabled, title, onclick },
    icon(name), el('span', { text: label }))

/** The main checkout, as changesOf draws a lane's uncommitted files: its own files, and no commit of its own to amend. */
const mainCheckoutOf = (repo) => ({
    name: repo.integrationBranch, path: repo.main.path, isMain: true, changes: repo.main.changes ?? [], dirty: repo.main.dirty,
    operation: repo.main.operation, ahead: 0, pending: repo.main.pending ?? null
})
const isMerged = (lane) => !lane.isMain && lane.pull?.state === 'MERGED'

/**
 * What is uncommitted in a lane, or in the main checkout, as ISL draws its working copy: a node on its line, a row of
 * things to do (View changes, Select all, Deselect all, Discard…), each file ticked or not (every one, at first), in the
 * colour of what happened to it, and under them what takes the ticked files: + Commit… and ↓ Amend… in a lane, which
 * open the message form; Move to a new lane… in the main checkout, where nothing is committed without a gate, and in a
 * lane whose pull request was merged, where a commit would be in no pull request.
 */
const changesOf = (repo, lane, key) => {
    const files = lane.changes ?? []
    if (!lane.dirty || lane.operation) return null
    const all = expanded.has(`${key}:changes`)
    const shown = all ? files : files.slice(0, CHANGES_SHOWN)
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    const chosen = chosenOf(key, lane)
    const some = chosen.length > 0 && chosen.length < files.length
    const writing = !lane.isMain && selected?.repo === repo.id && selected?.lane === lane.name && (selected.form === 'commit' || selected.form === 'amend')
    const count = some ? ` ${chosen.length} of ${files.length}` : ''
    const who = lane.isMain ? `${repo.id}'s main checkout` : lane.name
    const waiting = pending.get(key)
    const here = waiting?.where === 'changes' ? waiting : null
    const moving = lane.isMain || isMerged(lane)
    const carry = () => { pending.set(key, { verb: 'carry', stage: 'form', where: 'changes' }); draw(true) }
    return el('div', { class: `changes${writing ? ' writing' : ''}`, 'data-anim-kids': true },
        el('div', { class: 'changes-actions tools' },
            host.inEditor ? verbLink('diff', 'View changes', `Everything uncommitted in ${who}, side by side`, () => openIn('uncommitted', { repo: repo.path, checkout: lane.path, name: who })) : null,
            verbLink('checkall', 'Select all', 'Tick every file', () => setChosen(key, lane, files.map((change) => change.path)), chosen.length === files.length),
            verbLink('box', 'Deselect all', 'Untick every file', () => setChosen(key, lane, []), chosen.length === 0),
            verbLink('trash', 'Discard…', 'Throw away what is uncommitted in the ticked files, after a look', () => { pending.set(key, { verb: 'discard', stage: 'confirm', where: 'changes', paths: chosen }); draw(true) }, busy || !chosen.length)),
        el('ul', { class: 'change-list', 'aria-label': `${plural(lane.dirty, 'uncommitted file')} in ${who}` }, shown.map((file) => {
            const status = file.status === '?' ? 'new' : file.status
            const tick = el('input', {
                type: 'checkbox', class: 'tick', checked: chosen.includes(file.path) ? true : null, 'aria-label': `Take ${file.path}`,
                onchange: (event) => {
                    const out = unchecked.get(key) ?? new Set()
                    if (event.target.checked) out.delete(file.path); else out.add(file.path)
                    unchecked.set(key, out)
                    draw(true)
                }
            })
            return opens(el('li', { 'data-anim': `${key}:file:${file.path}`, 'data-sig': file.status },
                tick,
                el('span', { class: `change-status s-${status}`, text: file.status === '?' ? 'U' : file.status, title: STATUS_WORD[file.status] ?? file.status }),
                el('span', { class: `change-path s-${status}`, text: file.from ? `${file.from} → ${file.path}` : file.path })),
            `Show what is uncommitted in ${file.path}`, () => openIn('uncommitted', { repo: repo.path, checkout: lane.path, name: who, path: file.path }))
        })),
        files.length > CHANGES_SHOWN ? el('button', { type: 'button', class: 'btn link', text: all ? 'Show fewer' : `Show ${files.length - CHANGES_SHOWN} more`, onclick: () => toggle(`${key}:changes`) }) : null,
        here?.verb === 'discard' ? discardConfirm(repo, lane, key, here) : null,
        here?.verb === 'carry' ? carryForm(repo, lane, key) : null,
        el('div', { class: 'changes-actions' }, moving
            ? verbLink('branch', `Move${count} to a new lane…`, lane.isMain
                ? `A lane of their own, from the commit of ${repo.integrationBranch} they were made on: the ticked files leave the main checkout`
                : `#${lane.pull.number} is merged: a lane of their own, from ${repo.integrationBranch}'s newest commit`, carry, busy || !chosen.length || here?.verb === 'carry')
            : [
                verbLink('plus', `Commit${count}…`, some ? 'Commit the ticked files, with a message' : 'Commit every file above, with a message', () => select({ repo: repo.id, lane: lane.name, form: 'commit' }), busy || !chosen.length),
                lane.ahead ? verbLink('amend', `Amend${count}…`, `Fold the ticked files into ${lane.name}'s newest commit`, () => select({ repo: repo.id, lane: lane.name, form: 'amend' }), busy || !chosen.length) : null
            ]),
        isMerged(lane) ? el('p', { class: 'muted small merged-note', text: `#${lane.pull.number} was merged on GitHub, so a commit here would be in no pull request.` }) : null,
        IN_SIDEBAR && writing ? messageForm(repo, lane) : null)
}

/** Discard, asked beside the files it throws away: what each goes back to, and that nothing keeps a copy. */
const discardConfirm = (repo, lane, key, waiting) => {
    const files = waiting.paths ?? []
    const fresh = files.filter((file) => (lane.changes ?? []).find((change) => change.path === file)?.status === '?')
    const named = files.length === 1 ? files[0] : `${files.length} files`
    const backTo = lane.isMain ? repo.main.head?.subject ?? `${repo.integrationBranch}'s commit` : lane.stack?.[0]?.subject ?? `${repo.integrationBranch}'s commit`
    return el('div', { class: 'confirm danger' },
        el('p', { text: `Discard what is uncommitted in ${named}? A changed file goes back to "${backTo}"` +
            `${fresh.length ? `, and ${fresh.length === files.length ? (files.length === 1 ? 'it is new, so it is deleted' : 'they are new, so they are deleted') : `${plural(fresh.length, 'new file')} ${fresh.length === 1 ? 'is' : 'are'} deleted`}` : ''}. Nothing keeps a copy.` }),
        el('button', {
            type: 'button', class: 'btn danger', text: files.length === 1 ? 'Discard it' : 'Discard them', disabled: busyIn(repo.id),
            onclick: async () => {
                pending.delete(key)
                unchecked.delete(key)
                draw(true)
                await press({ repo: repo.id, verb: 'discard', ...(lane.isMain ? { main: true } : { lane: lane.name }), paths: files })
            }
        }),
        el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { pending.delete(key); draw(true) } }))
}

/**
 * What the reviewer makes of the pull request a review lane holds, said on GitHub (lane review): Approve, Request
 * changes or Comment, with words, which the last two need. What is typed is kept across redraws.
 */
const verdictForm = (repo, lane, key) => {
    const draftKey = `verdict:${key}`
    const words = el('textarea', {
        class: 'msg-body', rows: '3', 'data-draft': draftKey, 'aria-label': `What you make of #${lane.review}`,
        placeholder: 'What you make of it: what should change, or what is good. Approve needs none.',
        oninput: (event) => drafts.set(draftKey, { title: event.target.value })
    })
    words.value = drafts.get(draftKey)?.title ?? ''
    const busy = busyIn(repo.id)
    const send = async (verdict) => {
        const body = words.value.trim()
        if (verdict !== 'approve' && !body) { notice(verdict === 'comment' ? 'A comment needs its words.' : 'Say which changes you ask for.'); words.focus(); return }
        pending.delete(key)
        drafts.delete(draftKey)
        draw(true)
        await press({ repo: repo.id, verb: 'review', lane: lane.name, verdict, body })
    }
    if (!words.value) setTimeout(() => words.focus(), 0)
    return el('div', { class: 'confirm verdict' },
        el('p', { text: `Your review of #${lane.review}${lane.pull?.title ? `, "${lane.pull.title}"` : ''}, sent to GitHub as yours.` }),
        words,
        el('div', { class: 'details-actions' },
            iconButton('check', 'Approve', { class: 'btn primary', disabled: busy, onclick: () => send('approve') }),
            iconButton('cross', 'Request changes', { class: 'btn', disabled: busy, onclick: () => send('request-changes') }),
            iconButton('comment', 'Comment', { class: 'btn', disabled: busy, onclick: () => send('comment') }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { pending.delete(key); draw(true) } })))
}

/**
 * Review in a lane: a pull request waiting on you, checked out in a lane of its own (its own port, its own copy of what
 * a running app needs) to run, gate and read; or, where one is open already, that lane.
 */
const reviewButton = (repo, number, { iconOnly = false } = {}) => {
    const there = (repo.lanes ?? []).find((lane) => lane.review === number)
    if (there) {
        return iconButton('branch', iconOnly ? `#${number}'s review lane` : 'Its review lane', {
            class: 'btn link', title: `#${number} is in ${there.name}: open it there`,
            onclick: () => { if (atHome()) openFromHome(repo, there.name); else focusLane(repo.id, there.name) }
        }, iconOnly)
    }
    return iconButton('branch', iconOnly ? `Review #${number} in a lane` : 'Review in a lane', {
        class: 'btn link', disabled: busyIn(repo.id),
        title: `#${number} checked out in a lane of its own, review-${number}: run it, gate it, then Review… from its lane`,
        onclick: async () => {
            const answer = await press({ repo: repo.id, verb: 'new', name: `review-${number}`, pr: number })
            if (answer && atHome()) openFromHome(repo, `review-${number}`)
            else if (answer) focusLane(repo.id, `review-${number}`)
        }
    }, iconOnly)
}

/**
 * Move to a new lane, named where it is asked: the main checkout's ticked files, or what a lane holds that is in no pull
 * request (its files, and the commits it made after the one its pull request was merged at). `lane new <name> --carry`,
 * which moves nothing unless all of it applies.
 */
const carryForm = (repo, lane, key) => {
    const draftKey = `carry:${key}`
    const base = repo.integrationBranch
    const since = isMerged(lane) && lane.sinceMerge > 0 && lane.pull.head ? lane.sinceMerge : 0
    const chosen = lane.dirty ? chosenOf(key, lane) : []
    const what = [since ? `${plural(since, 'commit')} made since #${lane.pull.number} was merged` : null,
        chosen.length ? plural(chosen.length, lane.isMain ? 'ticked file' : 'uncommitted file') : null].filter(Boolean).join(' and ') || 'nothing'
    const input = el('input', {
        name: 'name', class: 'carry-name', placeholder: 'its name, like practice-mode', autocomplete: 'off', spellcheck: 'false', pattern: '[a-z0-9][a-z0-9\\-]*', required: true,
        'data-draft': draftKey, oninput: (event) => drafts.set(draftKey, { title: event.target.value }),
        title: 'Lowercase letters, digits and dashes: it becomes a folder and a branch', 'aria-label': 'A name for the new lane'
    })
    input.value = drafts.get(draftKey)?.title ?? ''
    const cancel = () => { pending.delete(key); draw(true) }
    const form = el('form', {
        class: 'confirm carry',
        onsubmit: async (event) => {
            event.preventDefault()
            if (!form.reportValidity()) return
            const name = input.value.trim()
            const paths = lane.dirty ? pathsFor(key, lane) : undefined
            pending.delete(key)
            drafts.delete(draftKey)
            unchecked.delete(key)
            draw(true)
            await press({ repo: repo.id, verb: 'new', name, carry: true, ...(lane.isMain ? {} : { from: lane.name }), ...(since ? { after: lane.pull.head } : {}), ...(paths ? { paths } : {}) })
        },
        onkeydown: (event) => { if (event.key === 'Escape') { event.preventDefault(); cancel() } }
    },
    el('p', {
        text: lane.isMain
            ? `Move the ${what} out of the main checkout into a lane of their own, which starts from the commit of ${base} they were made on.`
            : `Move ${what} into a lane of their own, from ${base}'s newest commit. ${lane.name} is left as ${isMerged(lane) ? `#${lane.pull.number} merged it` : 'it landed'}, to clear away. If they no longer apply there, nothing moves.`
    }),
    input,
    el('button', { type: 'submit', class: 'btn primary', text: 'Move them', disabled: busyIn(repo.id) }),
    el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: cancel }))
    if (!input.value) setTimeout(() => input.focus(), 0)
    return form
}

/** The main checkout's uncommitted files, on main's line just above its newest commit, drawn as a lane's are. */
const mainChangesRow = (repo) => {
    const main = repo.main
    if (!main?.dirty || main.operation || !main.onIntegration || !(main.changes ?? []).length) return null
    return el('li', { class: 'main-changes', 'data-anim': `${repo.id}:main-changes`, 'data-anim-kids': true },
        el('div', { class: 'main-changes-head' },
            state('warn', `${plural(main.dirty, 'uncommitted file')} in the main checkout`, 'small'),
            el('span', { class: 'muted small', text: `Land and Pull wait until ${main.dirty === 1 ? 'it is' : 'they are'} moved to a lane or discarded` })),
        changesOf(repo, mainCheckoutOf(repo), `${repo.id}:main`))
}

const uncommittedOf = (repo, checkout, name, count, words = `${count} uncommitted`) =>
    opens(state('warn', words, 'small'), `Show what is uncommitted in ${name}`,
        () => openIn('uncommitted', { repo: repo.path, checkout, name }))

// ---------------------------------------------------------------------------
// what a press will do, drawn before it has: ISL moves the graph at once
// ---------------------------------------------------------------------------

const FORESEEN = new Set(['new', 'rebase', 'commit', 'uncommit', 'discard', 'resolve', 'land', 'sweep', 'push', 'pr', 'merge', 'pull', 'review'])
/** A press accepted: what it will do is drawn from now until a reading taken after it ended says what it did. */
const expect = (body, job) => {
    if (!FORESEEN.has(body.verb) || body.dryRun) return
    // The lane's newest commit as the press was made: a reading with another has the commit (or the uncommit) in it
    // already, and it is drawn as it is, once, not with what the press will do drawn on top of it as well.
    const lane = current?.repos.find((repo) => repo.id === body.repo)?.lanes.find((candidate) => candidate.name === body.lane)
    optimistic.push({ jobId: job.id, body, at: Date.now(), head: lane ? lane.stack?.[0]?.sha ?? null : undefined })
}
const settleOptimistic = () => {
    optimistic = optimistic.filter((entry) => {
        const job = jobById(entry.jobId)
        if (!job) return Date.now() - entry.at < 60000
        return job.state !== 'done' || (current?.at ?? 0) < (job.endedAt ?? 0)
    })
}
/** A repository as it will be once the presses waiting on it have run: what the log draws. */
const viewOf = (repo) => {
    const mine = optimistic.filter((entry) => entry.body.repo === repo.id)
    if (!mine.length || repo.error) return repo
    const view = {
        ...repo,
        main: repo.main ? { ...repo.main, changes: [...(repo.main.changes ?? [])] } : repo.main,
        lanes: repo.lanes.map((lane) => ({ ...lane, stack: [...(lane.stack ?? [])], changes: [...(lane.changes ?? [])], conflicts: [...(lane.conflicts ?? [])] }))
    }
    /** Files leaving a checkout (a lane, or the main one): those named, or every one. */
    const leave = (where, paths) => {
        const going = (where.changes ?? []).filter((change) => !paths?.length || paths.includes(change.path))
        where.changes = (where.changes ?? []).filter((change) => !going.includes(change))
        where.dirty = where.changes.length
        return going
    }
    for (const { body, at, head } of mine) {
        const lane = view.lanes.find((candidate) => candidate.name === body.lane)
        const titleOf = (message) => String(message ?? '').split('\n')[0]
        const made = lane && head !== undefined && (lane.stack[0]?.sha ?? null) !== head
        if (made && (body.verb === 'commit' || body.verb === 'uncommit')) { lane.pending = { commit: 'Committing…', uncommit: 'Uncommitting…' }[body.verb]; continue }
        switch (body.verb) {
            case 'new':
                if (!view.lanes.some((candidate) => candidate.name === body.name)) {
                    // Carrying work, it is drawn with the files it takes, and they leave where they were.
                    const from = body.carry ? (body.from ? view.lanes.find((candidate) => candidate.name === body.from) : view.main) : null
                    const carried = from ? leave(from, body.paths) : []
                    view.lanes.push({ name: body.name, branch: body.name, kind: 'fresh', exists: false, base: body.base ?? repo.spine[0]?.sha, stack: [], changes: carried, conflicts: [], dirty: carried.length, ahead: 0, behind: 0, review: body.pr ?? null,
                        pending: body.carry ? 'Moving the work…' : body.pr ? `Fetching #${body.pr}…` : 'Making it…' })
                }
                break
            case 'rebase':
                if (!lane) break
                if (body.continue || body.abort) { lane.pending = body.abort ? 'Putting it back…' : 'Carrying on…'; break }
                lane.base = body.onto ?? repo.spine[0]?.sha
                lane.behind = 0
                lane.pending = 'Rebasing…'
                break
            case 'commit': {
                if (!lane) break
                if (body.reword) { if (lane.stack[0]) lane.stack[0] = { ...lane.stack[0], subject: titleOf(body.message), pending: true }; lane.pending = 'Rewording…'; break }
                const taken = body.paths?.length ? body.paths : lane.changes.map((change) => change.path)
                lane.changes = lane.changes.filter((change) => !taken.includes(change.path))
                lane.dirty = lane.changes.length
                if (body.amend) {
                    if (lane.stack[0]) lane.stack[0] = { ...lane.stack[0], subject: titleOf(body.message) || lane.stack[0].subject, pending: true }
                    lane.pending = 'Amending…'
                } else {
                    lane.stack.unshift({ sha: `pending-${at}`, short: '', subject: titleOf(body.message), at, author: '', pending: true })
                    lane.ahead = (lane.ahead ?? 0) + 1
                    lane.pending = 'Committing…'
                }
                break
            }
            case 'uncommit':
                if (!lane) break
                lane.stack.shift()
                lane.ahead = Math.max(0, (lane.ahead ?? 0) - 1)
                lane.pending = 'Uncommitting…'
                break
            case 'discard':
                if (body.main && view.main) { leave(view.main, body.paths ?? []); break }
                if (!lane) break
                lane.changes = lane.changes.filter((change) => !(body.paths ?? []).includes(change.path))
                lane.dirty = lane.changes.length
                lane.pending = 'Discarding…'
                break
            case 'resolve':
                if (!lane) break
                lane.conflicts = lane.conflicts.filter((file) => !(body.paths ?? []).includes(file))
                lane.pending = 'Marking it resolved…'
                break
            case 'land': case 'sweep': case 'push': case 'merge': case 'pull': case 'review':
                if (lane) lane.pending = { land: 'Landing…', sweep: 'Sweeping…', push: 'Pushing…', merge: 'Merging on GitHub…', pull: 'Pulling…', review: 'Sending the review…' }[body.verb]
                break
            case 'pr':
                if (lane) lane.pending = body.ready ? 'Marking it ready…' : lane.pull?.state === 'OPEN' ? 'Asking for review…' : 'Opening a pull request…'
                break
        }
    }
    return view
}

// ---------------------------------------------------------------------------
// choosing a commit, and the details pane: ISL's right-hand side
// ---------------------------------------------------------------------------

const select = (what) => {
    selected = what
    draw(true)
    if (IN_SIDEBAR) return
    // The message form's title takes the keyboard, ready to type.
    if (what?.form) setTimeout(() => document.querySelector('.details .msg-title')?.focus(), 0)
}
const isSelected = (repo, commit) => selected?.repo === repo.id && selected?.sha === commit.sha
const toggleSelect = (repo, commit, laneName) => select(isSelected(repo, commit) ? null : { repo: repo.id, sha: commit.sha, lane: laneName })

/** A commit row that chooses its commit on a click or Enter, and opens its changes in the editor on a double click. */
const selectable = (row, repo, commit, laneName = null) => {
    if (commit.pending) return row
    row.classList.add('selectable')
    if (isSelected(repo, commit)) row.classList.add('selected')
    row.tabIndex = 0
    row.setAttribute('aria-selected', String(isSelected(repo, commit)))
    row.addEventListener('click', (event) => { if (!event.target.closest('a, button, input, form, textarea')) toggleSelect(repo, commit, laneName) })
    if (host.inEditor) row.addEventListener('dblclick', (event) => { if (!event.target.closest('a, button, input, form, textarea')) showCommit(repo, commit)() })
    row.addEventListener('keydown', (event) => {
        if (event.target === row && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggleSelect(repo, commit, laneName) }
    })
    row.title = `${aboutCommit(commit)}\n\nClick for its details${host.inEditor ? '; double-click for its changes' : ''}`
    return row
}

/** A commit's words and files, asked once (a commit never changes) and drawn when they come. */
const detailsFor = (repo, sha) => {
    const key = `${repo.path}@${sha}`
    const kept = detailsCache.get(key)
    if (kept) return kept.value ?? null
    detailsCache.set(key, {})
    if (detailsCache.size > 80) detailsCache.delete(detailsCache.keys().next().value)
    host.commit(repo.path, sha)
        .then((value) => { detailsCache.set(key, { value }); draw(true) })
        .catch((error) => { detailsCache.set(key, { value: { error: error.message } }); draw(true) })
    return null
}
const findCommit = (repo, sha) => repo.spine.find((commit) => commit.sha === sha) ??
    repo.lanes.flatMap((lane) => lane.stack ?? []).find((commit) => commit.sha === sha) ?? null

const copyHash = async (sha) => {
    try { await host.copy(sha); notice(`Copied ${sha.slice(0, 12)}`, 'ok') } catch { notice(`The clipboard could not be reached; the hash is ${sha}`) }
}
const uncommitLane = (repo, lane) => press({ repo: repo.id, verb: 'uncommit', lane: lane.name })
const closeButton = () => el('button', { type: 'button', class: 'btn quiet close', text: '×', 'aria-label': 'Close the details', title: 'Close (Esc)', onclick: () => select(null) })
const fileRow = (file, open) => {
    const status = file.status === '?' ? 'new' : file.status
    return opens(el('li', {},
        el('span', { class: `change-status s-${status}`, text: file.status === '?' ? 'U' : file.status, title: STATUS_WORD[file.status] ?? file.status }),
        el('span', { class: `change-path s-${status}`, text: file.from ? `${file.from} → ${file.path}` : file.path })),
    `Show what changed in ${file.path}`, open)
}

/** A commit, as the details pane shows it: its words, who and when, what can be done with it, and its files. */
const commitPane = (repo, commit, laneName) => {
    const lane = laneName ? repo.lanes.find((candidate) => candidate.name === laneName) : null
    const details = detailsFor(repo, commit.sha)
    const newest = Boolean(lane && lane.stack?.[0]?.sha === commit.sha && lane.ahead > 0 && !lane.operation && !lane.pending)
    const files = details?.files ?? []
    const tip = !lane && repo.spine[0]?.sha === commit.sha
    return el('div', { class: 'pane-commit' },
        el('div', { class: 'details-head' }, el('h3', { text: commit.subject }), IN_SIDEBAR ? null : closeButton()),
        el('div', { class: 'details-meta' },
            lane ? el('span', { class: 'tag', text: lane.name }) : tip ? el('span', { class: 'tag', text: repo.integrationBranch }) : null,
            el('span', { class: 'mono', text: commit.short }),
            el('span', { text: commit.author || details?.author || '' }),
            el('span', { text: ago(commit.at), title: exactly(commit.at) })),
        details?.error ? el('p', { class: 'muted', text: details.error })
            : !details ? el('p', { class: 'muted', text: 'Reading…' })
                : details.body ? el('p', { class: 'details-body', text: details.body }) : el('p', { class: 'muted details-body', text: 'No description.' }),
        el('div', { class: 'details-actions' },
            newest || tip ? terminalButton(repo, newest ? lane : null, { class: 'btn' }) : null,
            host.inEditor ? iconButton('diff', 'View changes', { onclick: showCommit(repo, commit), title: 'Every file it changed, side by side' }) : null,
            newest ? iconButton('pencil', 'Edit message', { onclick: () => select({ repo: repo.id, lane: lane.name, form: 'reword' }), title: 'A new title and description, nothing else' }) : null,
            newest ? iconButton('uncommit', 'Uncommit', { onclick: () => uncommitLane(repo, lane), title: 'Take it back out, its changes left uncommitted' }) : null,
            iconButton('branch', 'New lane here', { onclick: () => { select(null); startNaming(repo, commit, lane?.name ?? null) } }),
            iconButton('copy', 'Copy hash', { onclick: () => copyHash(commit.sha) })),
        details && !details.error ? el('div', { class: 'section-title' }, 'Files changed', el('span', { class: 'count', text: String(files.length) })) : null,
        details && !details.error ? el('ul', { class: 'change-list' }, files.map((file) => fileRow(file, () => openIn('commit', { repo: repo.path, sha: commit.sha, path: file.path })))) : null)
}

/**
 * The message form, ISL's way: Commit or Amend, a title and a description, the files it takes, and the button.
 * Amend and Edit message start from the newest commit's own words; what is typed survives the page redrawing.
 */
const messageForm = (repo, lane) => {
    const key = `${repo.id}/${lane.name}`
    const form = selected.form
    const draftKey = `${key}:${form}`
    let draft = drafts.get(draftKey)
    let original = null
    if ((form === 'amend' || form === 'reword') && lane.stack?.[0] && !lane.stack[0].pending) {
        const details = detailsFor(repo, lane.stack[0].sha)
        if (details && !details.error) {
            original = { title: details.subject, description: details.body }
            if (!draft) { draft = { ...original }; drafts.set(draftKey, draft) }
        }
    }
    draft = draft ?? { title: '', description: '' }
    const keep = (field) => (event) => drafts.set(draftKey, { ...(drafts.get(draftKey) ?? draft), [field]: event.target.value })
    const title = el('input', {
        class: 'msg-title', 'data-draft': `${draftKey}:title`, autocomplete: 'off', 'aria-label': 'Title',
        placeholder: form === 'commit' ? 'Title: what this commit does' : 'Title', oninput: keep('title')
    })
    title.value = draft.title
    const description = el('textarea', {
        class: 'msg-body', 'data-draft': `${draftKey}:description`, rows: '4', 'aria-label': 'Description',
        placeholder: 'Description, if it needs one: why, and what a reviewer should know', oninput: keep('description')
    })
    description.value = draft.description
    const chosen = chosenOf(key, lane)
    const files = lane.changes ?? []
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    const label = form === 'reword' ? 'Save the message' : form === 'amend' ? 'Amend' : chosen.length < files.length ? `Commit ${plural(chosen.length, 'file')}` : 'Commit'
    const node = el('form', {
        class: 'message-form',
        onsubmit: async (event) => {
            event.preventDefault()
            const typed = { title: title.value.trim(), description: description.value.trim() }
            if ((form === 'commit' || form === 'reword') && !typed.title) { title.focus(); return }
            const message = [typed.title, typed.description].filter(Boolean).join('\n\n')
            const same = original && typed.title === original.title && typed.description === (original.description ?? '').trim()
            const body = form === 'reword'
                ? { repo: repo.id, verb: 'commit', lane: lane.name, reword: true, message }
                : { repo: repo.id, verb: 'commit', lane: lane.name, amend: form === 'amend', message: form === 'amend' && same ? '' : message, paths: pathsFor(key, lane) }
            drafts.delete(draftKey)
            if (form !== 'reword') unchecked.delete(key)
            selected = null
            draw(true)
            await press(body)
        },
        onkeydown: (event) => {
            if (event.key === 'Escape') { event.preventDefault(); select(null) }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); node.requestSubmit() }
        }
    },
    form !== 'reword' && lane.ahead ? el('div', { class: 'modes', role: 'radiogroup', 'aria-label': 'Commit or amend' },
        ['commit', 'amend'].map((mode) => el('button', {
            type: 'button', class: `mode${form === mode ? ' on' : ''}`, role: 'radio', 'aria-checked': String(form === mode),
            text: mode === 'commit' ? 'Commit' : 'Amend', onclick: () => select({ ...selected, form: mode })
        }))) : null,
    title,
    description,
    form !== 'reword' && !IN_SIDEBAR ? [
        el('div', { class: 'section-title' }, form === 'amend' ? 'Changes to amend' : 'Changes to commit', el('span', { class: 'count', text: `${chosen.length} of ${files.length}` })),
        el('ul', { class: 'change-list' }, files.map((file) => {
            const status = file.status === '?' ? 'new' : file.status
            return el('li', {},
                el('input', {
                    type: 'checkbox', class: 'tick', checked: chosen.includes(file.path) ? true : null, 'aria-label': `Take ${file.path}`,
                    onchange: (event) => {
                        const out = unchecked.get(key) ?? new Set()
                        if (event.target.checked) out.delete(file.path); else out.add(file.path)
                        unchecked.set(key, out)
                        draw(true)
                    }
                }),
                el('span', { class: `change-status s-${status}`, text: file.status === '?' ? 'U' : file.status }),
                el('span', { class: `change-path s-${status}`, text: file.path }))
        }))
    ] : null,
    form === 'amend' && lane.stack?.[0] ? el('p', { class: 'muted small', text: `Into "${lane.stack[0].subject}". Leave the words as they are to keep its message.` }) : null,
    el('div', { class: 'details-actions' },
        el('button', { type: 'submit', class: 'btn primary', text: label, disabled: busy || (form !== 'reword' && !chosen.length), title: '⌘ Enter' }),
        el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => select(null) })))
    return node
}

/** What the details pane holds for what is chosen, or null when it no longer exists. */
const paneFor = (repo) => {
    if (!selected) return null
    if (selected.sha) {
        const commit = findCommit(repo, selected.sha)
        return commit ? commitPane(repo, commit, selected.lane) : null
    }
    const lane = repo.lanes.find((candidate) => candidate.name === selected.lane)
    if (!lane || lane.pending) return null
    if (selected.form !== 'reword' && !lane.dirty) return null
    if (selected.form === 'reword' && !lane.ahead) return null
    const heading = selected.form === 'reword' ? `Edit the message of "${lane.stack?.[0]?.subject ?? ''}"` : selected.form === 'amend' ? `Amend ${lane.name}'s newest commit` : `Commit in ${lane.name}`
    return el('div', { class: 'pane-form' },
        el('div', { class: 'details-head' }, el('h3', { text: heading }), IN_SIDEBAR ? null : closeButton()),
        messageForm(repo, lane))
}

/** The details pane beside the log, in a tab or a browser; the side bar shows what is chosen under its row. */
const drawDetails = () => {
    const aside = $('details')
    const repo = selected && current?.repos.find((candidate) => candidate.id === selected.repo && !candidate.error)
    const content = !IN_SIDEBAR && repo ? paneFor(viewOf(repo)) : null
    if (!content) {
        if (!IN_SIDEBAR && selected && current) selected = null
        aside.hidden = true
        aside.replaceChildren()
        document.body.classList.remove('has-details')
        detailsShown = null
        return
    }
    aside.replaceChildren(content)
    // Opened, it slides in from the side; another commit chosen in it, its words fade in. Drawn again as it was, it stays still.
    const showing = JSON.stringify(selected)
    if (aside.hidden) motion.appear(aside, 16, 0)
    else if (showing !== detailsShown) motion.fadeIn(content)
    detailsShown = showing
    document.body.classList.add('has-details')
}
let detailsShown = null
/** In the side bar, the details of what is chosen, under its row. */
const inlineDetails = (repo, commit) => (IN_SIDEBAR && selected?.sha && isSelected(repo, commit)
    ? el('li', { class: 'details-inline' }, commitPane(repo, commit, selected.lane)) : null)

// ---------------------------------------------------------------------------
// the command bar: what is running, what waits its turn, and how the last one went
// ---------------------------------------------------------------------------

const VERB_WORDS = { gate: 'Gating', land: 'Landing', rebase: 'Rebasing', push: 'Pushing', pr: 'Opening a pull request', sweep: 'Sweeping', new: 'Making a lane',
    pull: 'Pulling', 'push-main': 'Pushing main', fetch: 'Fetching', review: 'Reviewing', commit: 'Committing', uncommit: 'Uncommitting', discard: 'Discarding', resolve: 'Marking resolved', adopt: 'Giving it lanes' }
/** A job's command as a person would type it: lane …, gate, git …, without the node and the path in front. */
const typed = (command) => String(command ?? '').replace(/^node (?:\S*\/)?dev\/lane\.mjs /, 'lane ').replace(/^node (?:\S*\/)?dev\/gate\.mjs\b/, 'gate')
    .replace(/^node (?:\S*\/)?bin\/adopt\.mjs\b/, 'lane adopt')
const cancelJob = async (id) => {
    try { if (!await host.cancel(id)) notice('It had begun already, so it was not cancelled.') } catch { notice('LaneKit did not answer; nothing was cancelled.') }
    refresh()
}
const drawCommandBar = () => moving(drawBar)
const drawBar = () => {
    const bar = $('cmdbar')
    const jobs = current?.jobs ?? []
    const running = jobs.find((job) => job.state === 'running')
    const waiting = jobs.filter((job) => job.state === 'queued').reverse()
    const last = running ?? jobs.find((job) => job.state === 'done')
    if (!last && !waiting.length) { bar.hidden = true; document.body.classList.remove('has-cmdbar'); return }
    motion.appear(bar, 0, 12)
    document.body.classList.add('has-cmdbar')
    const ok = last && last.state === 'done' && last.code === 0
    // Straight into replaceChildren, which writes a null as the word "null": the parts not there are left out first.
    const parts = (...kids) => kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false)
    // The spinner and the mark are one thing, keyed alike: as a press ends its spinner ticks over into ✓ or ✗.
    const mark = last ? `${last.id} ${running ? 'running' : ok ? 'ok' : 'bad'}` : null
    bar.replaceChildren(...parts(
        last ? (running ? el('span', { class: 'spin', 'aria-hidden': 'true', 'data-anim': 'cmd:mark', 'data-sig': mark })
            : el('span', { class: `mark ${ok ? 'ok' : 'bad'}`, text: ok ? '✓' : '✗', title: ok ? 'It finished' : `It failed (exit ${last.code})`, 'data-anim': 'cmd:mark', 'data-sig': mark })) : null,
        last ? el('code', { class: 'cmd', text: typed(last.command), title: last.command, 'data-anim': 'cmd:cmd', 'data-sig': last.id }) : null,
        running?.step ? el('span', { class: 'cmd-step', text: running.step, 'data-anim': 'cmd:step', 'data-sig': running.step }) : null,
        running ? el('span', { class: 'live-clock', 'data-since': String(running.startedAt), text: secondsSince(running.startedAt) })
            : last?.endedAt ? el('span', { class: 'when', text: short(last.endedAt), title: exactly(last.endedAt) }) : null,
        waiting.length ? el('span', { class: 'queued', 'data-anim': 'cmd:queued' },
            el('span', { class: 'muted', text: 'then' }),
            waiting.map((job) => el('span', { class: 'queued-job', title: typed(job.command), 'data-anim': `cmd:job:${job.id}` },
                `${job.verb}${job.lane ? ` ${job.lane}` : ''}`,
                el('button', { type: 'button', class: 'btn link cancel', text: '×', 'aria-label': `Cancel ${job.verb}${job.lane ? ` ${job.lane}` : ''}`, title: 'Take it out of the line', onclick: () => cancelJob(job.id) })))) : null,
        el('span', { class: 'grow' }),
        last ? iconButton('output', shownJob === last.id && !$('job').hidden ? 'Hide output' : 'Output', {
            class: 'btn link',
            onclick: () => { if (shownJob === last.id && !$('job').hidden) $('job-close').click(); else showJob(last.id); drawCommandBar() }
        }) : null))
}

// ---------------------------------------------------------------------------
// a pull request's badges, under its lane's newest commit
// ---------------------------------------------------------------------------

/**
 * The page's icons, drawn here at a fixed 16-unit size in the ink around them: lanekit carries no dependency, and a
 * webview cannot reach the editor's own icon font. Each is a few strokes, legible at 14 pixels.
 */
const ICONS = {
    pr: [['circle', { cx: 4, cy: 3.5, r: 1.8 }], ['circle', { cx: 4, cy: 12.5, r: 1.8 }], ['path', { d: 'M4 5.3v5.4' }], ['circle', { cx: 12, cy: 12.5, r: 1.8 }],
        ['path', { d: 'M12 10.7V6.5a2 2 0 0 0-2-2H7.5' }], ['path', { d: 'M9 3 7.5 4.5 9 6' }]],
    comment: [['path', { d: 'M2.5 3.5h11v7.5h-6.5l-3 2.5V11h-1.5z' }]],
    uncommit: [['path', { d: 'M5.5 4 2.5 7l3 3' }], ['path', { d: 'M2.5 7h7a3.5 3.5 0 0 1 0 7h-2' }]],
    branch: [['circle', { cx: 4.5, cy: 3.5, r: 1.6 }], ['circle', { cx: 4.5, cy: 12.5, r: 1.6 }], ['path', { d: 'M4.5 5.1v5.8' }],
        ['circle', { cx: 11.5, cy: 4.5, r: 1.6 }], ['path', { d: 'M11.5 6.1c0 3.4-7 2.4-7 4.8' }]],
    copy: [['rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }], ['path', { d: 'M3 10.5v-7a1 1 0 0 1 1-1h7' }]],
    diff: [['path', { d: 'M4 2.5h5.5l2.5 2.5v8.5H4z' }], ['path', { d: 'M6.5 7.5h3M8 6v3M6.5 11h3' }]],
    checkall: [['rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }], ['path', { d: 'M5 8.2 7 10.2l4-4.4' }]],
    box: [['rect', { x: 2.5, y: 2.5, width: 11, height: 11, rx: 2 }]],
    trash: [['path', { d: 'M3 4.5h10' }], ['path', { d: 'M6.5 4.5V3h3v1.5' }], ['path', { d: 'M4.5 4.5l.6 9h5.8l.6-9' }]],
    plus: [['path', { d: 'M8 3.5v9M3.5 8h9' }]],
    amend: [['path', { d: 'M8 2.5v8' }], ['path', { d: 'M5 7.5l3 3 3-3' }], ['path', { d: 'M4 13.5h8' }]],
    gate: [['path', { d: 'M8 2l5 2v4c0 3-2.2 5-5 6-2.8-1-5-3-5-6V4z' }], ['path', { d: 'M5.8 8.2 7.4 9.8l3-3.2' }]],
    land: [['circle', { cx: 4, cy: 3.5, r: 1.6 }], ['circle', { cx: 4, cy: 12.5, r: 1.6 }], ['path', { d: 'M4 5.1v5.8' }],
        ['circle', { cx: 12, cy: 8.5, r: 1.6 }], ['path', { d: 'M4 5.5c0 2.2 2.4 3 6.4 3' }]],
    push: [['path', { d: 'M8 13V3.5' }], ['path', { d: 'M4.5 7 8 3.5 11.5 7' }]],
    pull: [['path', { d: 'M8 3v9.5' }], ['path', { d: 'M4.5 9 8 12.5 11.5 9' }]],
    fetch: [['path', { d: 'M13 8a5 5 0 1 1-1.5-3.6' }], ['path', { d: 'M13 2.5v3h-3' }]],
    rebase: [['path', { d: 'M3 6.5a5 5 0 0 1 9-2.5' }], ['path', { d: 'M12.5 1.5V4.5H9.5' }], ['path', { d: 'M13 9.5a5 5 0 0 1-9 2.5' }], ['path', { d: 'M3.5 14.5v-3h3' }]],
    terminal: [['rect', { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 }], ['path', { d: 'M4.5 6l2 2-2 2' }], ['path', { d: 'M8.5 10.5h3' }]],
    agent: [['path', { d: 'M7 2.5l1.3 3.2 3.2 1.3-3.2 1.3L7 11.5 5.7 8.3 2.5 7l3.2-1.3z' }], ['path', { d: 'M12.5 10v4M10.5 12h4' }]],
    pencil: [['path', { d: 'M10.5 2.5l3 3L6 13H3v-3z' }]],
    check: [['path', { d: 'M3 8.5l3 3 7-7' }]],
    play: [['path', { d: 'M5 3.5l7 4.5-7 4.5z' }]],
    cross: [['path', { d: 'M4.5 4.5l7 7M11.5 4.5l-7 7' }]],
    output: [['rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5 }], ['path', { d: 'M4.5 6h7M4.5 8.5h5M4.5 11h6' }]],
    aside: [['rect', { x: 2, y: 3, width: 12, height: 3, rx: 1 }], ['path', { d: 'M3 6v7h10V6' }], ['path', { d: 'M6.5 9h3' }]],
    unaside: [['rect', { x: 2, y: 3, width: 12, height: 3, rx: 1 }], ['path', { d: 'M3 6v7h10V6' }], ['path', { d: 'M8 12V8.5M6.3 10.2 8 8.5l1.7 1.7' }]],
    tab: [['path', { d: 'M9.5 2.5h4v4' }], ['path', { d: 'M13.5 2.5 8 8' }], ['path', { d: 'M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3' }]]
}
const icon = (name) => {
    const svg = svgEl('svg', { class: `icon icon-${name}`, width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })
    for (const [tag, attrs] of ICONS[name] ?? []) svg.append(svgEl(tag, attrs))
    return svg
}
/** A button with an icon and its word; `only` keeps the word for the tooltip and the screen reader. */
const iconButton = (name, label, props = {}, only = false) => el('button', {
    type: 'button', ...props, class: `${props.class ?? 'btn'} with-icon${only ? ' icon-only' : ''}`,
    title: props.title ?? (only ? label : undefined), 'aria-label': only ? label : props['aria-label']
}, icon(name), only ? null : el('span', { class: 'label', text: label }))
const PR_WORD = { OPEN: 'Open', MERGED: 'Merged', CLOSED: 'Closed' }
/**
 * An open pull request's review in a few words, with everyone in it for its title: who approved, who asked for changes,
 * who was asked and has not answered, and what main's rules need (`needs`: approvals, code owners, threads resolved).
 * Plain data in and out, so lanekit's tests run it as it is written here (test/github.test.mjs).
 */
const reviewWordsOf = (pr, needs) => {
    if (!pr || pr.state !== 'OPEN' || pr.draft) return null
    const by = (state) => (pr.reviews ?? []).filter((review) => review.state === state).map((review) => review.who)
    const approved = by('APPROVED')
    const changes = by('CHANGES_REQUESTED')
    const asked = pr.requested ?? []
    const names = (list) => (list.length > 2 ? `${list.slice(0, 2).join(', ')} and ${list.length - 2} more` : list.join(' and '))
    const tally = needs?.approvals ? ` · ${Math.min(approved.length, needs.approvals)} of ${needs.approvals}` : ''
    const title = [
        ...approved.map((who) => `${who} approved`), ...changes.map((who) => `${who} asked for changes`),
        ...by('COMMENTED').map((who) => `${who} commented`), ...asked.map((who) => `${who} is asked to review`),
        needs?.approvals ? `${needs.approvals} ${needs.approvals === 1 ? 'approval' : 'approvals'} needed` : null,
        needs?.codeOwners ? 'its code owners must approve' : null, needs?.threads ? 'every thread must be resolved' : null
    ].filter(Boolean).join(' · ')
    if (pr.review === 'CHANGES_REQUESTED') return { tone: 'bad', text: `Changes requested${changes.length ? ` by ${names(changes)}` : ''}`, title }
    if (pr.review === 'APPROVED') return { tone: 'ok', text: `Approved${approved.length ? ` by ${names(approved)}` : ''}`, title }
    if (asked.length) return { tone: 'wait', text: `Waiting on ${names(asked)}${tally}`, title }
    if (pr.review === 'REVIEW_REQUIRED') return { tone: 'wait', text: `Review required, nobody asked${tally}`, title }
    if (approved.length) return { tone: 'ok', text: `Approved by ${names(approved)}`, title }
    return null
}
/** Everybody this repository's pull requests have asked, or heard from: who a Request review is likely for. */
const reviewersSeen = (repo) => [...new Set((repo.lanes ?? []).flatMap((lane) =>
    [...(lane.pull?.requested ?? []), ...(lane.pull?.reviews ?? []).map((review) => review.who)]))].sort()

const badgesOf = (repo, lane) => {
    const pr = lane.pull
    if (!pr) return null
    const said = reviewWordsOf(pr, repo.github?.rules?.review)
    const word = pr.draft && pr.state === 'OPEN' ? 'Draft' : PR_WORD[pr.state] ?? pr.state
    const href = safeHref(pr.url)
    const link = (props, ...kids) => href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, ...kids) : el('span', props, ...kids)
    return el('div', { class: 'badges' },
        pr.checks && pr.checks !== 'none'
            ? el('span', { class: `check ${pr.checks}`, title: `Checks ${pr.checks}`, text: { passing: '✓', failing: '✗', pending: '•' }[pr.checks] ?? '' }) : null,
        link({ class: `pr-pill ${word.toLowerCase()}`, title: pr.title }, icon('pr'), word),
        said ? el('span', { class: `review ${said.tone}`, text: said.text, title: said.title || null }) : null,
        pr.threads ? el('span', { class: 'threads', title: `${plural(pr.threads, 'review thread')} not resolved yet` }, icon('comment'), `${pr.threads} unresolved`) : null,
        pr.comments ? el('span', { class: 'comments', title: plural(pr.comments, 'comment') }, icon('comment'), String(pr.comments)) : null,
        link({ class: 'pr-number', text: `#${pr.number}` }))
}

const confirmOf = (repo, lane, key) => {
    const waiting = pending.get(key)
    // What is asked beside the files it is about is drawn there (changesOf), not here.
    if (!waiting || waiting.where === 'changes') return null
    if (waiting.verb === 'carry') return carryForm(repo, lane, key)
    if (waiting.verb === 'verdict') return verdictForm(repo, lane, key)
    const job = waiting.jobId ? jobById(waiting.jobId) : null
    if (waiting.stage === 'checking' && job && job.state === 'done') {
        waiting.stage = job.code === 0 ? 'confirm' : 'refused'
    }
    const cancel = el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { pending.delete(key); draw(true) } })
    const busy = busyIn(repo.id)
    const go = (label, body) => el('button', {
        type: 'button', class: 'btn primary', text: label, disabled: busy,
        onclick: async () => { pending.delete(key); draw(true); await press(body) }
    })
    const base = repo.integrationBranch

    if (waiting.stage === 'checking') {
        return el('div', { class: 'confirm' }, el('p', { text: `Checking whether ${lane.name} can ${waiting.verb}…` }))
    }
    if (waiting.stage === 'refused') {
        return el('div', { class: 'confirm refused' },
            el('p', { text: waiting.verb === 'land' ? `${lane.name} cannot land yet. The check below says why.` : waiting.verb === 'drop' ? `${lane.name} cannot be dropped. The check below says why.` : `${lane.name} cannot be swept. The check below says why.` }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Dismiss', onclick: () => { pending.delete(key); draw(true) } }))
    }
    if (waiting.verb === 'gate') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Gate ${lane.name}? It rebases the branch onto ${base}, then runs the tier its changes earn${lane.queue?.tier ? ` (tier ${lane.queue.tier})` : ''}. It never merges.` }),
            go('Gate it', { repo: repo.id, verb: 'gate', lane: lane.name }), cancel)
    }
    if (waiting.verb === 'land') {
        return el('div', { class: 'confirm' },
            el('p', { text: `The check passed. Land ${lane.name}? It merges into ${base} with --no-ff, then removes the lane's folder and stops its server; the branch is kept. Nothing is pushed.` }),
            go('Land it', { repo: repo.id, verb: 'land', lane: lane.name }), cancel)
    }
    if (waiting.verb === 'rebase') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Rebase ${lane.name} onto ${base}? It replays its ${plural(lane.ahead || 0, 'commit')} on ${base} as it is now (${lane.behind} behind). If they conflict it stops, names the files, and waits for you to resolve them.` }),
            go('Rebase it', { repo: repo.id, verb: 'rebase', lane: lane.name }), cancel)
    }
    if (waiting.verb === 'rebase-onto') {
        // Back is a place to work from, never to land from: the gate moves a lane onto main's newest before it tests.
        const move = ontoOf(repo.spine, lane.base, waiting.sha)
        const own = plural(lane.ahead || 0, 'commit')
        const one = (lane.ahead || 0) === 1
        const them = one ? 'it' : 'them'
        const named = (list) => list.slice(0, 2).map((commit) => `"${commit.subject}"`).join(' and ') + (list.length > 2 ? `, and ${list.length - 2} more` : '')
        const pushed = lane.upstream ? ' It was pushed, so the next push asks before replacing origin\'s copy.' : ''
        const text = move.way === 'back'
            ? `Move ${lane.name} back onto "${waiting.subject}"? Its ${own} will start ${plural(move.count, 'commit')} further back on ${base}, without ${named(move.commits)} under ${them}. ` +
              `It is a place to work from, not to land from: the gate moves it onto ${base}'s newest commit before it tests.${pushed} ` +
              `If ${one ? 'its commit needs' : 'its commits need'} what it leaves behind, the rebase stops on the files that conflict and waits; Abort puts it back as it is now.`
            : move.way === 'forward' && move.count
                ? `Move ${lane.name} forward onto "${waiting.subject}"? Its ${own} will have ${named(move.commits)} under ${them} as well.${pushed} If ${one ? 'it conflicts' : 'they conflict'} it stops, names the files, and waits for you.`
                : `Rebase ${lane.name} onto "${waiting.subject}"? Its ${own} will start from that commit of ${base} instead of where ${one ? 'it starts' : 'they start'} now.${pushed} If ${one ? 'it conflicts' : 'they conflict'} it stops, names the files, and waits for you.`
        return el('div', { class: `confirm${move.way === 'back' ? ' backwards' : ''}` },
            el('p', { text }),
            go(move.way === 'back' ? 'Move it back' : move.way === 'forward' && move.count ? 'Move it forward' : 'Rebase it', { repo: repo.id, verb: 'rebase', lane: lane.name, onto: waiting.sha }), cancel)
    }
    if (waiting.verb === 'abort') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Abort ${lane.name}'s rebase? It puts the lane back exactly as it was before the rebase began; what you resolved so far is dropped.` }),
            go('Abort it', { repo: repo.id, verb: 'rebase', lane: lane.name, abort: true }), cancel)
    }
    if (waiting.verb === 'pr' || waiting.verb === 'review') {
        // A pull request opened (a draft, if ticked; pushed first, where the press said so), or reviewers asked of an
        // open one. What is typed is kept on the press waiting here, so a redraw keeps it.
        const opening = waiting.verb === 'pr'
        const listId = `reviewers-of-${repo.id}`
        const named = () => String(waiting.reviewers ?? '').split(/[\s,]+/).map((one) => one.replace(/^@/, '')).filter(Boolean)
        const send = async () => {
            if (!opening && !named().length) { notice('Name somebody to ask: a GitHub login, or org/team.'); return }
            pending.delete(key)
            draw(true)
            await press({ repo: repo.id, verb: 'pr', lane: lane.name, draft: opening && waiting.draft === true, push: opening && waiting.push === true, reviewers: named() })
        }
        const input = el('input', {
            type: 'text', class: 'reviewers', list: listId, autocomplete: 'off', spellcheck: 'false', 'data-draft': `${key}:reviewers`,
            placeholder: opening ? 'reviewers, if any: alice, org/team' : 'who: alice, org/team',
            'aria-label': 'Reviewers: GitHub logins, or org/team, between commas',
            oninput: (event) => { waiting.reviewers = event.target.value },
            onkeydown: (event) => { if (event.key === 'Enter') { event.preventDefault(); send() } }
        })
        input.value = waiting.reviewers ?? ''
        return el('div', { class: 'confirm pr-form' },
            el('p', {
                text: opening
                    ? `Open a pull request for ${lane.branch} into ${base}, from its commits' own words${waiting.push ? ', pushing the lane first' : ''}. Reviewers can be asked now or later.`
                    : `Ask for a review of #${lane.pull?.number}: GitHub logins, or org/team.`
            }),
            input,
            el('datalist', { id: listId }, reviewersSeen(repo).map((who) => el('option', { value: who }))),
            opening ? el('label', { class: 'draft-box' },
                el('input', { type: 'checkbox', checked: waiting.draft === true ? true : null, onchange: (event) => { waiting.draft = event.target.checked } }), 'Draft') : null,
            el('button', { type: 'button', class: 'btn primary', text: opening ? 'Open it' : 'Ask', disabled: busy, onclick: send }),
            cancel)
    }
    if (waiting.verb === 'merge') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Merge #${lane.pull?.number} into ${base} on GitHub? By a merge commit where the repository allows one, as Land would, else squashed or rebased; then ${base} here is brought up to it, and the lane's branch is kept. GitHub's rules decide whether it may be, and nothing is stepped past.` }),
            go('Merge it', { repo: repo.id, verb: 'merge', lane: lane.name }), cancel)
    }
    if (waiting.verb === 'push-force') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Replace origin's ${lane.branch}? It was rebased since it was pushed, so origin has ${plural(lane.upstream?.behind || 0, 'commit')} this lane no longer does. --force-with-lease replaces them only if nobody pushed there since this lane last fetched.` }),
            go('Replace it', { repo: repo.id, verb: 'push', lane: lane.name, force: true }), cancel)
    }
    if (waiting.verb === 'drop') {
        const own = lane.ahead || 0
        const up = lane.upstream
        const where = !own ? 'It has no commits of its own.'
            : !up ? `It was never pushed, so its ${plural(own, 'commit')} will be in the branch ${lane.branch} here and nowhere else.`
                : up.ahead ? `${up.name} has some of it; ${plural(up.ahead, 'commit')} will be only in the branch here.`
                    : `${up.name} has all of it as well.`
        return el('div', { class: 'confirm danger' },
            el('p', { text: `The check passed. Drop ${lane.name}? Its folder goes, and whatever serves on its port stops; its branch ${lane.branch} stays. ${where} lane new ${lane.name} --existing brings it back.` }),
            el('button', { type: 'button', class: 'btn danger', text: 'Drop it', disabled: busy, onclick: async () => { pending.delete(key); draw(true); await press({ repo: repo.id, verb: 'drop', lane: lane.name }) } }),
            cancel)
    }
    if (waiting.verb === 'sweep') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Sweep ${lane.name}? It removes the lane's folder and stops whatever serves on its port. The branch is kept, and it is already in ${base}.` }),
            go('Sweep it', { repo: repo.id, verb: 'sweep', lane: lane.name }), cancel)
    }
    return null
}

const check = async (repo, lane, verb) => {
    const key = `${repo.id}/${lane.name}`
    const answer = await press({ repo: repo.id, verb, lane: lane.name, dryRun: true })
    if (answer) pending.set(key, { verb, stage: 'checking', jobId: answer.id })
    draw(true)
}

const stack0 = (lane) => (lane.stack ?? []).length > 0

/** Where a lane joins main's line, ISL's way: an S from the lane's own column into the spine, just above the
    commit it forked from, which is the row drawn next. Drawn at a fixed size, so its stroke is never stretched. */
const forkCurve = () => {
    const [spine, column, height] = IN_SIDEBAR ? [8, 22, 14] : [12, 32, 18]
    const svg = svgEl('svg', { class: 'fork', width: column + 2, height, 'aria-hidden': 'true' })
    svg.append(svgEl('path', { d: `M ${column} 0 C ${column} ${height / 2} ${spine} ${height / 2} ${spine} ${height}`, fill: 'none', 'stroke-width': 2 }))
    return svg
}

/** A lane as ISL draws a stack, built up from where it forked: its uncommitted files on top, its commits newest first
    under them, and its name at its base, with its state and what can be done with it beside it (the owner, 2 Oct), on a
    line of its own that curves into main's at the commit it forked from. `forked` is false for a lane drawn apart,
    below main's log, whose fork is further back than the log goes. */
const laneCard = (repo, lane, forked = true) => {
    const key = `${repo.id}/${lane.name}`
    const step = prStepOf(repo, lane)
    const [tone, word, detail] = lane.pending ? ['info', lane.pending, null] : step ? [step.tone, step.word, step.detail] : statusOf(lane)
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    const merged = isMerged(lane)
    // A lane with nothing in it has nothing to gate or land; one with uncommitted work is shown the buttons, held,
    // each saying what it waits for. One whose pull request was merged takes neither.
    const working = (lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)) && !merged
    const up = lane.upstream
    // Its copy on origin has commits it lacks, and none of its own: pulling them comes before anything else.
    const behindOrigin = lane.kind === 'working' && !lane.operation && up?.behind > 0 && !up.ahead
    const held = (reason) => (busy ? true : Boolean(reason))

    const buttons = []
    const ask = (verb) => () => { pending.set(key, { verb, stage: 'confirm' }); draw(true) }
    // Stopped mid-rebase: the three ways on sit in the conflict panel, shown whether or not the pointer is here.
    const conflictButtons = []
    if (lane.operation === 'rebase') {
        if (host.inEditor && lane.conflicts?.length) {
            conflictButtons.push(iconButton('diff', `Conflicts (${lane.conflicts.length})`, {
                class: 'btn primary',
                title: 'Open the conflicting files in the editor, where each conflict can be accepted one way, the other, or both',
                onclick: () => openIn('conflicts', { repo: repo.path, lane: lane.name })
            }))
        }
        conflictButtons.push(iconButton('play', 'Continue', {
            class: `btn${!host.inEditor || !lane.conflicts?.length ? ' primary' : ''}`, disabled: busy,
            title: 'Stage the files whose conflicts are resolved, and carry on with the rebase',
            onclick: () => press({ repo: repo.id, verb: 'rebase', lane: lane.name, continue: true })
        }))
        conflictButtons.push(iconButton('cross', 'Abort…', { class: 'btn quiet', disabled: busy, title: 'Put the lane back as it was before the rebase', onclick: ask('abort') }))
    }
    if (working && !lane.operation) {
        const gateBlock = gateBlockOf(lane)
        buttons.push(iconButton('gate', 'Gate', {
            // One thing solid: where its pull request, or its copy on origin, has a next step, that is it.
            class: `btn${lane.queue?.verdict === 'gate now' && !gateBlock && !step?.next && !behindOrigin ? ' primary' : ''}`,
            disabled: held(gateBlock),
            title: gateBlock ?? 'Rebase onto the integration branch and run the tier this lane earns',
            onclick: ask('gate')
        }))
        // Where main lands by pull request there is no land here: the pull request's next step stands in its place.
        // Nor for a review of somebody's pull request, which lands by it.
        if (!byPullRequest(repo) && !lane.review) {
            const landBlock = landBlockOf(repo, lane)
            buttons.push(iconButton('land', 'Land…', {
                class: `btn${!landBlock && !behindOrigin ? ' primary' : ''}`, disabled: held(landBlock),
                title: landBlock ?? 'Check whether it can land, then ask',
                onclick: () => check(repo, lane, 'land')
            }))
        }
    }
    const number = lane.pull?.number
    const pullBlock = pullBlockOf(repo)
    const nextStep = {
        pr: () => iconButton('pr', 'Pull request…', {
            class: 'btn primary', disabled: busy, title: `Open a pull request for ${lane.branch} into ${repo.integrationBranch}${!up || up.ahead > 0 ? ', pushing it first' : ''}`,
            onclick: () => { pending.set(key, { verb: 'pr', stage: 'form', push: !up || up.ahead > 0 }); draw(true) }
        }),
        push: () => iconButton('push', 'Push', { class: 'btn primary', disabled: busy, title: `Send what is new to #${number}`, onclick: () => press({ repo: repo.id, verb: 'push', lane: lane.name }) }),
        'push-force': () => iconButton('push', 'Push…', { class: 'btn primary', disabled: busy, title: 'It was rebased since it was pushed: ask before replacing origin\'s copy', onclick: ask('push-force') }),
        update: () => iconButton('pull', 'Pull', { class: 'btn primary', disabled: busy, title: lane.review ? `What #${lane.review}'s author pushed since: ${plural(up.behind, 'commit')}` : `Fast-forward ${lane.name} to ${up.name}: ${plural(up.behind, 'commit')} somebody pushed to it`, onclick: () => press({ repo: repo.id, verb: 'pull', lane: lane.name }) }),
        verdict: () => iconButton('pr', 'Review…', {
            class: 'btn primary', disabled: busy, title: `Approve #${lane.review}, ask for changes, or comment, on GitHub`,
            onclick: () => { pending.set(key, { verb: 'verdict', stage: 'form', where: 'card' }); draw(true) }
        }),
        ready: () => iconButton('pr', 'Ready for review', { class: 'btn primary', disabled: busy, title: `Mark #${number} ready for review`, onclick: () => press({ repo: repo.id, verb: 'pr', lane: lane.name, ready: true }) }),
        review: () => iconButton('pr', 'Request review…', { class: 'btn primary', disabled: busy, title: `Nobody is asked to review #${number} yet`, onclick: () => { pending.set(key, { verb: 'review', stage: 'form' }); draw(true) } }),
        merge: () => iconButton('land', 'Merge…', { class: 'btn primary', disabled: busy, title: `Merge #${number} on GitHub, then bring ${repo.integrationBranch} here up to it`, onclick: ask('merge') }),
        pull: () => iconButton('pull', `Pull ${repo.integrationBranch}`, {
            class: 'btn primary', disabled: held(pullBlock),
            title: pullBlock ?? `Bring ${repo.integrationBranch} here up to GitHub's, which has #${number} in it`,
            onclick: () => press({ repo: repo.id, verb: 'pull' })
        }),
        carry: () => iconButton('branch', 'Move to a new lane…', {
            class: 'btn primary', disabled: busy, title: `What ${lane.name} holds that #${number} did not merge, in a lane of its own from ${repo.integrationBranch}'s newest commit`,
            onclick: () => { pending.set(key, { verb: 'carry', stage: 'form', where: lane.dirty ? 'changes' : 'card' }); draw(true) }
        }),
        drop: () => iconButton('trash', 'Drop…', { class: 'btn primary', disabled: busy, title: 'Remove its folder and keep its branch, after a check', onclick: () => check(repo, lane, 'drop') })
    }[step?.next]
    if (nextStep && !lane.operation) buttons.push(nextStep())
    // Behind its copy on origin where the pull request has no word on it (main lands here): Pull, all the same.
    else if (behindOrigin) buttons.push(iconButton('pull', 'Pull', { class: 'btn primary', disabled: busy, title: `Fast-forward ${lane.name} to ${up.name}: ${plural(up.behind, 'commit')} somebody pushed to it`, onclick: () => press({ repo: repo.id, verb: 'pull', lane: lane.name }) }))
    if ((working || lane.kind === 'fresh') && !lane.operation && lane.behind > 0) {
        buttons.push(iconButton('rebase', 'Rebase', {
            class: `btn${lane.queue?.verdict === 'rebase first' || step?.next === 'rebase' ? ' primary' : ''}`,
            disabled: busy || lane.dirty > 0,
            title: lane.dirty ? 'Commit first: a rebase replays commits, and uncommitted changes are in none' : `Replay it on ${repo.integrationBranch} as it is now: ${lane.behind} behind`,
            onclick: ask('rebase')
        }))
    }
    // What is done now and then, rather than at every step, sits behind ⋯ in a tab: pushing, and putting a lane away.
    const more = []
    // A review lane: what its author pushed, fetched again (a fork's too, which has no branch here to compare).
    if (lane.review && !lane.operation && step?.next !== 'update') {
        more.push(iconButton('pull', 'Pull what its author pushed', { disabled: busy, title: `Fetch #${lane.review} as its author has it now`, onclick: () => press({ repo: repo.id, verb: 'pull', lane: lane.name }) }))
    }
    if (lane.kind === 'working' && !lane.operation && !merged && !lane.review) {
        if ((!up || up.ahead > 0) && !['push', 'push-force', 'pr'].includes(step?.next)) {
            const rewrite = Boolean(up && up.behind > 0)
            // Never offered over somebody else's commits: those are brought in first.
            const theirs = rewrite && up.foreign ? `${up.name} has ${plural(up.foreign, 'commit')} of somebody else's: bring them in first (git pull --rebase, in the lane)` : null
            more.push(iconButton('push', rewrite ? 'Push…' : 'Push', {
                disabled: held(theirs),
                title: theirs ?? (rewrite ? 'It was rebased since it was pushed: ask before replacing origin\'s copy' : up ? `Send ${plural(up.ahead, 'commit')} to origin` : 'Send the branch to origin, for the first time'),
                onclick: rewrite ? ask('push-force') : () => press({ repo: repo.id, verb: 'push', lane: lane.name })
            }))
        } else if (lane.pull?.state !== 'OPEN' && repo.github?.state === 'ok' && step?.next !== 'pr') {
            more.push(iconButton('pr', 'Pull request…', {
                disabled: busy,
                title: `Open a pull request for ${lane.branch} into ${repo.integrationBranch}, from its commits' own words: a draft if you like, with reviewers if you like`,
                onclick: () => { pending.set(key, { verb: 'pr', stage: 'form' }); draw(true) }
            }))
        }
    }
    // Its open pull request: a draft made ready for review, and reviewers asked for. Not a review lane's: that is the author's.
    if (lane.pull?.state === 'OPEN' && repo.github?.state === 'ok' && !lane.operation && !lane.review) {
        if (lane.pull.draft && step?.next !== 'ready') {
            more.push(iconButton('pr', 'Ready for review', {
                disabled: busy, title: `Mark #${lane.pull.number} ready for review: those asked to review it are told`,
                onclick: () => press({ repo: repo.id, verb: 'pr', lane: lane.name, ready: true })
            }))
        }
        if (step?.next !== 'review') {
            more.push(iconButton('pr', 'Request review…', {
                disabled: busy, title: `Ask somebody to review #${lane.pull.number}`,
                onclick: () => { pending.set(key, { verb: 'review', stage: 'form' }); draw(true) }
            }))
        }
        // Where main lands here, a pull request can still be merged on GitHub instead, from here.
        if (!lane.pull.draft && step?.next !== 'merge' && !byPullRequest(repo)) {
            more.push(iconButton('land', 'Merge on GitHub…', { disabled: busy, title: `Merge #${lane.pull.number} on GitHub, then bring ${repo.integrationBranch} here up to it`, onclick: ask('merge') }))
        }
    }
    // What openLinks has nothing for (no Changes for an empty lane) is left out, not kept as a gap.
    buttons.push(...openLinks(repo, lane).filter(Boolean))
    // A lane not being worked on: set aside (nothing removed), or dropped (its folder removed, its branch kept), after a check.
    if ((lane.kind === 'working' || lane.kind === 'fresh') && lane.exists && !lane.operation) {
        more.push(iconButton('aside', 'Set aside', { class: 'btn quiet', disabled: busy, title: 'Out of the landing order and the log, listed apart; nothing removed', onclick: () => press({ repo: repo.id, verb: 'aside', lane: lane.name }) }))
        if (step?.next !== 'drop') {
            const work = lane.dirty ? `${lane.name} has ${plural(lane.dirty, 'uncommitted file')}, which would go with its folder: commit, move or discard ${lane.dirty === 1 ? 'it' : 'them'} first` : null
            more.push(iconButton('trash', 'Drop…', { class: 'btn quiet', disabled: held(work), title: work ?? 'Remove its folder and keep its branch, after a check', onclick: () => check(repo, lane, 'drop') }))
        }
    }
    if (lane.pending) { buttons.length = 0; more.length = 0 }
    // The side bar opens every button in the card behind its own ⋯ (below); a tab keeps the rest in a menu of its own.
    if (IN_SIDEBAR) buttons.push(...more.splice(0))
    const moreKey = `${key}:more`
    const moreOpen = more.length > 0 && expanded.has(moreKey)
    const moreMenu = more.length
        ? el('div', { class: 'more-wrap' },
            el('button', {
                type: 'button', class: 'btn quiet more', text: '⋯', 'aria-expanded': String(moreOpen), 'aria-haspopup': 'menu',
                'aria-label': `More for ${lane.name}`, title: more.map((button) => button.textContent).join(', '),
                onclick: (event) => {
                    event.stopPropagation()
                    // One menu open at a time: this one opens, or closes, and any other closes.
                    const wasOpen = expanded.has(moreKey)
                    closeMenus()
                    if (!wasOpen) toggle(moreKey); else draw(true)
                }
            }),
            moreOpen ? el('div', { class: 'more-menu', role: 'menu', 'data-anim': `${key}:menu` }, more.map((button) => {
                button.setAttribute('role', 'menuitem')
                button.classList.add('quiet')   // every item alike in a menu: none is the next step
                // Chosen: the menu closes, whatever the press then draws.
                button.addEventListener('click', () => { if (closeMenus()) queueMicrotask(() => draw(true)) })
                return button
            })) : null)
        : null

    // What is true of it besides its state, in one quiet line: no count of its commits, which its dots show, nor of its
    // files, which its uncommitted node and its commits' details show.
    const gate = lane.gate
    const facts = el('div', { class: 'facts' },
        lane.quiet ? Object.assign(keyed(state('quiet', `Quiet for ${quietFor(lane.quietDays)}`, 'small quiet-for'), `${key}:quiet`), { title: `Nothing done in it since ${exactly(lane.lastActive)}: set it aside, or drop it, if it is not wanted now` }) : null,
        lane.branch !== lane.name ? el('span', { text: `branch ${lane.branch}` }) : null,
        lane.behind ? el('span', { text: `${lane.behind} behind ${repo.integrationBranch}`, 'data-anim': `${key}:behind`, 'data-sig': lane.behind }) : null,
        forked ? null : historyButton(repo, `fork:${lane.name}`, 'Show where it forked', `Read ${repo.integrationBranch} down to the commit ${lane.name} forked from`,
            () => readHistory(repo, 'fork', `fork:${lane.name}`, lane)),
        lane.dirty && lane.operation ? uncommittedOf(repo, lane.path, lane.name, lane.dirty) : null,
        merged && lane.sinceMerge === null && lane.pull?.head ? el('span', { text: `#${lane.pull.number}'s commit is not in its history now: what it merged cannot be told apart` }) : null,
        lane.pending ? null : keyed(gateOf(lane), `${key}:gate`, gate && `${gate.result} ${gate.current} ${gate.narrowed} ${gate.tier}`),
        lane.pending ? null : keyed(pushedOf(lane), `${key}:pushed`, true),
        stack0(lane) ? null : keyed(badgesOf(repo, lane), `${key}:badges`, true),
        keyed(serverOf(lane), `${key}:serving`))

    const stack = lane.stack ?? []
    const all = expanded.has(key)
    const shown = all ? stack : stack.slice(0, STACK_SHOWN)
    const hidden = stack.length - shown.length
    // Each of its commits keyed by its hash, and known again by its words when they come back with another (made at
    // last, amended, rebased), so the row settles where it is rather than going and coming.
    const stackList = stack.length
        ? el('ul', { class: 'stack', 'data-anim-kids': true },
            shown.map((commit, index) => {
                const row = el('li', { class: `stack-commit${commit.pending ? ' pending' : ''}`, 'data-anim': `${key}@${commit.sha}`, 'data-alias': `${key}~${commit.subject}` },
                    isNaming(repo, commit) ? namingForm(repo, commit, lane.name) : [
                        el('span', { class: 'subject', text: commit.subject }),
                        el('span', { class: 'when', text: commit.pending ? '' : short(commit.at), title: exactly(commit.at) }),
                        rowActions(repo, commit, lane.name, lane)
                    ])
                return [
                    isNaming(repo, commit) ? row : selectable(row, repo, commit, lane.name),
                    index === 0 && badgesOf(repo, lane) ? el('li', { class: 'stack-badges' }, keyed(badgesOf(repo, lane), `${key}:badges`, true)) : null,
                    inlineDetails(repo, commit),
                    IN_SIDEBAR && index === 0 && selected?.form === 'reword' && selected.repo === repo.id && selected.lane === lane.name
                        ? el('li', { class: 'details-inline' }, paneFor(repo)) : null
                ]
            }),
            hidden > 0 || (all && stack.length > STACK_SHOWN) || lane.more
                ? el('li', { class: 'stack-more' }, el('button', {
                    type: 'button', class: 'btn link',
                    text: all ? 'Show fewer' : `Show ${hidden} older ${hidden === 1 ? 'commit' : 'commits'}${lane.more ? ' (the newest twenty)' : ''}`,
                    onclick: () => toggle(key)
                }))
                : null)
        : null

    const collisions = (lane.queue?.collisions ?? []).map((collision) => {
        const more = collision.paths.length > 3 ? `, and ${collision.paths.length - 3} more` : ''
        return el('p', { class: 'collide', text: `Collides with ${collision.lane} in ${collision.paths.slice(0, 3).join(', ')}${more}` })
    })

    // Dragged onto a commit of main, a clean lane is rebased there (after a look): ISL's drag-to-rebase.
    const draggable = !lane.dirty && !lane.operation && (lane.kind === 'working' || lane.kind === 'fresh') && !busy
    // The side bar is too narrow for the toolbar to keep its room, and opening it under the pointer would move
    // every lane below. So a hover there floats the one thing to do next and a ⋯ over the lane's corner, and ⋯
    // opens the rest in the card: a click, so the card growing is what was asked for.
    const toolsKey = `${key}:tools`
    const toolsOpen = IN_SIDEBAR && expanded.has(toolsKey)
    const next = IN_SIDEBAR ? buttons.find((button) => button.classList.contains('primary')) : null
    const corner = IN_SIDEBAR && buttons.length
        ? el('div', { class: 'corner' },
            next ?? null,
            el('button', {
                type: 'button', class: 'btn quiet more', text: '⋯', 'aria-expanded': String(toolsOpen),
                'aria-label': toolsOpen ? `Hide what ${lane.name} can do` : `Everything ${lane.name} can do`,
                title: toolsOpen ? 'Hide the buttons' : 'Everything this lane can do',
                onclick: (event) => { event.stopPropagation(); toggle(toolsKey) }
            }))
        : null
    // The state's reason is its title, except where it says what to do about a fault, which keeps a line.
    const said = keyed(state(tone, word), `${key}:state`, `${tone} ${word}`)
    if (detail) said.title = detail
    const changes = changesOf(repo, lane, key)
    // A question asked in it ticks over as it moves on (checking, then asking), as its state does.
    const asking = confirmOf(repo, lane, key)
    if (asking) asking.dataset.sig = `${pending.get(key)?.verb} ${pending.get(key)?.stage}`
    // Something running in it, or about to, by a press here or anywhere: a light runs down its line toward main.
    const underway = Boolean(lane.pending || runningIn(repo, lane))
    const card = el('li', {
        class: `lane tone-${tone}${toolsOpen ? ' tools-open' : ''}${moreOpen ? ' more-open' : ''}${forked ? '' : ' adrift'}${lane.pending ? ' pending' : ''}${underway ? ' working' : ''}${wantsOf(repo.id, lane.name).length ? ' wants-you' : ''}${stack.length || changes ? '' : ' bare'}`,
        'data-key': key, tabindex: '0', draggable: draggable ? 'true' : null,
        title: draggable ? 'Drag it onto a commit of main to rebase it there' : null,
        'data-anim': key, 'data-anim-kids': true
    },
        changes,
        stackList,
        el('div', { class: 'lane-head' },
            // Its name, its state, and beside them, never across the page from them, what can be done with it.
            el('div', { class: 'lane-title' },
                laneName(repo, lane),
                said,
                wantsBadge(repo.id, lane.name),
                el('div', { class: 'actions hover-actions' }, next ? buttons.filter((button) => button !== next) : buttons, moreMenu)),
            corner),
        agentsRow(repo, lane.name),
        facts,
        collisions,
        asking,
        liveOf(repo, lane),
        detail && tone === 'risk' ? el('p', { class: 'why', text: detail }) : null,
        failureOf(repo, lane),
        lane.operation && (lane.conflicts?.length || conflictButtons.length)
            ? el('div', { class: 'files conflicts' },
                el('div', { class: 'conflicts-head' },
                    el('span', { class: 'files-head', text: lane.conflicts?.length ? `Conflicts in ${plural(lane.conflicts.length, 'file')}` : 'Every conflict resolved: Continue carries on' }),
                    el('span', { class: 'grow' }), el('div', { class: 'actions' }, conflictButtons)),
                el('ul', { class: 'conflict-list' }, (lane.conflicts ?? []).map((file) => el('li', { 'data-anim': `${key}:conflict:${file}` },
                    opens(el('span', { class: 'conflict-path', text: file }), `Open ${file} to resolve it`,
                        () => openIn('conflicts', { repo: repo.path, lane: lane.name, path: file })),
                    el('button', {
                        type: 'button', class: 'btn link verb resolve', disabled: busy,
                        title: `Mark ${file} resolved: LaneKit refuses while a conflict marker is left in it`,
                        onclick: () => press({ repo: repo.id, verb: 'resolve', lane: lane.name, paths: [file] })
                    }, icon('check'), el('span', { text: 'Resolved' }))))))
            : null,
        forked ? forkCurve() : null)
    if (draggable) {
        card.addEventListener('dragstart', (event) => {
            event.dataTransfer.setData(LANE_DRAG, key)
            event.dataTransfer.effectAllowed = 'move'
            dragging = { repo: repo.id, lane: lane.name }
            card.classList.add('dragging')
            document.body.classList.add('dragging-lane')
        })
        card.addEventListener('dragend', () => { dragging = null; clearPreview(); card.classList.remove('dragging'); document.body.classList.remove('dragging-lane') })
    }
    return card
}

const landedRow = (repo, lane) => {
    const key = `${repo.id}/${lane.name}`
    const [tone, word, detail] = statusOf(lane)
    const busy = busyIn(repo.id)
    const sweepable = lane.kind === 'landed' && !lane.dirty
    // Landed, and something begun in it since: moved to a lane of its own, after which this one sweeps as usual.
    const carries = lane.kind === 'landed' && lane.dirty > 0 && lane.exists && !lane.operation
    return el('li', { 'data-key': key, tabindex: '0', 'data-anim': `${key}:finished`, 'data-anim-kids': true },
        el('span', { class: 'lane-name', text: lane.name }),
        keyed(state(tone, word), `${key}:finished-state`, `${tone} ${word}`),
        detail ? el('span', { class: 'muted', text: detail }) : null,
        carries ? uncommittedOf(repo, lane.path, lane.name, lane.dirty) : null,
        lane.port ? serverOf(lane) : null,
        el('span', { class: 'grow' }),
        el('div', { class: 'actions' },
            carries ? iconButton('branch', 'Move to a new lane…', {
                class: 'btn primary', disabled: busy || pending.get(key)?.verb === 'carry',
                title: `What is uncommitted in ${lane.name}, in a lane of its own from ${repo.integrationBranch}'s newest commit; then ${lane.name} sweeps as usual`,
                onclick: () => { pending.set(key, { verb: 'carry', stage: 'form', where: 'card' }); draw(true) }
            }) : null,
            sweepable ? el('button', {
                type: 'button', class: 'btn', text: 'Sweep…', disabled: busy,
                title: 'Check what a sweep would remove, then ask',
                onclick: () => check(repo, lane, 'sweep')
            }) : null,
            lane.exists ? openLinks(repo, lane) : null),
        el('div', { class: 'full' }, confirmOf(repo, lane, key)))
}

/**
 * Pull: main fast-forwarded to origin's, fetched first. Shown whenever origin has commits main lacks, and held, saying
 * why, while it cannot run (main ahead as well, its checkout on another branch, part-way, or with uncommitted work):
 * a Pull that is not there cannot say what it waits for (the owner, 2 Oct: there was no way to pull that he saw).
 */
const pullButton = (repo) => {
    const up = repo.main?.upstream
    if (!up?.behind) return null
    const block = pullBlockOf(repo)
    return iconButton('pull', `Pull ${up.behind}`, {
        class: `btn${block ? '' : ' primary'}`, disabled: busyIn(repo.id) || Boolean(block),
        title: block ?? `Fast-forward ${repo.integrationBranch} to ${up.name}: ${plural(up.behind, 'commit')} somebody pushed`,
        onclick: () => press({ repo: repo.id, verb: 'pull' })
    })
}

/**
 * Push, for main: shown while main has commits its upstream does not and nothing of the upstream's it lacks, and never
 * where GitHub said it takes its changes another way (by pull request, say). Asked first, in place: a push of main
 * reaches everybody.
 */
const pushMainButton = (repo) => {
    const main = repo.main
    const up = main?.upstream
    const rule = repo.github?.rules?.push
    if (!up?.ahead || up.behind || main.operation || rule?.allowed === false) return null
    const key = `push-main:${repo.id}`
    const words = `${plural(up.ahead, 'commit')} of ${repo.integrationBranch} to ${up.name}`
    if (pending.has(key)) {
        return el('span', { class: 'confirm-inline' },
            iconButton('push', `Push ${words}`, {
                class: 'btn primary', disabled: busyIn(repo.id), title: rule?.why ?? 'A fast-forward only: nothing of origin\'s is replaced',
                onclick: () => { pending.delete(key); press({ repo: repo.id, verb: 'push-main' }) }
            }),
            el('button', { type: 'button', class: 'btn quiet', text: 'Cancel', onclick: () => { pending.delete(key); draw(true) } }))
    }
    return iconButton('push', `Push ${up.ahead}`, {
        disabled: busyIn(repo.id),
        title: `git push: ${words}, asked first.${rule?.why ? ` ${rule.why}.` : ''}`,
        onclick: () => { pending.set(key, { verb: 'push-main', stage: 'confirm' }); draw(true) }
    })
}

const headOf = (repo) => {
    const parts = []
    parts.push(el('div', { class: 'repo-head' },
        el('h2', { text: repo.name ?? repo.id }),
        el('span', { class: 'repo-sub mono', text: repo.path }),
        el('span', { class: 'grow' }),
        repo.error ? null : el('div', { class: 'actions' },
            shownRepos().length > 1 ? iconButton('tab', 'A tab of its own', {
                title: `${repo.name ?? repo.id} in a ${host.inEditor ? 'LaneKit' : 'browser'} tab of its own (a Cmd- or Ctrl-click on its name in the switcher does the same)`,
                onclick: () => openOwnTab(repo.id)
            }, true) : null,
            // Pull and Push come in as origin and main move apart, and their counts tick over.
            keyed(pullButton(repo), `${repo.id}:pull`, true),
            keyed(pushMainButton(repo), `${repo.id}:push-main`, true),
            terminalButton(repo, null),
            iconButton('fetch', 'Fetch', {
                disabled: busyIn(repo.id),
                title: 'git fetch --prune: what is pushed, and what others pushed',
                onclick: () => press({ repo: repo.id, verb: 'fetch' })
            }))))
    if (repo.error) {
        parts.push(el('div', { class: 'facts' }, state('risk', repo.error, 'small')))
        return parts
    }
    const main = repo.main
    const base = repo.integrationBranch
    const up = main.upstream
    const facts = []
    if (!up) facts.push(state('quiet', `${base} has no upstream`, 'small'))
    else if (up.ahead && up.behind) facts.push(state('warn', `${base} and ${up.name} have diverged: ${up.ahead} here, ${up.behind} there`, 'small'))
    else if (up.ahead) facts.push(state('warn', `${plural(up.ahead, 'commit')} on ${base} not pushed`, 'small'))
    else if (up.behind) facts.push(state('info', `${up.behind} behind ${up.name}`, 'small'))
    else facts.push(state('done', `Up to date with ${up.name}`, 'small'))
    keyed(facts[0], `${repo.id}:upstream`, true)
    // Where GitHub said main takes its changes another way, there is no Push for it, and this says why.
    if (up?.ahead && repo.github?.rules?.push?.allowed === false) facts.push(el('span', { text: `${repo.github.rules.push.why}: not pushed to from here` }))
    // When it last heard from origin: fetched by itself every few minutes while a page is open.
    if (repo.fetchError) facts.push(state('warn', `Could not fetch: ${repo.fetchError}`, 'small'))
    else if (main.fetchedAt) facts.push(el('span', { text: `fetched ${ago(main.fetchedAt)}`, title: exactly(main.fetchedAt) }))
    if (!main.onIntegration) facts.push(state('warn', `The main checkout is on ${main.branch}, not ${base}: landing needs ${base}`, 'small'))
    if (main.operation) facts.push(state('risk', `The main checkout is part-way through a ${main.operation}`, 'small'))
    // Uncommitted work in the main checkout is drawn on main's line (mainChangesRow); said here only where it is not.
    if (main.dirty && (main.operation || !main.onIntegration || !(main.changes ?? []).length)) facts.push(uncommittedOf(repo, main.path, `the main checkout of ${repo.id}`, main.dirty, `${main.dirty} uncommitted in the main checkout`))
    const github = repo.github ?? {}
    if (github.state === 'absent') facts.push(el('span', { text: 'Pull requests: gh is not installed here' }))
    else if (github.state === 'signed-out') facts.push(el('span', { text: 'Pull requests: sign in with gh auth login' }))
    else if (github.state === 'not-github') facts.push(el('span', { text: 'Pull requests: its remote is not on GitHub' }))
    else if (github.error) facts.push(state('warn', `GitHub: ${github.error}`, 'small'))
    if (repo.planError) facts.push(state('warn', `The queue could not be planned: ${repo.planError}`, 'small'))
    // Its pull requests that wait on your review, each a link to it, where GitHub said so: home lists them all.
    const mine = repo.github?.slug ? (current?.reviews ?? []).filter((review) => review.repo === repo.github.slug) : []
    if (mine.length) {
        facts.push(el('span', { class: 'waits-on-you' }, state('warn', `${plural(mine.length, 'pull request')} ${mine.length === 1 ? 'waits' : 'wait'} on your review:`, 'small'),
            mine.slice(0, 3).map((review) => {
                const href = safeHref(review.url)
                return el('span', { class: 'waiting-pr' },
                    href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: `#${review.number}`, title: review.title }) : el('span', { text: `#${review.number}`, title: review.title }),
                    reviewButton(repo, review.number, { iconOnly: true }))
            })))
    }
    // Read further back than main's newest: said here too, with the way back, so it is not only at the foot of a long log.
    if (repo.spineDeeper) facts.push(el('span', { class: 'deeper' }, `${shownOf(repo, true) ?? `${repo.spine.length} of ${base}'s commits shown`} · `, newestButton(repo, 'newest-top')))
    parts.push(el('div', { class: 'facts' }, facts))
    // Agents at work in the main checkout itself, on a line of their own as a lane's are.
    parts.push(agentsRow(repo, null))
    return parts
}

// The editor's side bar is narrow and short: there, main's log runs down to the oldest commit a lane
// forked from, and at least four; the tab and a browser show it whole.
const IN_SIDEBAR = document.documentElement.dataset.surface === 'sidebar'
const SIDEBAR_SPINE = 4
const spineOf = (repo, live) => {
    if (!IN_SIDEBAR) return repo.spine
    const deepest = Math.max(-1, ...live.map((lane) => repo.spine.findIndex((commit) => commit.sha === lane.base)))
    return repo.spine.slice(0, Math.max(SIDEBAR_SPINE, deepest + 1))
}

// Main's line further back: the service reads it a page further at each ask, or down to where a lane forked, for every
// page it answers, and the newest alone again when asked. While an ask is out its button says so and keeps the keyboard,
// so Enter on Older commits again reads further still.
const readingHistory = new Map()   // repo id -> what was asked: 'older', 'newest', 'newest-top' or 'fork:<lane>'
const historyKey = (repo, what) => `history:${repo.id}:${what}`
const keyedNode = (key) => [...document.querySelectorAll('[data-key]')].find((node) => node.dataset.key === key)
// The foot's buttons stand in for each other when the one with the keyboard goes: Older commits once main's first commit
// is read, Newest only once the log is back to the newest.
const STANDS_IN = { older: 'newest', newest: 'older' }
const readHistory = async (repo, way, what, lane = null) => {
    if (readingHistory.has(repo.id)) return
    const ours = document.activeElement?.dataset?.key === historyKey(repo, what)
    readingHistory.set(repo.id, what)
    draw(true)
    let read = false
    try {
        took(await host.history(repo.id, way, lane?.name))
        read = true
    } catch (error) {
        notice(error.message)
    } finally {
        readingHistory.delete(repo.id)
        draw(true)
    }
    // A lane brought onto main's line is shown, and given the keyboard, where it now is; a button of the foot that went
    // hands the keyboard to the one beside it.
    if (read && lane) {
        focusLane(repo.id, lane.name)
        keyedNode(`${repo.id}/${lane.name}`)?.focus({ preventScroll: true })
    } else if (ours && STANDS_IN[what] && !keyedNode(historyKey(repo, what))) {
        keyedNode(historyKey(repo, STANDS_IN[what]))?.focus({ preventScroll: true })
    }
}
const historyButton = (repo, what, text, title, onclick) => {
    const asked = readingHistory.get(repo.id)
    return el('button', {
        type: 'button', class: 'btn link', 'data-key': historyKey(repo, what), title, onclick,
        text: asked === what ? 'Reading…' : text, 'aria-busy': asked === what ? 'true' : null, 'aria-disabled': asked && asked !== what ? 'true' : null
    })
}
const newestButton = (repo, what) => historyButton(repo, what, 'Newest only', `Show only the newest commits of ${repo.integrationBranch} again`,
    () => readHistory(repo, 'newest', what))
/** How many of main's commits the log shows, of how many its line holds: briefly at the foot of the line, which says
    whose they are, and whole in the header. Nothing where git could not count them. */
const shownOf = (repo, whole = false) => {
    if (!Number.isFinite(repo.spineTotal)) return null
    const [shown, total, base] = [repo.spine.length.toLocaleString(), repo.spineTotal.toLocaleString(), repo.integrationBranch]
    if (!repo.spineMore) return `All ${total} of ${base}'s commits${whole ? ' shown' : ''}`
    return whole ? `${shown} of ${base}'s ${total} commits shown` : `${shown} of ${total} shown`
}
/** The foot of main's line: what reads further back, Newest only once it is read further than its newest, and the count. */
const footOf = (repo) => {
    const base = repo.integrationBranch
    const count = shownOf(repo)
    return [
        repo.spineNext > 0 ? historyButton(repo, 'older', plural(repo.spineNext, 'older commit'), `Read ${repo.spineNext} further back in ${base}`,
            () => readHistory(repo, 'older', 'older')) : null,
        repo.spineMore && repo.spineAtMost ? el('span', { text: `The newest ${repo.spine.length} of ${base}; git log has the rest` }) : null,
        repo.spineDeeper ? newestButton(repo, 'newest') : null,
        count ? el('span', { class: 'count', text: count }) : null
    ].filter(Boolean)
}

const logOf = (repo) => {
    if (repo.error) return []
    const onSpine = new Set(repo.spine.map((commit) => commit.sha))
    const live = repo.lanes.filter((lane) => (lane.kind === 'working' || lane.kind === 'fresh') && !lane.aside)
    const newestFirst = (a, b) => (b.head?.at ?? 0) - (a.head?.at ?? 0)
    // No row saying there are no lanes, nor a New lane beside it: every commit of main offers one (the owner, 2 Oct).
    const rows = []
    const spine = spineOf(repo, live)
    // Origin ahead of main, with commits this log does not hold: a dashed row above main's newest says so, with Pull.
    const upstream = repo.main?.upstream
    if (upstream?.behind > 0 && !onSpine.has(upstream.sha)) {
        rows.push(el('li', { class: 'commit remote-ahead', 'data-anim': `${repo.id}:remote-ahead`, 'data-sig': upstream.behind },
            el('span', { class: 'tag remote', text: upstream.name, 'data-anim': `${repo.id}:tag:${upstream.name}` }),
            el('span', { class: 'subject muted', text: `${plural(upstream.behind, 'newer commit')} than ${repo.integrationBranch}, as of the last fetch` }),
            pullButton(repo)))
    }
    // Main's first commit, where the whole of its line is drawn: the line stops at its dot.
    const root = !repo.spineMore && spine.length === repo.spine.length ? spine.length - 1 : -1
    spine.forEach((commit, index) => {
        for (const lane of live.filter((candidate) => candidate.base === commit.sha).sort(newestFirst)) rows.push(laneCard(repo, lane))
        // The main checkout's own uncommitted work, on main's line just above the commit it was begun on, as a lane's sits on its.
        if (index === 0) rows.push(mainChangesRow(repo))
        rows.push(commitRow(repo, commit, `${index === 0 ? 'tip' : ''}${index === root ? ' root' : ''}`, index === 0 ? repo.integrationBranch : null))
        rows.push(inlineDetails(repo, commit))
    })
    if (spine.length < repo.spine.length) {
        rows.push(el('li', { class: 'older', text: `${plural(repo.spine.length - spine.length, 'older commit')} of ${repo.integrationBranch}: Show in an Editor Tab has them` }))
    }
    const older = live.filter((lane) => !onSpine.has(lane.base)).sort(newestFirst)
    // The foot of main's line: dashed where its history goes on, as ISL draws it, whether or not lanes forked further
    // back are listed below it. Where the side bar has cut the log short, the row above says so instead.
    if (spine.length === repo.spine.length && (repo.spineMore || repo.spineDeeper)) {
        rows.push(el('li', { class: `foot ${repo.spineMore ? 'continues' : 'end'}` }, footOf(repo)))
    }
    if (older.length) {
        rows.push(el('li', { class: 'older', text: `Forked from further back in ${repo.integrationBranch}` }))
        for (const lane of older) rows.push(laneCard(repo, lane, false))
    }
    return rows.filter(Boolean)
}

// ---------------------------------------------------------------------------
// the queue: the order to land in, what each needs, and who collides with whom
// ---------------------------------------------------------------------------

const VERDICT_WORDS = {
    'land now': ['done', 'ready to land'], 'gate now': ['info', 'needs a gate'], 'commit first': ['warn', 'commit first'],
    'hold the gate': ['warn', 'waits for another lane'], 'rebase first': ['risk', 'rebase first'], parked: ['quiet', 'parked']
}
/**
 * The landing order as groups rather than one chain: an order only holds between lanes that collide, so the rest are
 * said by what each needs. Ready, Needs a gate, Commit first, Waiting (each with the lanes it waits for), Rebase first,
 * Part-way (a rebase or a merge not finished), and Quiet last: a lane gone quiet that is not ready. Plain data in and
 * out, so lanekit's tests run it as it is written here (test/tidy.test.mjs).
 */
const LANDING_GROUPS = [
    ['land now', 'Ready'], ['gate now', 'Needs a gate'], ['commit first', 'Commit first'],
    ['hold the gate', 'Waiting'], ['rebase first', 'Rebase first'], ['parked', 'Part-way']
]
const landingGroupsOf = (lanes) => {
    const queued = lanes.filter((lane) => lane.queue && !lane.aside)
    const byPlace = (a, b) => (a.queue.position ?? 0) - (b.queue.position ?? 0) || a.name.localeCompare(b.name)
    const isQuiet = (lane) => lane.quiet && lane.queue.verdict !== 'land now'
    const groups = []
    for (const [verdict, label] of LANDING_GROUPS) {
        const members = queued.filter((lane) => lane.queue.verdict === verdict && !isQuiet(lane)).sort(byPlace)
        if (!members.length) continue
        groups.push({
            verdict, label,
            lanes: members.map((lane) => ({
                name: lane.name,
                // Whom it waits for: the lanes it collides with that land before it.
                after: verdict === 'hold the gate'
                    ? (lane.queue.collisions ?? []).map((collision) => collision.lane).filter((other) => {
                        const ahead = queued.find((candidate) => candidate.name === other)
                        return ahead && (ahead.queue.position ?? 0) < (lane.queue.position ?? 0)
                    })
                    : []
            }))
        })
    }
    const quiet = queued.filter(isQuiet).sort((a, b) => (b.quietDays ?? 0) - (a.quietDays ?? 0) || a.name.localeCompare(b.name))
    if (quiet.length) groups.push({ verdict: 'quiet', label: 'Quiet', lanes: quiet.map((lane) => ({ name: lane.name, after: [], days: lane.quietDays })) })
    return groups
}
/** How long a lane has been quiet, in the largest unit that says it. */
const quietFor = (days) => (days >= 60 ? plural(Math.floor(days / 30), 'month') : days >= 14 ? plural(Math.floor(days / 7), 'week') : plural(days, 'day'))
/** Each landing group's colour, in the queue and at home. */
const VERDICT_TONES = { 'land now': 'done', 'gate now': 'info', 'commit first': 'warn', 'hold the gate': 'warn', 'rebase first': 'risk', parked: 'quiet', quiet: 'quiet', empty: 'quiet' }

/**
 * A repository at a glance, for its card at home: how many lanes it has, its landing order by group with a group of
 * the lanes with nothing in them yet, its agents with any waiting on you first, and what is running in it and waiting.
 * Plain data in and out, so lanekit's tests run it as it is written here, with landingGroupsOf (test/tidy.test.mjs).
 */
const AGENT_ORDER = { 'needs-you': 0, running: 1, thinking: 1, failed: 2, ready: 3, done: 4 }
const glanceOf = (repo, agents, jobs, reviews = []) => {
    const lanes = repo.error ? [] : repo.lanes
    const live = lanes.filter((lane) => (lane.kind === 'working' || lane.kind === 'fresh') && !lane.aside)
    const groups = landingGroupsOf(lanes).map((group) => ({ verdict: group.verdict, label: group.label, names: group.lanes.map((item) => item.name) }))
    const queued = new Set(groups.flatMap((group) => group.names))
    const empty = live.filter((lane) => !queued.has(lane.name) && lane.kind === 'fresh' && !lane.dirty).map((lane) => lane.name)
    if (empty.length) groups.push({ verdict: 'empty', label: 'Nothing committed', names: empty })
    const theirs = agents.filter((agent) => agent.repo === repo.id)
        .sort((a, b) => (AGENT_ORDER[a.state] ?? 5) - (AGENT_ORDER[b.state] ?? 5) || (b.since ?? 0) - (a.since ?? 0))
    const mine = jobs.filter((job) => job.repo === repo.id)
    return {
        lanes: live.length,
        aside: lanes.filter((lane) => lane.aside && lane.kind !== 'landed' && lane.kind !== 'missing').length,
        finished: lanes.filter((lane) => lane.kind === 'landed' || lane.kind === 'missing').length,
        groups,
        agents: theirs,
        needsYou: theirs.filter((agent) => agent.state === 'needs-you').length,
        running: mine.find((job) => job.state === 'running') ?? null,
        waiting: mine.filter((job) => job.state === 'queued').length,
        // Its pull requests waiting on this person's review, matched by its owner/name on GitHub.
        reviews: repo.github?.slug ? reviews.filter((review) => review.repo === repo.github.slug).length : 0
    }
}

/** The landing order at the head of a repository, in groups, with Land next when one is ready. */
const queueOf = (repo) => {
    if (repo.error) return []
    const groups = landingGroupsOf(repo.lanes)
    if (!groups.length) return []
    const ready = groups.find((group) => group.verdict === 'land now')
    const next = ready ? repo.lanes.find((lane) => lane.name === ready.lanes[0].name) : null
    const busy = busyIn(repo.id)
    return [el('div', { class: 'queue' },
        el('span', { class: 'queue-title', text: 'Landing order' }),
        // A lane whose verdict changes slides from its old group to its new one.
        el('div', { class: 'queue-groups' }, groups.map((group) => el('span', { class: 'queue-group', 'data-anim': `${repo.id}:queue:${group.verdict}` },
            el('span', { class: 'queue-label', text: group.label }),
            group.lanes.map((item) => {
                const lane = repo.lanes.find((candidate) => candidate.name === item.name)
                const words = item.after.length ? `${item.name}, after ${item.after.join(' and ')}` : item.days ? `${item.name}, quiet for ${quietFor(item.days)}` : item.name
                const chip = el('span', {
                    class: 'queue-item', tabindex: '0', role: 'button', title: `${words}: ${VERDICT_WORDS[lane?.queue?.verdict]?.[1] ?? group.label.toLowerCase()}`,
                    'data-anim': `${repo.id}:queue-lane:${item.name}`, 'data-sig': group.verdict
                },
                    el('span', { class: `queue-dot ${VERDICT_TONES[group.verdict] ?? 'quiet'}`, 'aria-hidden': 'true' }),
                    el('span', { class: 'queue-name', text: item.name }),
                    item.after.length ? el('span', { class: 'queue-after', text: `after ${item.after.join(', ')}` }) : null)
                chip.addEventListener('click', () => focusLane(repo.id, item.name))
                chip.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusLane(repo.id, item.name) } })
                return chip
            })))),
        el('span', { class: 'grow' }),
        next && !byPullRequest(repo) ? (() => {
            const block = landBlockOf(repo, next)
            return iconButton('land', `Land ${next.name}…`, {
                class: `btn${block ? '' : ' primary'}`, disabled: busy || Boolean(block),
                title: block ?? `Check that ${next.name} can land, then ask: it is ready, and first among any it collides with`,
                onclick: () => check(repo, next, 'land')
            })
        })() : null,
        // Where main lands by pull request, the first ready lane whose pull request may be merged.
        next && prStepOf(repo, next)?.next === 'merge' ? iconButton('land', `Merge ${next.name}…`, {
            class: 'btn primary', disabled: busy, title: `Merge #${next.pull.number} on GitHub: it is approved, and first among any it collides with`,
            onclick: () => { pending.set(`${repo.id}/${next.name}`, { verb: 'merge', stage: 'confirm' }); draw(true); focusLane(repo.id, next.name) }
        }) : null)]
}

// A collision drawn: a bracket in the log's right margin from one lane's card to the other's.
const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, tag)
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
    return node
}
const drawCollisions = () => {
    for (const [id, kept] of sections) {
        const repo = current?.repos.find((candidate) => candidate.id === id)
        const log = kept.log
        log.querySelector(':scope > svg.collisions')?.remove()
        const pairs = []
        for (const lane of repo?.error ? [] : repo?.lanes ?? []) {
            for (const collision of lane.queue?.collisions ?? []) {
                if (lane.name < collision.lane) pairs.push([lane.name, collision.lane, collision.paths])
            }
        }
        log.classList.toggle('has-collisions', pairs.length > 0)
        if (!pairs.length) continue
        const box = log.getBoundingClientRect()
        const card = (name) => [...log.querySelectorAll(':scope > li[data-key]')].find((node) => node.dataset.key === `${id}/${name}`)
        const svg = svgEl('svg', { class: 'collisions', width: 16, height: Math.ceil(box.height) })
        pairs.forEach(([a, b, paths], index) => {
            const one = card(a)?.querySelector('.lane-head')?.getBoundingClientRect()
            const two = card(b)?.querySelector('.lane-head')?.getBoundingClientRect()
            if (!one || !two) return
            const y1 = Math.round(one.top - box.top + one.height / 2)
            const y2 = Math.round(two.top - box.top + two.height / 2)
            const x = 12 - (index % 3) * 4
            const path = svgEl('path', { d: `M 0 ${y1} H ${x} V ${y2} H 0`, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round' })
            const title = svgEl('title')
            title.textContent = `${a} and ${b} both change ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`
            path.append(title)
            svg.append(path)
        })
        log.append(svg)
    }
}
window.addEventListener('resize', () => drawCollisions())

/** A lane set aside, in its list: what it holds, how long it has been quiet, and Bring back, Drop… and Goto. */
const asideRow = (repo, lane) => {
    const key = `${repo.id}/${lane.name}`
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    return el('li', { 'data-key': key, tabindex: '0', 'data-anim': `${key}:aside`, 'data-anim-kids': true },
        el('span', { class: 'tag lane-name', text: lane.name, title: portOf(lane) }),
        el('span', { class: 'muted', text: [lane.ahead ? plural(lane.ahead, 'commit') : 'nothing committed', lane.dirty ? `${lane.dirty} uncommitted` : null,
            lane.aside ? `set aside ${ago(Date.parse(lane.aside))}` : null, lane.quiet ? `quiet for ${quietFor(lane.quietDays)}` : null].filter(Boolean).join(' · ') }),
        el('span', { class: 'grow' }),
        el('div', { class: 'actions' },
            iconButton('unaside', 'Bring back', { disabled: busy, title: 'Into the landing order and the log again', onclick: () => press({ repo: repo.id, verb: 'resume', lane: lane.name }) }),
            lane.exists && !lane.operation ? iconButton('trash', 'Drop…', { class: 'btn quiet', disabled: busy, title: 'Remove its folder and keep its branch, after a check', onclick: () => check(repo, lane, 'drop') }) : null,
            terminalButton(repo, lane)),
        el('div', { class: 'full' }, confirmOf(repo, lane, key)))
}

const settledOf = (repo) => {
    const settled = repo.error ? [] : repo.lanes.filter((lane) => lane.kind === 'landed' || lane.kind === 'missing')
    const asideLanes = repo.error ? [] : repo.lanes.filter((lane) => lane.aside && lane.kind !== 'landed' && lane.kind !== 'missing')
    return [
        asideLanes.length ? el('p', { class: 'landed-title', text: 'Set aside' }) : null,
        asideLanes.length ? el('ul', { class: 'landed aside-list' }, asideLanes.map((lane) => asideRow(repo, lane))) : null,
        settled.length ? el('p', { class: 'landed-title', text: 'Finished lanes' }) : null,
        settled.length ? el('ul', { class: 'landed' }, settled.map((lane) => landedRow(repo, lane))) : null
    ].filter(Boolean)
}

// ---------------------------------------------------------------------------
// the switcher: one repository, or every one, and a tab of its own for each
// ---------------------------------------------------------------------------

/** The repositories this page draws: the one chosen, while it is here, or all of them. */
const shownRepos = () => {
    const all = current?.repos ?? []
    const one = only ? all.find((repo) => repo.id === only) : null
    return one ? [one] : all
}
/** The repository chosen, while it is here; null when the page shows every one. */
const shownId = () => (only && current?.repos.some((repo) => repo.id === only) ? only : null)
const liveLanes = (repo) => (repo.error ? [] : repo.lanes.filter((lane) => (lane.kind === 'working' || lane.kind === 'fresh') && !lane.aside))

/** Show one repository (its id), or every one (null): remembered where this page keeps it, and drawn at once. */
const showRepo = (id) => {
    only = id
    // Another repository, or home: drawn whole, not as what changed from the one before.
    motion.hush()
    // What was chosen or being named in a repository no longer shown goes with it.
    if (id && selected && selected.repo !== id) selected = null
    if (id && naming && naming.repo !== id) naming = null
    if (host.inEditor) keep({ only: id })
    else history.replaceState(null, '', id ? `?repo=${encodeURIComponent(id)}` : location.pathname)
    draw(true)
    window.scrollTo(0, 0)
}
/** A repository in a tab of its own: a LaneKit tab in the editor (one per repository, brought forward if open), a browser tab elsewhere. */
const openOwnTab = (id) => {
    if (host.inEditor) return host.tab(id).catch((error) => notice(error.message))
    window.open(`?repo=${encodeURIComponent(id)}`, '_blank', 'noopener')
}

const drawSwitcher = () => {
    const nav = $('switcher')
    const repos = current?.repos ?? []
    nav.hidden = repos.length < 2
    if (nav.hidden) { nav.replaceChildren(); return }
    const showing = shownId()
    const busy = (id) => (current.jobs ?? []).some((job) => job.repo === id && (job.state === 'running' || job.state === 'queued'))
    const tab = (id, label, count, title, { running = false, broken = false } = {}) => el('a', {
        href: id ? `?repo=${encodeURIComponent(id)}` : location.pathname,
        // Its key keeps the keyboard on it across a redraw, as a lane's does.
        'data-key': `switcher:${id ?? ''}`,
        title, 'aria-current': id === showing ? 'page' : null,
        'aria-label': `${label}, ${plural(count, 'lane')}${running ? ', something running' : ''}${broken ? ', unreadable' : ''}`,
        onclick: (event) => {
            const elsewhere = event.metaKey || event.ctrlKey || event.shiftKey
            // A browser opens the address in a tab of its own by itself; the editor is asked to.
            if (elsewhere && !host.inEditor) return
            event.preventDefault()
            if (elsewhere) { if (id) openOwnTab(id); return }
            if (id !== showing) showRepo(id)
        },
        onauxclick: (event) => { if (host.inEditor && event.button === 1) { event.preventDefault(); if (id) openOwnTab(id) } }
    },
    el('span', { class: broken ? 'broken' : null, text: label }),
    el('span', { class: 'n', text: String(count), 'data-anim': `switcher:${id ?? ''}:count`, 'data-sig': count }),
    running ? el('span', { class: 'busy', title: 'Something is running in it', 'data-anim': `switcher:${id ?? ''}:busy` }) : null)
    nav.replaceChildren(
        tab(null, 'Home', repos.reduce((sum, repo) => sum + liveLanes(repo).length, 0), 'Every repository at a glance, each opened from its card ([ and ] step through them)'),
        ...repos.map((repo) => tab(repo.id, repo.name ?? repo.id, liveLanes(repo).length,
            `${repo.path}${repo.error ? ` — ${repo.error}` : ''}\n${host.inEditor ? 'Cmd- or Ctrl-click, or a middle click' : 'Cmd- or Ctrl-click'}: a tab of its own`,
            { running: repo.id !== showing && busy(repo.id), broken: !!repo.error })))
}

/** The page's title, and the editor's tab's: the repository's name while one is shown, LaneKit while every one is. */
let titled = null
const sayTitle = () => {
    const shown = current ? shownRepos() : []
    const one = shown.length === 1 ? shown[0] : null
    const said = JSON.stringify([shownId(), one ? one.name ?? one.id : null])
    if (said === titled) return
    titled = said
    document.title = one ? `${one.name ?? one.id} · LaneKit` : 'LaneKit'
    host.showing(shownId(), one ? one.name ?? one.id : null)
}

// ---------------------------------------------------------------------------
// repositories without lanes: each a press from them, after a look at what that writes
// ---------------------------------------------------------------------------

/** Adopt's check, run first: what the question will show. */
const adoptCheck = async (bare) => {
    const answer = await press({ repo: bare.id, verb: 'adopt', dryRun: true })
    if (answer) pending.set(`adopt:${bare.id}`, { verb: 'adopt', stage: 'checking', jobId: answer.id })
    draw(true)
}
/** What the check printed, asked for once it has ended: the files it would write and the window its lanes take. */
const checkSaid = async (waiting) => {
    if (waiting.asked) return
    waiting.asked = true
    try {
        const job = await host.job(waiting.jobId, 0)
        const lines = String(job.output ?? '').split('\n')
        const kept = lines.filter((line) => /^\s+(would write|kept|note)\b|lanes come from/.test(line)).map((line) => line.trim())
        waiting.said = kept.length ? kept.join('\n') : lines.slice(-12).join('\n').trim()
    } catch {
        waiting.said = ''
    }
    draw(true)
}
const bareRow = (bare) => {
    const key = `adopt:${bare.id}`
    const waiting = pending.get(key)
    const job = waiting?.jobId ? jobById(waiting.jobId) : null
    if (waiting?.stage === 'checking' && job?.state === 'done') waiting.stage = job.code === 0 ? 'confirm' : 'refused'
    if (waiting && waiting.stage !== 'checking') checkSaid(waiting)
    const giving = (current?.jobs ?? []).find((candidate) => candidate.repo === bare.id && candidate.verb === 'adopt' && !candidate.dryRun && candidate.state !== 'done')
    const busy = busyIn(bare.id) || Boolean(waiting) || Boolean(giving)
    const said = waiting?.said ? el('pre', { class: 'adopt-said', text: waiting.said }) : null
    const dismiss = (label) => el('button', { type: 'button', class: 'btn quiet', text: label, onclick: () => { pending.delete(key); draw(true) } })
    const question = !waiting ? null
        : waiting.stage === 'checking' ? el('div', { class: 'confirm' }, el('p', { text: `Reading ${bare.id} for what lanes need…` }))
            : waiting.stage === 'refused' ? el('div', { class: 'confirm refused' }, el('p', { text: `${bare.id} cannot be given lanes as it is. What the check said:` }), said, dismiss('Dismiss'))
                : el('div', { class: 'confirm' },
                    el('p', { text: `Give ${bare.id} lanes? These files are written, each only where it is missing, and committed on its own as one commit, so every lane starts with them. Nothing else of yours goes in it, and nothing is pushed.` }),
                    said,
                    el('button', {
                        type: 'button', class: 'btn primary', text: 'Give it lanes', disabled: busyIn(bare.id),
                        onclick: async () => {
                            pending.delete(key)
                            draw(true)
                            const answer = await press({ repo: bare.id, verb: 'adopt' })
                            // Its output says what is left to decide, so it opens when it ends.
                            if (answer) showWhenDone.add(answer.id)
                        }
                    }),
                    dismiss('Cancel'))
    return el('li', {},
        el('span', { class: 'bare-name', text: bare.id }),
        el('span', { class: 'muted mono bare-path', text: bare.path }),
        el('span', { class: 'grow' }),
        giving ? state('info', 'Giving it lanes…', 'small')
            : iconButton('plus', 'Give it lanes…', { disabled: busy, title: `Shows what LaneKit would write into ${bare.id}, then asks (lane adopt --commit)`, onclick: () => adoptCheck(bare) }),
        question ? el('div', { class: 'full' }, question) : null)
}
/** The repositories here with no lanes yet, listed apart: LaneKit draws a repository once it has them. */
const withoutLanesOf = () => {
    const bare = current?.withoutLanes ?? []
    if (!bare.length) return null
    return el('section', { class: 'without-lanes' },
        el('p', { class: 'landed-title', text: `Without lanes · ${bare.length}` }),
        el('ul', { class: 'landed' }, bare.map(bareRow)))
}

// ---------------------------------------------------------------------------
// home: with two or more repositories and none chosen, each one as a card of how it stands, without its log
// ---------------------------------------------------------------------------

/** Home is shown while no one repository is chosen and there are two or more to choose from. */
const atHome = () => !shownId() && (current?.repos.length ?? 0) > 1

/** How main stands against origin, and anything in its checkout that would stop a land, a few words each. */
const mainWords = (repo) => {
    const main = repo.main
    const base = repo.integrationBranch
    const up = main.upstream
    const words = []
    if (!up) words.push(state('quiet', `${base} has no upstream`, 'small'))
    else if (up.ahead && up.behind) words.push(state('warn', `${base} and ${up.name} have diverged`, 'small'))
    else if (up.ahead) words.push(state('warn', `${plural(up.ahead, 'commit')} on ${base} not pushed`, 'small'))
    else if (up.behind) words.push(state('info', `${up.behind} behind ${up.name}`, 'small'))
    else words.push(state('done', `Up to date with ${up.name}`, 'small'))
    if (repo.fetchError) words.push(state('warn', 'Could not fetch', 'small'))
    if (!main.onIntegration) words.push(state('warn', `Main checkout on ${main.branch}`, 'small'))
    if (main.operation) words.push(state('risk', `Main checkout part-way through a ${main.operation}`, 'small'))
    if (main.dirty) words.push(state('warn', `${main.dirty} uncommitted in the main checkout`, 'small'))
    const newest = repo.spine?.[0]
    if (newest?.at) words.push(el('span', { text: `${base} moved ${ago(newest.at)}`, title: `${newest.subject} · ${exactly(newest.at)}` }))
    return words
}

/** A repository opened from home, with its lane in front where one was named. */
const openFromHome = (repo, laneName = null) => {
    showRepo(repo.id)
    if (laneName) focusLane(repo.id, laneName)
}

/** Its agents, those waiting on you first, each where it works: three, and how many more. */
const homeAgentsOf = (repo, glance) => [
    ...glance.agents.slice(0, 3).map((agent) => el('div', { class: 'home-agent' },
        agentChip(repo, agent), el('span', { class: 'muted', text: `in ${agent.lane ?? 'the main checkout'}` }))),
    glance.agents.length > 3 ? el('div', { class: 'muted', text: `and ${glance.agents.length - 3} more` }) : null
].filter(Boolean)

/** Pull requests anywhere that wait on your review, above home's cards, newest first: each a link to it on GitHub. */
const reviewsHome = () => {
    const waiting = current?.reviews ?? []
    if (!waiting.length) return null
    const ours = new Map((current.repos ?? []).filter((repo) => repo.github?.slug).map((repo) => [repo.github.slug, repo]))
    return el('section', { class: 'home-reviews', 'aria-label': 'Pull requests waiting on your review' },
        el('p', { class: 'home-reviews-title', text: `Waiting on your review · ${waiting.length}` }),
        el('ul', {}, waiting.map((pr) => {
            const href = safeHref(pr.url)
            const mine = ours.get(pr.repo)
            return el('li', {},
                href ? el('a', { class: 'home-review-title', href, target: '_blank', rel: 'noopener noreferrer', text: pr.title, title: `${pr.title}, on GitHub` })
                    : el('span', { class: 'home-review-title', text: pr.title }),
                el('span', { class: 'pr-number', text: `#${pr.number}` }),
                pr.draft ? el('span', { class: 'pr-pill draft', text: 'Draft' }) : null,
                // One of the repositories here: its name, which opens it; anywhere else, its owner/name.
                mine ? el('button', { type: 'button', class: 'btn link', text: mine.name ?? mine.id, title: `${pr.repo}: open it here`, onclick: () => openFromHome(mine) })
                    : el('span', { class: 'muted', text: pr.repo }),
                mine && !mine.error ? reviewButton(mine, pr.number) : null,
                pr.author ? el('span', { class: 'muted', text: `by ${pr.author}` }) : null,
                pr.at ? el('span', { class: 'when', text: short(pr.at), title: exactly(pr.at) }) : null)
        })))
}

const homeCard = (repo) => {
    const glance = glanceOf(repo, current.agents ?? [], current.jobs ?? [], current.reviews ?? [])
    const name = repo.name ?? repo.id
    const counts = [plural(glance.lanes, 'lane'), glance.aside ? `${glance.aside} set aside` : null, glance.finished ? `${glance.finished} finished` : null]
    const running = glance.running
    const card = el('li', {
        class: `home-card${glance.needsYou ? ' wants-you' : ''}${repo.error ? ' broken' : ''}`,
        'data-key': `home:${repo.id}`, 'data-home': repo.id, tabindex: '0', 'aria-label': `${name}: ${counts.filter(Boolean).join(', ')}. Enter opens it`,
        'data-anim': `home:${repo.id}`, 'data-anim-kids': true
    },
    el('div', { class: 'home-head' },
        // A link, so a browser opens it in a tab of its own on a Cmd- or Ctrl-click, as the switcher's tabs do.
        el('a', {
            class: 'home-name', href: `?repo=${encodeURIComponent(repo.id)}`, text: name,
            onclick: (event) => {
                const elsewhere = event.metaKey || event.ctrlKey || event.shiftKey
                if (elsewhere && !host.inEditor) return
                event.preventDefault()
                if (elsewhere) openOwnTab(repo.id); else openFromHome(repo)
            }
        }),
        el('span', { class: 'home-counts', text: counts.filter(Boolean).join(' · ') }),
        el('span', { class: 'grow' }),
        host.inEditor ? el('button', { type: 'button', class: 'btn quiet', text: 'Open in a tab', title: `${name} in an editor tab of its own`, onclick: () => openOwnTab(repo.id) }) : null),
    // Cut short from its start, so the end of it, the repository's own folder, is what is read.
    el('div', { class: 'home-path', title: repo.path }, el('bdi', { dir: 'ltr', text: repo.path })),
    repo.error ? state('risk', repo.error, 'small') : [
        el('div', { class: 'home-row' }, mainWords(repo)),
        el('div', { class: 'home-row home-queue' }, glance.groups.length
            ? glance.groups.map((group) => el('span', { class: 'home-group' },
                el('span', { class: `queue-dot ${VERDICT_TONES[group.verdict] ?? 'quiet'}`, 'aria-hidden': 'true' }),
                el('span', { class: 'queue-label', text: group.label }),
                group.names.slice(0, 3).map((laneName) => el('button', {
                    type: 'button', class: 'btn link home-lane', text: laneName, title: `Open ${name} at ${laneName}`, onclick: () => openFromHome(repo, laneName)
                })),
                group.names.length > 3 ? el('span', { class: 'muted', text: `and ${group.names.length - 3} more` }) : null))
            : el('span', { class: 'muted', text: glance.lanes ? 'Nothing in the landing order' : 'No lanes yet' })),
        el('div', { class: 'home-agents', 'data-home-agents': repo.id }, homeAgentsOf(repo, glance)),
        glance.reviews ? el('div', { class: 'home-row' }, state('warn', `${plural(glance.reviews, 'pull request')} ${glance.reviews === 1 ? 'waits' : 'wait'} on your review`, 'small')) : null,
        running || glance.waiting ? el('div', { class: 'home-row' },
            running ? state('info', `${VERB_WORDS[running.verb] ?? running.verb}${running.lane ? ` ${running.lane}` : ''}`, 'small') : null,
            running?.startedAt ? el('span', { class: 'live-clock', 'data-since': String(running.startedAt), text: secondsSince(running.startedAt) }) : null,
            running?.step ? el('span', { class: 'home-step', text: running.step }) : null,
            glance.waiting ? el('span', { text: `${glance.waiting} waiting their turn` }) : null) : null
    ])
    // The card opens its repository wherever it is clicked but on what has a click of its own; Enter does too.
    card.addEventListener('click', (event) => { if (!event.target.closest('a, button, .opens')) openFromHome(repo) })
    card.addEventListener('keydown', (event) => {
        if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); openFromHome(repo) }
    })
    return card
}

const sectionFor = (repo) => {
    let kept = sections.get(repo.id)
    if (kept) return kept
    // Each part keyed, its children by their place; the log is where what went from it fades.
    const part = (name) => ({ 'data-anim': `${repo.id}:${name}`, 'data-anim-kids': true })
    kept = {
        root: el('section', { class: 'repo' }),
        head: el('div', part('head')),
        queue: el('div', part('queue')),
        log: (() => { const log = el('ol', { class: 'log', 'data-anim-scope': `${repo.id}:log`, 'data-anim-kids': true }); listenForDrops(log); return log })(),
        settled: el('div', part('settled'))
    }
    kept.root.append(kept.head, kept.queue, kept.log, kept.settled)
    sections.set(repo.id, kept)
    return kept
}

// A page drawn again under a pointer that has not moved is not hovered until a frame later (Chrome, and so the
// editor's webviews): what shows on hover — a lane's toolbar, a commit's commands — went for that frame at every
// redraw, several times a press (the owner, 1 Oct: it flickers). So what is under the pointer is marked as part of
// the redraw, as :hover would mark it, and the marks go when the pointer next moves and :hover has it again.
let pointerAt = null
let pointerMarked = false
const unmarkPointer = () => {
    if (!pointerMarked) return
    pointerMarked = false
    for (const node of document.querySelectorAll('.pointer')) node.classList.remove('pointer')
}
document.addEventListener('pointermove', (event) => { pointerAt = { x: event.clientX, y: event.clientY }; unmarkPointer() }, { passive: true })
document.addEventListener('pointerout', (event) => { if (!event.relatedTarget) { pointerAt = null; unmarkPointer() } })
const markPointer = () => {
    if (!pointerAt) return
    for (let node = document.elementFromPoint(pointerAt.x, pointerAt.y); node && node !== document.body; node = node.parentElement) {
        node.classList.add('pointer')
        pointerMarked = true
    }
}

/**
 * Draw what the last answer said. Only when it changed, or every half minute for the
 * "3 min ago"s: a redraw under a pointer halfway through a click loses the click.
 */
const draw = (force = false) => {
    if (!current) return
    const said = JSON.stringify({ ...current, at: 0, agents: null })
    if (!force && said === lastDrawn && Date.now() - lastDrawnAt < REDRAW_ANYWAY_MS) return
    lastDrawn = said
    lastDrawnAt = Date.now()
    moving(drawPage)
}
const drawPage = () => {
    const focusedKey = document.activeElement?.closest?.('[data-key]') === document.activeElement ? document.activeElement.dataset.key : null
    // A field being typed in is drawn again with what was typed (drafts) and keeps the keyboard where it was.
    const typing = document.activeElement?.dataset?.draft
    const caret = typing ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null

    const where = (current.roots?.length ? current.roots : [current.scan]).join(', ')
    $('where').textContent = where + (current.kit ? ` · lanekit ${current.kit}` : '')
    drawSwitcher()
    sayTitle()
    const pane = $('repos')
    const home = atHome()
    const shown = home ? [] : shownRepos()
    const ids = new Set(shown.map((repo) => repo.id))
    for (const [id, kept] of sections) {
        if (!ids.has(id)) { kept.root.remove(); sections.delete(id) }
    }
    const bare = shownId() ? null : withoutLanesOf()
    if (!current.repos.length) {
        pane.replaceChildren(el('div', { class: 'empty' },
            el('p', { class: 'empty-title', text: 'No repository here has lanes yet.' }),
            el('p', { class: 'muted', text: `LaneKit looks in ${where}: a checkout with a lane.config.json, one directly inside, or the one a lane belongs to. It appears here by itself.` }),
            el('p', {}, bare ? 'Give one lanes below, or run ' : 'To give a repository lanes, run ', el('code', { text: 'lane adopt --commit' }), ' in it; then ask your agent to follow ',
                el('a', { href: 'https://github.com/Oerba-Labs/lanekit/blob/main/INSTALL.md', target: '_blank', rel: 'noopener noreferrer', text: 'INSTALL.md' }),
                ' for what only the repository can say: how its app picks a port, and its tests.')), bare)
        drawCommandBar()
        return
    }
    const empty = $('empty')
    if (empty) empty.remove()
    shown.forEach((repo, index) => {
        const kept = sectionFor(repo)
        kept.head.replaceChildren(...headOf(repo))
        kept.queue.replaceChildren(...queueOf(repo))
        kept.log.replaceChildren(...logOf(viewOf(repo)))
        // Main pulled, fetched or pushed: a light runs down its line, as down a lane's while something runs in it.
        kept.log.classList.toggle('working', (current.jobs ?? []).some((job) => job.state === 'running' && job.repo === repo.id && !job.lane))
        kept.settled.replaceChildren(...settledOf(repo))
        // Moved only when out of place: moving a section takes the focus out of its form.
        const there = pane.children[index]
        if (there !== kept.root) pane.insertBefore(kept.root, there ?? null)
    })
    for (const node of [...pane.children]) {
        if (![...sections.values()].some((kept) => kept.root === node)) node.remove()
    }
    if (home) {
        // Nothing chosen in a log not drawn: the details pane and a lane being named go with it.
        selected = null
        naming = null
        const waiting = reviewsHome()
        if (waiting) pane.append(waiting)
        pane.append(el('ul', { class: 'home', 'aria-label': 'Repositories' }, current.repos.map(homeCard)))
    }
    if (bare) pane.append(bare)
    drawDetails()
    drawCommandBar()
    if (wantFocus) focusLane(wantFocus.repo, wantFocus.lane)
    if (focusedKey) [...document.querySelectorAll('[data-key]')].find((node) => node.dataset.key === focusedKey)?.focus({ preventScroll: true })
    if (typing) {
        const again = [...document.querySelectorAll('[data-draft]')].find((node) => node.dataset.draft === typing)
        if (again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(...caret) } catch { /* a field with no caret */ } }
    }
    drawCollisions()
    markPointer()
}

// ---------------------------------------------------------------------------
// the keyboard: move between lanes, and press the one in focus's buttons
// ---------------------------------------------------------------------------

const KEYS = [
    ['j  ↓', 'the next lane'], ['k  ↑', 'the lane before'], ['Enter', host.inEditor ? 'its changes' : 'its newest commit\'s details'],
    ['g', 'gate it'], ['l', 'land it, after a check'], ['r', 'rebase it onto main'], ['p', 'push it, or pull what origin has of it that it lacks'],
    ...(host.inEditor ? [['o', 'its terminal: yours moves to it, and the files you have open reopen from it'], ['a', 'start an agent in it']] : []),
    ['c', 'commit what is uncommitted'], ['u', 'uncommit its newest commit'], ['f', 'fetch'], ['n', 'a new lane, on the one in focus or main'],
    ['[  ]', 'the repository before, or the next, Home among them'], ['?', 'these keys'],
    ['Esc', 'close the details, this, or the output']
]
const keysPanel = el('div', { class: 'keys', hidden: true, role: 'dialog', 'aria-label': 'Keys' },
    el('p', { class: 'keys-title', text: 'Keys' }),
    el('dl', {}, KEYS.map(([key, what]) => [el('dt', { text: key }), el('dd', { text: what })])))
document.body.append(keysPanel)
const toggleKeys = (show = keysPanel.hidden) => { if (show) motion.appear(keysPanel, 0, -6); else motion.disappear(keysPanel, 0, -6) }
$('updated').before(el('button', { type: 'button', class: 'btn link keys-toggle', text: 'Keys', title: 'What the keyboard does here (?)', onclick: () => toggleKeys() }))

const laneCards = () => [...document.querySelectorAll('li[data-key][tabindex]')]
const laneInFocus = () => {
    const node = document.activeElement?.closest?.('li[data-key]')
    if (!node) return null
    const [repoId, ...rest] = node.dataset.key.split('/')
    const repo = current?.repos.find((candidate) => candidate.id === repoId)
    const lane = repo?.lanes.find((candidate) => candidate.name === rest.join('/'))
    return repo && lane ? { repo, lane, key: node.dataset.key } : null
}
document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    // A tab of the switcher is a link the mouse leaves the keyboard on: the page's keys still work from it.
    if (event.target.closest?.('input, textarea, select, button, a, summary, [contenteditable]') && !event.target.closest?.('.switcher')) return
    const key = event.key
    const done = () => event.preventDefault()
    if (key === '?') { toggleKeys(); return done() }
    if (key === 'Escape' && !keysPanel.hidden) { toggleKeys(false); return done() }
    if (key === 'Escape' && selected) { select(null); return done() }
    if ((key === '[' || key === ']') && (current?.repos.length ?? 0) > 1) {
        const order = [null, ...current.repos.map((repo) => repo.id)]
        const at = order.indexOf(shownId())
        showRepo(order[(at + (key === ']' ? 1 : order.length - 1)) % order.length])
        return done()
    }
    const cards = laneCards()
    if (['j', 'k', 'ArrowDown', 'ArrowUp'].includes(key) && cards.length) {
        const at = cards.indexOf(document.activeElement)
        const next = key === 'j' || key === 'ArrowDown' ? Math.min(cards.length - 1, at + 1) : Math.max(0, at - 1)
        cards[next].focus()
        cards[next].scrollIntoView({ block: 'nearest' })
        return done()
    }
    const here = laneInFocus()
    // At home a key acts on the card in focus, and only on one: there is no one repository on the page.
    const card = atHome() ? current.repos.find((candidate) => candidate.id === document.activeElement?.dataset?.home && !candidate.error) : null
    const repo = here?.repo ?? (atHome() ? card : shownRepos().find((candidate) => !candidate.error))
    if (key === 'n' && repo && card) showRepo(repo.id)
    if (key === 'n' && repo) {
        const from = here?.lane?.stack?.[0] ? { commit: here.lane.stack[0], lane: here.lane.name } : null
        if (from) startNaming(repo, from.commit, from.lane); else if (repo.spine?.[0]) startNaming(repo, repo.spine[0])
        return done()
    }
    if (key === 'f' && repo) { press({ repo: repo.id, verb: 'fetch' }); return done() }
    if (!here) return
    const { lane } = here
    const confirm = (verb) => { pending.set(here.key, { verb, stage: 'confirm' }); draw(true) }
    // A key does what its button would, and where the button is held, says why instead.
    const unless = (reason, then) => (reason ? notice(reason, 'ok') : then())
    const up = lane.upstream
    const act = {
        Enter: () => host.inEditor && (lane.kind === 'working' || lane.dirty) ? openIn('changes', { repo: repo.path, lane: lane.name })
            : lane.stack?.[0] ? select({ repo: repo.id, sha: lane.stack[0].sha, lane: lane.name }) : null,
        c: () => { if (lane.dirty && !lane.operation && !isMerged(lane)) select({ repo: repo.id, lane: lane.name, form: 'commit' }) },
        u: () => { if (lane.ahead > 0 && !lane.operation) uncommitLane(repo, lane) },
        g: () => unless(gateBlockOf(lane), () => confirm('gate')),
        l: () => unless(byPullRequest(repo) ? `${repo.integrationBranch} takes its changes by pull request: Merge… lands it` : landBlockOf(repo, lane), () => check(repo, lane, 'land')),
        r: () => lane.behind > 0 && confirm('rebase'),
        p: () => up?.behind > 0 && !up.ahead ? press({ repo: repo.id, verb: 'pull', lane: lane.name })
            : up?.behind > 0 ? unless(up.foreign ? `${up.name} has commits of somebody else's: bring them in first (git pull --rebase, in the lane)` : null, () => confirm('push-force'))
                : press({ repo: repo.id, verb: 'push', lane: lane.name }),
        a: () => host.inEditor && lane.exists && openIn('agent', { repo: repo.path, lane: lane.name }),
        o: () => host.inEditor && lane.exists && openIn('goto', { repo: repo.path, lane: lane.name })
    }[key]
    if (act) { act(); done() }
})

/** Bring a lane into view and mark it for a moment: the editor's status bar asked for it. */
let wantFocus = null
const focusLane = (repoId, laneName) => {
    if (shownId() && shownId() !== repoId && current?.repos.some((repo) => repo.id === repoId)) showRepo(repoId)
    const key = `${repoId}/${laneName}`
    const node = [...document.querySelectorAll('[data-key]')].find((candidate) => candidate.dataset.key === key)
    if (!node) { wantFocus = { repo: repoId, lane: laneName }; return }
    wantFocus = null
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.remove('flash')
    void node.offsetWidth
    node.classList.add('flash')
}

const header = document.querySelector('header.bar')
const measureBar = () => document.documentElement.style.setProperty('--bar-h', `${header.offsetHeight}px`)
if (typeof ResizeObserver === 'function') new ResizeObserver(measureBar).observe(header)
measureBar()

host.ready?.()
loop()
