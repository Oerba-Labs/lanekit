// The lanes page. Plain JavaScript, no build: lanekit has no dependencies and no build
// step, and this file is served as it is written.
//
// TWO PLACES, ONE PAGE. In a browser it asks `lane web` over HTTP. Inside VS Code it is a
// tab of the Lanes extension (vscode/host.mjs) and asks it by message: the extension runs
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
    for (const child of children.flat()) {
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
    on: () => {},
    remember: () => {},
    recall: () => null
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
        on: (type, listener) => listeners.set(type, [...(listeners.get(type) ?? []), listener]),
        remember: (value) => api.setState(value),
        recall: () => api.getState(),
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
    node.addEventListener('click', (event) => { if (!event.target.closest('a, button')) action() })
    node.addEventListener('keydown', (event) => {
        if (event.target === node && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); action() }
    })
    return node
}

// ---------------------------------------------------------------------------
// what the page remembers between answers
// ---------------------------------------------------------------------------

let current = null
let lastDrawn = ''
let lastDrawnAt = 0
const expanded = new Set(host.recall()?.expanded ?? [])   // `${repo}/${lane}` showing every commit, `…:files` showing files
const toggle = (key) => {
    if (expanded.has(key)) expanded.delete(key); else expanded.add(key)
    host.remember({ expanded: [...expanded] })
    draw(true)
}
const pending = new Map()       // `${repo}/${lane}` -> { verb, stage, jobId }
const sections = new Map()      // repo id -> the parts of its section that are kept
let shownJob = null
let shownFrom = 0

const busyIn = (repoId) => (current?.jobs ?? []).some((job) => job.repo === repoId && job.state === 'running')
const jobById = (id) => (current?.jobs ?? []).find((job) => job.id === id)

// ---------------------------------------------------------------------------
// asking
// ---------------------------------------------------------------------------

const notice = (message) => {
    const box = $('notice')
    box.textContent = message
    box.hidden = !message
    clearTimeout(notice.timer)
    if (message) notice.timer = setTimeout(() => { box.hidden = true }, 10000)
}

const took = (state) => {
    current = state
    const updated = $('updated')
    updated.classList.remove('lost')
    updated.textContent = 'Up to date'
    draw()
}

const refresh = async () => {
    try {
        took(await host.state())
    } catch {
        // A page waiting across a restart of its own server loses it for seconds: say so and
        // ask again, never take the silence for an answer.
        const updated = $('updated')
        updated.classList.add('lost')
        updated.textContent = host.inEditor ? 'The Lanes extension did not answer; asking again' : 'Cannot reach the lanes server; asking again'
    }
}

const loop = async () => {
    await refresh()
    setTimeout(loop, host.inEditor ? ASK_IN_EDITOR_MS : document.hidden ? ASK_HIDDEN_MS : ASK_EVERY_MS)
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh() })

// The editor tells the page what changed, and which lane to show when asked from outside it.
host.on('state', (message) => took(message.state))
host.on('job', (message) => { if (message.id === shownJob) followJob(message.id) })
host.on('focus', (message) => focusLane(message.repo, message.lane))

const press = async (body) => {
    let pressed
    try {
        pressed = await host.press(body)
    } catch {
        notice(host.inEditor ? 'The Lanes extension did not answer; nothing was run.' : 'The lanes server did not answer; nothing was run.')
        return null
    }
    const answer = pressed.body
    if (pressed.status >= 400) {
        notice(answer?.error ?? `Refused (${pressed.status}).`)
        return null
    }
    notice('')
    showJob(answer.id)
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
    $('job').hidden = false
    followJob(id)
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
    $('job').hidden = true
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
    if (lane.operation) return ['warn', lane.operation === 'rebase' ? 'Mid-rebase' : 'Mid-merge', 'Finish or abort it in the lane before anything else']
    if (lane.kind === 'landed') return lane.dirty ? ['warn', 'Landed, with uncommitted changes', 'A sweep would delete them'] : ['done', 'Landed', null]
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

const gateOf = (lane) => {
    const gate = lane.gate
    if (!gate) return state('quiet', 'Not gated yet', 'small')
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
    if (up.ahead) return el('span', { text: `${plural(up.ahead, 'commit')} not pushed` })
    if (up.behind) return el('span', { text: `${up.behind} behind ${up.name}` })
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

const serverOf = (lane) => {
    if (!lane.port) return el('span', { text: 'No port' })
    return lane.serving
        ? state('done', `Serving on ${lane.port}`, 'small')
        : state('quiet', `Port ${lane.port}, not serving`, 'small')
}

const openLinks = (repo, lane) => {
    if (host.inEditor) {
        // In the editor: its changes as diffs, a terminal in it, and the lane as a window of its own.
        if (!lane.exists) return []
        const holds = lane.kind === 'working' || lane.dirty > 0
        return [
            holds ? el('button', {
                type: 'button', class: 'btn', text: 'Changes',
                title: `Everything ${lane.name} holds that ${repo.integrationBranch} does not, committed or not, side by side`,
                onclick: () => openIn('changes', { repo: repo.path, lane: lane.name })
            }) : null,
            el('button', {
                type: 'button', class: 'btn', text: 'Terminal', title: `A terminal in ${lane.path}`,
                onclick: () => openIn('terminal', { repo: repo.path, lane: lane.name })
            }),
            el('button', {
                type: 'button', class: 'btn', text: 'Open', title: `Open ${lane.path} in a new window`,
                onclick: () => openIn('lane', { repo: repo.path, lane: lane.name })
            })
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

const commitRow = (repo, commit, className, label) => opens(
    el('li', { class: `commit ${className}` },
        label ? el('span', { class: 'branch-name', text: label }) : null,
        el('span', { class: 'sha', text: commit.short }),
        el('span', { class: 'subject', text: commit.subject, title: `${commit.subject}\n${commit.author}` }),
        el('span', { class: 'when', text: ago(commit.at), title: exactly(commit.at) })),
    `${commit.short} ${commit.subject}: show its changes`, showCommit(repo, commit))

/** "N uncommitted", which in the editor opens them against the checkout's own commit. */
const uncommittedOf = (repo, checkout, name, count, words = `${count} uncommitted`) =>
    opens(state('warn', words, 'small'), `Show what is uncommitted in ${name}`,
        () => openIn('uncommitted', { repo: repo.path, checkout, name }))

const confirmOf = (repo, lane, key) => {
    const waiting = pending.get(key)
    if (!waiting) return null
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
            el('p', { text: waiting.verb === 'land' ? `${lane.name} cannot land yet. The check below says why.` : `${lane.name} cannot be swept. The check below says why.` }),
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

const laneCard = (repo, lane) => {
    const key = `${repo.id}/${lane.name}`
    const [tone, word, detail] = statusOf(lane)
    const busy = busyIn(repo.id)
    // A lane with nothing in it has nothing to gate or land; one with uncommitted work is
    // shown the buttons, so their refusals can say why.
    const working = lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)

    const buttons = []
    if (working) {
        buttons.push(el('button', {
            type: 'button', class: 'btn', text: 'Gate', disabled: busy || lane.dirty > 0 || Boolean(lane.operation),
            title: lane.dirty ? 'Commit first: a gate result names a commit, and uncommitted changes are in none' : 'Rebase onto the integration branch and run the tier this lane earns',
            onclick: () => { pending.set(key, { verb: 'gate', stage: 'confirm' }); draw(true) }
        }))
        buttons.push(el('button', {
            type: 'button', class: `btn${lane.queue?.verdict === 'land now' ? ' primary' : ''}`, text: 'Land…', disabled: busy,
            title: 'Check whether it can land, then ask',
            onclick: () => check(repo, lane, 'land')
        }))
    }
    buttons.push(...openLinks(repo, lane))

    const facts = el('div', { class: 'facts' },
        lane.branch !== lane.name ? el('span', { text: `branch ${lane.branch}` }) : null,
        lane.ahead ? el('span', { text: plural(lane.ahead, 'commit') }) : null,
        lane.behind ? el('span', { text: `${lane.behind} behind ${repo.integrationBranch}` }) : null,
        lane.dirty ? uncommittedOf(repo, lane.path, lane.name, lane.dirty) : null,
        serverOf(lane),
        gateOf(lane),
        pushedOf(lane),
        pullOf(lane))

    const stack = lane.stack ?? []
    const all = expanded.has(key)
    const shown = all ? stack : stack.slice(0, STACK_SHOWN)
    const hidden = stack.length - shown.length
    const stackList = stack.length
        ? el('ul', { class: 'stack' },
            shown.map((commit) => opens(el('li', {},
                el('span', { class: 'sha', text: commit.short }),
                el('span', { class: 'subject', text: commit.subject, title: `${commit.subject}\n${commit.author}` }),
                el('span', { class: 'when', text: ago(commit.at), title: exactly(commit.at) })),
            `${commit.short} ${commit.subject}: show its changes`, showCommit(repo, commit))),
            hidden > 0 || (all && stack.length > STACK_SHOWN) || lane.more
                ? el('li', {}, el('button', {
                    type: 'button', class: 'btn link',
                    text: all ? 'Show fewer' : `Show ${hidden} more ${hidden === 1 ? 'commit' : 'commits'}${lane.more ? ' (the newest twenty)' : ''}`,
                    onclick: () => toggle(key)
                }))
                : null)
        : null

    const collisions = (lane.queue?.collisions ?? []).map((collision) => {
        const more = collision.paths.length > 3 ? `, and ${collision.paths.length - 3} more` : ''
        return el('p', { class: 'collide', text: `Collides with ${collision.lane} in ${collision.paths.slice(0, 3).join(', ')}${more}` })
    })

    const files = lane.queue?.files ?? []
    const filesKey = `${key}:files`
    const filesToggle = files.length
        ? el('button', {
            type: 'button', class: 'btn link', text: expanded.has(filesKey) ? 'Hide the files' : `${plural(files.length, 'file')} changed`,
            onclick: () => toggle(filesKey)
        })
        : null
    const filesList = files.length && expanded.has(filesKey)
        ? el('div', { class: 'files' }, files.map((file) => opens(el('div', { text: file }),
            `Show what ${lane.name} changed in ${file}`, () => openIn('file', { repo: repo.path, lane: lane.name, path: file }))))
        : null

    return el('li', { class: `lane tone-${tone}`, 'data-key': key },
        el('div', { class: 'lane-head' },
            el('span', { class: 'lane-name', text: lane.name }),
            state(tone, word),
            el('span', { class: 'grow' }),
            el('div', { class: 'actions' }, buttons)),
        facts,
        detail ? el('p', { class: 'why', text: detail }) : null,
        stackList,
        collisions,
        filesToggle ? el('p', { class: 'why' }, filesToggle) : null,
        filesList,
        confirmOf(repo, lane, key))
}

const landedRow = (repo, lane) => {
    const key = `${repo.id}/${lane.name}`
    const [tone, word, detail] = statusOf(lane)
    const busy = busyIn(repo.id)
    const sweepable = lane.kind === 'landed' && !lane.dirty
    return el('li', { 'data-key': key },
        el('span', { class: 'lane-name', text: lane.name }),
        state(tone, word),
        detail ? el('span', { class: 'muted', text: detail }) : null,
        lane.port ? serverOf(lane) : null,
        el('span', { class: 'grow' }),
        el('div', { class: 'actions' },
            sweepable ? el('button', {
                type: 'button', class: 'btn', text: 'Sweep…', disabled: busy,
                title: 'Check what a sweep would remove, then ask',
                onclick: () => check(repo, lane, 'sweep')
            }) : null,
            lane.exists ? openLinks(repo, lane) : null),
        el('div', { class: 'full' }, confirmOf(repo, lane, key)))
}

const headOf = (repo) => {
    const parts = []
    parts.push(el('div', { class: 'repo-head' },
        el('h2', { text: repo.name ?? repo.id }),
        el('span', { class: 'repo-sub mono', text: repo.path }),
        el('span', { class: 'grow' }),
        repo.error ? null : el('div', { class: 'actions' },
            host.inEditor ? el('button', {
                type: 'button', class: 'btn', text: 'Terminal', title: `A terminal in ${repo.path}`,
                onclick: () => openIn('terminal', { repo: repo.path })
            }) : null,
            el('button', {
                type: 'button', class: 'btn', text: 'Fetch', disabled: busyIn(repo.id),
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
    if (main.head) facts.push(el('span', { text: `${base} at ${main.head.short}` }))
    if (!up) facts.push(state('quiet', `${base} has no upstream`, 'small'))
    else if (up.ahead && up.behind) facts.push(state('warn', `${base} and ${up.name} have diverged: ${up.ahead} here, ${up.behind} there`, 'small'))
    else if (up.ahead) facts.push(state('warn', `${plural(up.ahead, 'commit')} on ${base} not pushed`, 'small'))
    else if (up.behind) facts.push(state('info', `${up.behind} behind ${up.name}, as of the last fetch`, 'small'))
    else facts.push(state('done', `Up to date with ${up.name}, as of the last fetch`, 'small'))
    if (!main.onIntegration) facts.push(state('warn', `The main checkout is on ${main.branch}, not ${base}: landing needs ${base}`, 'small'))
    if (main.operation) facts.push(state('risk', `The main checkout is part-way through a ${main.operation}`, 'small'))
    if (main.dirty) facts.push(uncommittedOf(repo, main.path, `the main checkout of ${repo.id}`, main.dirty, `${main.dirty} uncommitted in the main checkout`))
    const github = repo.github ?? {}
    if (github.state === 'absent') facts.push(el('span', { text: 'Pull requests: gh is not installed here' }))
    else if (github.state === 'signed-out') facts.push(el('span', { text: 'Pull requests: sign in with gh auth login' }))
    else if (github.state === 'not-github') facts.push(el('span', { text: 'Pull requests: its remote is not on GitHub' }))
    else if (github.error) facts.push(state('warn', `GitHub: ${github.error}`, 'small'))
    if (repo.planError) facts.push(state('warn', `The queue could not be planned: ${repo.planError}`, 'small'))
    parts.push(el('div', { class: 'facts' }, facts))
    return parts
}

const logOf = (repo) => {
    if (repo.error) return []
    const onSpine = new Set(repo.spine.map((commit) => commit.sha))
    const live = repo.lanes.filter((lane) => lane.kind === 'working' || lane.kind === 'fresh')
    const newestFirst = (a, b) => (b.head?.at ?? 0) - (a.head?.at ?? 0)
    const rows = []
    repo.spine.forEach((commit, index) => {
        for (const lane of live.filter((candidate) => candidate.base === commit.sha).sort(newestFirst)) rows.push(laneCard(repo, lane))
        rows.push(commitRow(repo, commit, index === 0 ? 'tip' : '', index === 0 ? repo.integrationBranch : null))
    })
    const older = live.filter((lane) => !onSpine.has(lane.base)).sort(newestFirst)
    if (older.length) {
        rows.push(el('li', { class: 'older', text: `Forked from further back in ${repo.integrationBranch}` }))
        for (const lane of older) rows.push(laneCard(repo, lane))
    }
    return rows
}

const settledOf = (repo) => {
    const settled = repo.error ? [] : repo.lanes.filter((lane) => lane.kind === 'landed' || lane.kind === 'missing')
    if (!settled.length) return []
    return [
        el('p', { class: 'landed-title', text: 'Finished lanes' }),
        el('ul', { class: 'landed' }, settled.map((lane) => landedRow(repo, lane)))
    ]
}

const newLaneForm = (repoId) => {
    const name = el('input', {
        name: 'name', placeholder: 'new-lane-name', autocomplete: 'off', spellcheck: 'false',
        pattern: '[a-z0-9][a-z0-9\\-]*', required: true,
        title: 'Lowercase letters, digits and dashes: it becomes a folder and a branch',
        'aria-label': 'New lane name'
    })
    const base = el('input', {
        name: 'base', placeholder: 'from main', autocomplete: 'off', spellcheck: 'false',
        title: 'Branch from something other than the integration branch (optional)', 'aria-label': 'Branch from'
    })
    const button = el('button', { type: 'submit', class: 'btn primary', text: 'New lane' })
    const form = el('form', {
        class: 'new-lane',
        onsubmit: async (event) => {
            event.preventDefault()
            if (!form.reportValidity()) return
            const body = { repo: repoId, verb: 'new', name: name.value.trim() }
            if (base.value.trim()) body.base = base.value.trim()
            const answer = await press(body)
            if (answer) { name.value = ''; base.value = '' }
        }
    }, name, base, button)
    form.button = button
    return form
}

const terminalOf = (repo) => {
    const shim = repo.slug ? `./${repo.slug}` : './<project>'
    return el('details', { class: 'terminal' },
        el('summary', { text: 'Run it from a terminal' }),
        el('pre', {
            text: [
                `cd ${repo.path}`,
                `${shim} lane list              what exists and what is serving`,
                `${shim} lane queue             the verdicts on this page`,
                `${shim} lane new <name>        what New lane runs`,
                `(in the lane) ${shim} gate     what Gate runs`,
                `${shim} lane land <name>       what Land runs, after --dry-run`,
                `${shim} lane sweep <name>      what Sweep runs, after --dry-run`,
                'lazygit                         in a lane: its branch, commits and stash'
            ].join('\n')
        }))
}

const sectionFor = (repo) => {
    let kept = sections.get(repo.id)
    if (kept) return kept
    kept = {
        root: el('section', { class: 'repo' }),
        head: el('div', {}),
        form: newLaneForm(repo.id),
        log: el('ol', { class: 'log' }),
        settled: el('div', {}),
        terminal: terminalOf(repo)
    }
    kept.root.append(kept.head, kept.form, kept.log, kept.settled, kept.terminal)
    sections.set(repo.id, kept)
    return kept
}

/**
 * Draw what the last answer said. Only when it changed, or every half minute for the
 * "3 min ago"s: a redraw under a pointer halfway through a click loses the click.
 */
const draw = (force = false) => {
    if (!current) return
    const said = JSON.stringify({ ...current, at: 0 })
    if (!force && said === lastDrawn && Date.now() - lastDrawnAt < REDRAW_ANYWAY_MS) return
    lastDrawn = said
    lastDrawnAt = Date.now()

    const where = (current.roots?.length ? current.roots : [current.scan]).join(', ')
    $('where').textContent = where + (current.kit ? ` · lanekit ${current.kit}` : '')
    const pane = $('repos')
    const ids = new Set(current.repos.map((repo) => repo.id))
    for (const [id, kept] of sections) {
        if (!ids.has(id)) { kept.root.remove(); sections.delete(id) }
    }
    if (!current.repos.length) {
        pane.replaceChildren(el('p', { class: 'muted', text: `No repository with lanes in ${where}. A checkout with a lane.config.json appears here by itself.` }))
        return
    }
    const empty = $('empty')
    if (empty) empty.remove()
    current.repos.forEach((repo, index) => {
        const kept = sectionFor(repo)
        kept.head.replaceChildren(...headOf(repo))
        kept.form.hidden = Boolean(repo.error)
        kept.form.button.disabled = busyIn(repo.id)
        kept.log.replaceChildren(...logOf(repo))
        kept.settled.replaceChildren(...settledOf(repo))
        // Moved only when out of place: moving a section takes the focus out of its form.
        const there = pane.children[index]
        if (there !== kept.root) pane.insertBefore(kept.root, there ?? null)
    })
    for (const node of [...pane.children]) {
        if (![...sections.values()].some((kept) => kept.root === node)) node.remove()
    }
    if (wantFocus) focusLane(wantFocus.repo, wantFocus.lane)
}

/** Bring a lane into view and mark it for a moment: the editor's status bar asked for it. */
let wantFocus = null
const focusLane = (repoId, laneName) => {
    const key = `${repoId}/${laneName}`
    const node = [...document.querySelectorAll('[data-key]')].find((candidate) => candidate.dataset.key === key)
    if (!node) { wantFocus = { repo: repoId, lane: laneName }; return }
    wantFocus = null
    node.scrollIntoView({ block: 'center', behavior: 'smooth' })
    node.classList.remove('flash')
    void node.offsetWidth
    node.classList.add('flash')
}

host.ready?.()
loop()
