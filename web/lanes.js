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
/** Keep a part of what this page remembers across a reload of its tab: the editor keeps one value for the whole page. */
const keep = (part) => host.remember({ ...(host.recall() ?? {}), ...part })
const expanded = new Set(host.recall()?.expanded ?? [])   // `${repo}/${lane}` showing every commit, `…:files` showing files
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
let here = null                 // { repo, lane }: where the editor is, the file in front's lane (null lane: main)
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

// ---------------------------------------------------------------------------
// asking
// ---------------------------------------------------------------------------

const notice = (message, tone = 'risk') => {
    const box = $('notice')
    box.textContent = message
    box.classList.toggle('ok', tone === 'ok')
    box.hidden = !message
    clearTimeout(notice.timer)
    if (message) notice.timer = setTimeout(() => { box.hidden = true }, 10000)
}

const took = (state) => {
    current = state
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
        failedHere(message.job)
    }
    if (message.id === shownJob) followJob(message.id)
})
/** A press made on this page that ended badly opens its output, once: what went wrong is there. */
const failedHere = (job) => {
    if (!job || job.state !== 'done' || job.code === 0 || !pressedHere.has(job.id)) return
    pressedHere.delete(job.id)
    if (shownJob !== job.id) showJob(job.id)
}

// A running press's clock, each second, without redrawing anything else.
const secondsSince = (at) => `${Math.max(0, Math.round((Date.now() - at) / 1000))} s`
setInterval(() => {
    for (const node of document.querySelectorAll('.live-clock')) node.textContent = secondsSince(Number(node.dataset.since))
}, 1000)
host.on('focus', (message) => focusLane(message.repo, message.lane))
host.on('here', (message) => {
    const next = message.repo ? { repo: message.repo, lane: message.lane ?? null } : null
    if (JSON.stringify(next) !== JSON.stringify(here)) { here = next; draw(true) }
})
const isHere = (repo, lane) => here && here.repo === repo.id && (here.lane ?? null) === (lane?.name ?? null)
const herePill = () => el('span', { class: 'here', text: 'You are here', title: 'The file in front of you in the editor is in this checkout' })

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
    $('job').hidden = false
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
    $('job').hidden = true
    drawCommandBar()
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
    const chip = el('span', { class: `agent-chip${busy ? ' busy' : ''}${agent.state === 'needs-you' ? ' needs-you' : ''}` },
        icon('agent'),
        el('span', { class: 'agent-name', text: name }),
        state(tone, agent.tool && (agent.state === 'running' || agent.state === 'needs-you') ? `${word} · ${agent.tool}` : word, 'small'),
        el('span', { class: 'when', text: short(agent.since) }))
    const about = `${name} in ${agent.lane ?? `${repo.id}'s main checkout`}: ${word.toLowerCase()} since ${exactly(agent.since)}`
    if (!host.inEditor) { chip.title = about; return chip }
    return opens(chip, `${about}. Click for its terminal`, () => openIn('agent-terminal', { repo: repo.path, key: agent.key }))
}

/** A lane's agents (or the main checkout's, with no lane), on a line of their own: there and empty when there are none,
    so the next word from an agent is drawn into it. */
const agentsRow = (repo, laneName) => el('div', { class: 'agents', 'data-agents': `${repo.id}/${laneName ?? ''}` },
    agentsOf(repo.id, laneName).map((agent) => agentChip(repo, agent)))

/** The agents alone, drawn again where they are: they change every few seconds while one works, and a whole page
    drawn again under a pointer loses a click. */
const drawAgents = () => {
    for (const row of document.querySelectorAll('.agents[data-agents]')) {
        const at = row.dataset.agents.indexOf('/')
        const repo = current?.repos.find((candidate) => candidate.id === row.dataset.agents.slice(0, at))
        if (repo) row.replaceChildren(...agentsOf(repo.id, row.dataset.agents.slice(at + 1) || null).map((agent) => agentChip(repo, agent)))
    }
    markPointer()
}

/**
 * Goto, ISL's way, in the editor: where you are moves to this lane (or, with no lane, to the main checkout). The files
 * open from elsewhere reopen from it, and the terminal in use follows and takes the focus, or one opens there; no
 * window opens. It is also how a lane's terminal is reached (the owner, 1 Oct: Terminal and Goto did the same thing),
 * so it is offered where you are too, where it brings your terminal there forward.
 */
const gotoButton = (repo, lane, extra = {}) => host.inEditor && (!lane || lane.exists)
    ? iconButton('goto', 'Goto', {
        ...extra,
        title: isHere(repo, lane) ? `You are here: your terminal in ${lane ? lane.name : `${repo.id}'s main checkout`}, in front`
            : lane ? `Move here: the files you have open reopen from ${lane.name}, and your terminal follows` : `Back to ${repo.id}'s main checkout: the files you have open reopen from it, and your terminal follows`,
        onclick: (event) => { event.stopPropagation(); openIn('goto', { repo: repo.path, lane: lane?.name }) }
    })
    : null

const openLinks = (repo, lane) => {
    if (host.inEditor) {
        // In the editor: its changes as diffs, an agent in it, and Goto, which is also the way to its terminal.
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
            gotoButton(repo, lane)
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

const DOING = { gate: 'Gating', land: 'Landing', rebase: 'Rebasing', push: 'Pushing', pr: 'Opening a pull request', sweep: 'Sweeping', new: 'Making it', pull: 'Pulling', fetch: 'Fetching' }
const runningIn = (repo, lane) => (current?.jobs ?? []).find((job) => job.state === 'running' && job.repo === repo.id && job.lane === lane.name)

/** What a press is doing to a lane, live: the verb, the gate's step, and a clock. */
const liveOf = (repo, lane) => {
    const job = runningIn(repo, lane)
    if (!job) return null
    return el('p', { class: 'live' },
        state('info', `${DOING[job.verb] ?? job.verb}${job.dryRun ? ' (a check)' : ''}`, 'small'),
        job.step ? el('span', { class: 'live-step', text: job.step }) : null,
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
        newest || tip ? gotoButton(repo, lane, { class: 'btn solid' }) : null,
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
        el('div', { class: 'lane-head' }, el('span', { class: 'tag lane-name', text: lane.name }), el('span', { class: 'muted small', text: where })),
        el('ul', { class: 'stack' }, (lane.stack ?? []).slice(0, STACK_SHOWN).map((commit) => el('li', { class: 'stack-commit' }, el('span', { class: 'subject', text: commit.subject })))),
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
    const row = el('li', { class: `commit ${className}`, 'data-sha': commit.sha },
        label && isHere(repo, null) ? herePill() : null,
        label ? el('span', { class: 'tag', text: label }) : null,
        remote ? el('span', { class: 'tag remote', text: remote, title: `Where ${remote} is, as of the last fetch` }) : null,
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

/**
 * What is uncommitted in a lane, as ISL draws its working copy: a node on the lane's line, a row of things to do
 * (View changes, Select all, Deselect all, Discard…), each file ticked or not, in the colour of what happened to
 * it, and + Commit… and ↓ Amend under them, which open the message form for the ticked files.
 */
const changesOf = (repo, lane, key) => {
    const files = lane.changes ?? []
    if (!lane.dirty || lane.operation) return null
    const all = expanded.has(`${key}:changes`)
    const shown = all ? files : files.slice(0, CHANGES_SHOWN)
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    const chosen = chosenOf(key, lane)
    const some = chosen.length > 0 && chosen.length < files.length
    const writing = selected?.repo === repo.id && selected?.lane === lane.name && (selected.form === 'commit' || selected.form === 'amend')
    const count = some ? ` ${chosen.length} of ${files.length}` : ''
    return el('div', { class: `changes${writing ? ' writing' : ''}` },
        el('div', { class: 'changes-actions tools' },
            host.inEditor ? verbLink('diff', 'View changes', `Everything uncommitted in ${lane.name}, side by side`, () => openIn('uncommitted', { repo: repo.path, checkout: lane.path, name: lane.name })) : null,
            verbLink('checkall', 'Select all', 'Tick every file', () => setChosen(key, lane, files.map((change) => change.path)), chosen.length === files.length),
            verbLink('box', 'Deselect all', 'Untick every file', () => setChosen(key, lane, []), chosen.length === 0),
            verbLink('trash', 'Discard…', 'Throw away what is uncommitted in the ticked files, after a look', () => { pending.set(key, { verb: 'discard', stage: 'confirm', paths: chosen }); draw(true) }, busy || !chosen.length)),
        el('ul', { class: 'change-list', 'aria-label': `${plural(lane.dirty, 'uncommitted file')} in ${lane.name}` }, shown.map((file) => {
            const status = file.status === '?' ? 'new' : file.status
            const tick = el('input', {
                type: 'checkbox', class: 'tick', checked: chosen.includes(file.path) ? true : null, 'aria-label': `Take ${file.path} in the next commit`,
                onchange: (event) => {
                    const out = unchecked.get(key) ?? new Set()
                    if (event.target.checked) out.delete(file.path); else out.add(file.path)
                    unchecked.set(key, out)
                    draw(true)
                }
            })
            return opens(el('li', {},
                tick,
                el('span', { class: `change-status s-${status}`, text: file.status === '?' ? 'U' : file.status, title: STATUS_WORD[file.status] ?? file.status }),
                el('span', { class: `change-path s-${status}`, text: file.path })),
            `Show what is uncommitted in ${file.path}`, () => openIn('uncommitted', { repo: repo.path, checkout: lane.path, name: lane.name, path: file.path }))
        })),
        files.length > CHANGES_SHOWN ? el('button', { type: 'button', class: 'btn link', text: all ? 'Show fewer' : `Show ${files.length - CHANGES_SHOWN} more`, onclick: () => toggle(`${key}:changes`) }) : null,
        el('div', { class: 'changes-actions' },
            verbLink('plus', `Commit${count}…`, some ? 'Commit the ticked files, with a message' : 'Commit every file above, with a message', () => select({ repo: repo.id, lane: lane.name, form: 'commit' }), busy || !chosen.length),
            lane.ahead ? verbLink('amend', `Amend${count}…`, `Fold the ticked files into ${lane.name}'s newest commit`, () => select({ repo: repo.id, lane: lane.name, form: 'amend' }), busy || !chosen.length) : null),
        IN_SIDEBAR && writing ? messageForm(repo, lane) : null)
}

const uncommittedOf = (repo, checkout, name, count, words = `${count} uncommitted`) =>
    opens(state('warn', words, 'small'), `Show what is uncommitted in ${name}`,
        () => openIn('uncommitted', { repo: repo.path, checkout, name }))

// ---------------------------------------------------------------------------
// what a press will do, drawn before it has: ISL moves the graph at once
// ---------------------------------------------------------------------------

const FORESEEN = new Set(['new', 'rebase', 'commit', 'uncommit', 'discard', 'resolve', 'land', 'sweep', 'push', 'pr'])
/** A press accepted: what it will do is drawn from now until a reading taken after it ended says what it did. */
const expect = (body, job) => {
    if (!FORESEEN.has(body.verb) || body.dryRun) return
    optimistic.push({ jobId: job.id, body, at: Date.now() })
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
        lanes: repo.lanes.map((lane) => ({ ...lane, stack: [...(lane.stack ?? [])], changes: [...(lane.changes ?? [])], conflicts: [...(lane.conflicts ?? [])] }))
    }
    for (const { body, at } of mine) {
        const lane = view.lanes.find((candidate) => candidate.name === body.lane)
        const titleOf = (message) => String(message ?? '').split('\n')[0]
        switch (body.verb) {
            case 'new':
                if (!view.lanes.some((candidate) => candidate.name === body.name)) {
                    view.lanes.push({ name: body.name, branch: body.name, kind: 'fresh', exists: false, base: body.base ?? repo.spine[0]?.sha, stack: [], changes: [], conflicts: [], dirty: 0, ahead: 0, behind: 0, pending: 'Making it…' })
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
            case 'land': case 'sweep': case 'push': case 'pr':
                if (lane) lane.pending = { land: 'Landing…', sweep: 'Sweeping…', push: 'Pushing…', pr: 'Opening a pull request…' }[body.verb]
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
            newest && isHere(repo, lane) ? herePill() : null,
            lane ? el('span', { class: 'tag', text: lane.name }) : tip ? el('span', { class: 'tag', text: repo.integrationBranch }) : null,
            el('span', { class: 'mono', text: commit.short }),
            el('span', { text: commit.author || details?.author || '' }),
            el('span', { text: ago(commit.at), title: exactly(commit.at) })),
        details?.error ? el('p', { class: 'muted', text: details.error })
            : !details ? el('p', { class: 'muted', text: 'Reading…' })
                : details.body ? el('p', { class: 'details-body', text: details.body }) : el('p', { class: 'muted details-body', text: 'No description.' }),
        el('div', { class: 'details-actions' },
            newest || tip ? gotoButton(repo, newest ? lane : null) : null,
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
        return
    }
    aside.replaceChildren(content)
    aside.hidden = false
    document.body.classList.add('has-details')
}
/** In the side bar, the details of what is chosen, under its row. */
const inlineDetails = (repo, commit) => (IN_SIDEBAR && selected?.sha && isSelected(repo, commit)
    ? el('li', { class: 'details-inline' }, commitPane(repo, commit, selected.lane)) : null)

// ---------------------------------------------------------------------------
// the command bar: what is running, what waits its turn, and how the last one went
// ---------------------------------------------------------------------------

const VERB_WORDS = { gate: 'Gating', land: 'Landing', rebase: 'Rebasing', push: 'Pushing', pr: 'Opening a pull request', sweep: 'Sweeping', new: 'Making a lane',
    pull: 'Pulling', fetch: 'Fetching', commit: 'Committing', uncommit: 'Uncommitting', discard: 'Discarding', resolve: 'Marking resolved' }
/** A job's command as a person would type it: lane …, gate, git …, without the node and the path in front. */
const typed = (command) => String(command ?? '').replace(/^node (?:\S*\/)?dev\/lane\.mjs /, 'lane ').replace(/^node (?:\S*\/)?dev\/gate\.mjs\b/, 'gate')
const cancelJob = async (id) => {
    try { if (!await host.cancel(id)) notice('It had begun already, so it was not cancelled.') } catch { notice('LaneKit did not answer; nothing was cancelled.') }
    refresh()
}
const drawCommandBar = () => {
    const bar = $('cmdbar')
    const jobs = current?.jobs ?? []
    const running = jobs.find((job) => job.state === 'running')
    const waiting = jobs.filter((job) => job.state === 'queued').reverse()
    const last = running ?? jobs.find((job) => job.state === 'done')
    if (!last && !waiting.length) { bar.hidden = true; document.body.classList.remove('has-cmdbar'); return }
    bar.hidden = false
    document.body.classList.add('has-cmdbar')
    const ok = last && last.state === 'done' && last.code === 0
    // Straight into replaceChildren, which writes a null as the word "null": the parts not there are left out first.
    const parts = (...kids) => kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false)
    bar.replaceChildren(...parts(
        last ? (running ? el('span', { class: 'spin', 'aria-hidden': 'true' })
            : el('span', { class: `mark ${ok ? 'ok' : 'bad'}`, text: ok ? '✓' : '✗', title: ok ? 'It finished' : `It failed (exit ${last.code})` })) : null,
        last ? el('code', { class: 'cmd', text: typed(last.command), title: last.command }) : null,
        running?.step ? el('span', { class: 'cmd-step', text: running.step }) : null,
        running ? el('span', { class: 'live-clock', 'data-since': String(running.startedAt), text: secondsSince(running.startedAt) })
            : last?.endedAt ? el('span', { class: 'when', text: short(last.endedAt), title: exactly(last.endedAt) }) : null,
        waiting.length ? el('span', { class: 'queued' },
            el('span', { class: 'muted', text: 'then' }),
            waiting.map((job) => el('span', { class: 'queued-job', title: typed(job.command) },
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
    goto: [['path', { d: 'M2.5 8h7.5' }], ['path', { d: 'M7 4.5 10.5 8 7 11.5' }], ['path', { d: 'M10.5 2.5h3v11h-3' }]],
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
const badgesOf = (lane) => {
    const pr = lane.pull
    if (!pr) return null
    const word = pr.draft && pr.state === 'OPEN' ? 'Draft' : PR_WORD[pr.state] ?? pr.state
    const href = safeHref(pr.url)
    const link = (props, ...kids) => href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, ...kids) : el('span', props, ...kids)
    return el('div', { class: 'badges' },
        pr.checks && pr.checks !== 'none'
            ? el('span', { class: `check ${pr.checks}`, title: `Checks ${pr.checks}`, text: { passing: '✓', failing: '✗', pending: '•' }[pr.checks] ?? '' }) : null,
        link({ class: `pr-pill ${word.toLowerCase()}`, title: pr.title }, icon('pr'), word),
        pr.review === 'APPROVED' ? el('span', { class: 'review ok', text: 'Approved' })
            : pr.review === 'CHANGES_REQUESTED' ? el('span', { class: 'review bad', text: 'Changes requested' }) : null,
        pr.comments ? el('span', { class: 'comments', title: plural(pr.comments, 'comment') }, icon('comment'), String(pr.comments)) : null,
        link({ class: 'pr-number', text: `#${pr.number}` }))
}

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
    if (waiting.verb === 'push-force') {
        return el('div', { class: 'confirm' },
            el('p', { text: `Replace origin's ${lane.branch}? It was rebased since it was pushed, so origin has ${plural(lane.upstream?.behind || 0, 'commit')} this lane no longer does. --force-with-lease replaces them only if nobody pushed there since this lane last fetched.` }),
            go('Replace it', { repo: repo.id, verb: 'push', lane: lane.name, force: true }), cancel)
    }
    if (waiting.verb === 'discard') {
        const files = waiting.paths ?? []
        const fresh = files.filter((file) => (lane.changes ?? []).find((change) => change.path === file)?.status === '?')
        const named = files.length === 1 ? files[0] : `${files.length} files`
        return el('div', { class: 'confirm danger' },
            el('p', { text: `Discard what is uncommitted in ${named}? A changed file goes back to "${lane.stack?.[0]?.subject ?? `${base}'s commit`}"` +
                `${fresh.length ? `, and ${fresh.length === files.length ? (files.length === 1 ? 'it is new, so it is deleted' : 'they are new, so they are deleted') : `${plural(fresh.length, 'new file')} ${fresh.length === 1 ? 'is' : 'are'} deleted`}` : ''}. Nothing keeps a copy.` }),
            el('button', {
                type: 'button', class: 'btn danger', text: files.length === 1 ? 'Discard it' : 'Discard them', disabled: busy,
                onclick: async () => { pending.delete(key); unchecked.delete(key); draw(true); await press({ repo: repo.id, verb: 'discard', lane: lane.name, paths: files }) }
            }), cancel)
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

/** A lane as ISL draws a stack: its name as a tag, its state, its uncommitted files and its commits on a line of
    its own, which curves into main's at the commit it forked from. `forked` is false for a lane drawn apart, below
    main's log, whose fork is further back than the log goes. */
const laneCard = (repo, lane, forked = true) => {
    const key = `${repo.id}/${lane.name}`
    const [tone, word, detail] = lane.pending ? ['info', lane.pending, null] : statusOf(lane)
    const busy = busyIn(repo.id) || Boolean(lane.pending)
    // A lane with nothing in it has nothing to gate or land; one with uncommitted work is
    // shown the buttons, so their refusals can say why.
    const working = lane.kind === 'working' || (lane.kind === 'fresh' && lane.dirty > 0)

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
        buttons.push(iconButton('gate', 'Gate', {
            disabled: busy || lane.dirty > 0 || Boolean(lane.operation),
            title: lane.dirty ? 'Commit first: a gate result names a commit, and uncommitted changes are in none' : 'Rebase onto the integration branch and run the tier this lane earns',
            onclick: () => { pending.set(key, { verb: 'gate', stage: 'confirm' }); draw(true) }
        }))
        buttons.push(iconButton('land', 'Land…', {
            class: `btn${lane.queue?.verdict === 'land now' ? ' primary' : ''}`, disabled: busy,
            title: 'Check whether it can land, then ask',
            onclick: () => check(repo, lane, 'land')
        }))
    }
    if ((working || lane.kind === 'fresh') && !lane.operation && lane.behind > 0) {
        buttons.push(iconButton('rebase', 'Rebase', {
            disabled: busy || lane.dirty > 0,
            title: lane.dirty ? 'Commit first: a rebase replays commits, and uncommitted changes are in none' : `Replay it on ${repo.integrationBranch} as it is now: ${lane.behind} behind`,
            onclick: ask('rebase')
        }))
    }
    if (lane.kind === 'working' && !lane.operation) {
        const up = lane.upstream
        if (!up || up.ahead > 0) {
            const rewrite = Boolean(up && up.behind > 0)
            buttons.push(iconButton('push', rewrite ? 'Push…' : 'Push', {
                disabled: busy,
                title: rewrite ? 'It was rebased since it was pushed: ask before replacing origin\'s copy' : up ? `Send ${plural(up.ahead, 'commit')} to origin` : 'Send the branch to origin, for the first time',
                onclick: rewrite ? ask('push-force') : () => press({ repo: repo.id, verb: 'push', lane: lane.name })
            }))
        } else if (!lane.pull && repo.github?.state === 'ok') {
            buttons.push(iconButton('pr', 'Pull request', {
                disabled: busy,
                title: `Open a pull request for ${lane.branch} into ${repo.integrationBranch}, from its commits' own words`,
                onclick: () => press({ repo: repo.id, verb: 'pr', lane: lane.name })
            }))
        }
    }
    // What openLinks has nothing for (no Changes for an empty lane, no Goto where you are) is left out, not kept as a gap.
    buttons.push(...openLinks(repo, lane).filter(Boolean))
    // A lane not being worked on: set aside (nothing removed), or dropped (its folder removed, its branch kept), after a check.
    if ((lane.kind === 'working' || lane.kind === 'fresh') && lane.exists && !lane.operation) {
        buttons.push(iconButton('aside', 'Set aside', { class: 'btn quiet', disabled: busy, title: 'Out of the landing order and the log, listed apart; nothing removed', onclick: () => press({ repo: repo.id, verb: 'aside', lane: lane.name }) }))
        buttons.push(iconButton('trash', 'Drop…', { class: 'btn quiet', disabled: busy, title: 'Remove its folder and keep its branch, after a check', onclick: () => check(repo, lane, 'drop') }))
    }
    if (lane.pending) buttons.length = 0

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

    // What is true of it besides its state, in one quiet line: no count of its commits, which its dots show.
    const facts = el('div', { class: 'facts' },
        lane.quiet ? Object.assign(state('quiet', `Quiet for ${quietFor(lane.quietDays)}`, 'small quiet-for'), { title: `Nothing done in it since ${exactly(lane.lastActive)}: set it aside, or drop it, if it is not wanted now` }) : null,
        lane.branch !== lane.name ? el('span', { text: `branch ${lane.branch}` }) : null,
        lane.behind ? el('span', { text: `${lane.behind} behind ${repo.integrationBranch}` }) : null,
        lane.dirty && lane.operation ? uncommittedOf(repo, lane.path, lane.name, lane.dirty) : null,
        lane.pending ? null : gateOf(lane),
        lane.pending ? null : pushedOf(lane),
        stack0(lane) ? null : badgesOf(lane),
        serverOf(lane),
        filesToggle)

    const stack = lane.stack ?? []
    const all = expanded.has(key)
    const shown = all ? stack : stack.slice(0, STACK_SHOWN)
    const hidden = stack.length - shown.length
    const stackList = stack.length
        ? el('ul', { class: 'stack' },
            shown.map((commit, index) => {
                const row = el('li', { class: `stack-commit${commit.pending ? ' pending' : ''}` },
                    isNaming(repo, commit) ? namingForm(repo, commit, lane.name) : [
                        el('span', { class: 'subject', text: commit.subject }),
                        el('span', { class: 'when', text: commit.pending ? '' : short(commit.at), title: exactly(commit.at) }),
                        rowActions(repo, commit, lane.name, lane)
                    ])
                return [
                    isNaming(repo, commit) ? row : selectable(row, repo, commit, lane.name),
                    index === 0 && badgesOf(lane) ? el('li', { class: 'stack-badges' }, badgesOf(lane)) : null,
                    inlineDetails(repo, commit),
                    IN_SIDEBAR && index === 0 && selected?.form === 'reword' && selected.repo === repo.id && selected.lane === lane.name
                        ? el('li', { class: 'details-inline' }, paneFor(repo)) : null
                ]
            }),
            hidden > 0 || (all && stack.length > STACK_SHOWN) || lane.more
                ? el('li', { class: 'stack-more' }, el('button', {
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
    const said = state(tone, word)
    if (detail) said.title = detail
    const card = el('li', {
        class: `lane tone-${tone}${toolsOpen ? ' tools-open' : ''}${isHere(repo, lane) ? ' is-here' : ''}${forked ? '' : ' adrift'}${lane.pending ? ' pending' : ''}`,
        'data-key': key, tabindex: '0', draggable: draggable ? 'true' : null,
        title: draggable ? 'Drag it onto a commit of main to rebase it there' : null
    },
        el('div', { class: 'lane-head' },
            isHere(repo, lane) ? herePill() : null,
            el('span', { class: 'tag lane-name', text: lane.name, title: portOf(lane) }),
            said,
            el('span', { class: 'grow' }),
            corner,
            el('div', { class: 'actions hover-actions' }, next ? buttons.filter((button) => button !== next) : buttons)),
        agentsRow(repo, lane.name),
        facts,
        collisions,
        confirmOf(repo, lane, key),
        filesList,
        liveOf(repo, lane),
        detail && tone === 'risk' ? el('p', { class: 'why', text: detail }) : null,
        failureOf(repo, lane),
        lane.operation && (lane.conflicts?.length || conflictButtons.length)
            ? el('div', { class: 'files conflicts' },
                el('div', { class: 'conflicts-head' },
                    el('span', { class: 'files-head', text: lane.conflicts?.length ? `Conflicts in ${plural(lane.conflicts.length, 'file')}` : 'Every conflict resolved: Continue carries on' }),
                    el('span', { class: 'grow' }), el('div', { class: 'actions' }, conflictButtons)),
                el('ul', { class: 'conflict-list' }, (lane.conflicts ?? []).map((file) => el('li', {},
                    opens(el('span', { class: 'conflict-path', text: file }), `Open ${file} to resolve it`,
                        () => openIn('conflicts', { repo: repo.path, lane: lane.name, path: file })),
                    el('button', {
                        type: 'button', class: 'btn link verb resolve', disabled: busy,
                        title: `Mark ${file} resolved: LaneKit refuses while a conflict marker is left in it`,
                        onclick: () => press({ repo: repo.id, verb: 'resolve', lane: lane.name, paths: [file] })
                    }, icon('check'), el('span', { text: 'Resolved' }))))))
            : null,
        changesOf(repo, lane, key),
        stackList,
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
    return el('li', { 'data-key': key, tabindex: '0' },
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

/** Pull: main fast-forwarded to origin, when it is behind, on main, clean, and has nothing origin lacks. */
const pullButton = (repo) => {
    const main = repo.main
    const up = main?.upstream
    if (!up?.behind || up.ahead || !main.onIntegration || main.dirty || main.operation) return null
    return iconButton('pull', `Pull ${up.behind}`, {
        disabled: busyIn(repo.id),
        title: `Fast-forward ${repo.integrationBranch} to ${up.name}: ${plural(up.behind, 'commit')} somebody pushed`,
        onclick: () => press({ repo: repo.id, verb: 'pull' })
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
            pullButton(repo),
            gotoButton(repo, null),
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
    // When it last heard from origin: fetched by itself every few minutes while a page is open.
    if (repo.fetchError) facts.push(state('warn', `Could not fetch: ${repo.fetchError}`, 'small'))
    else if (main.fetchedAt) facts.push(el('span', { text: `fetched ${ago(main.fetchedAt)}`, title: exactly(main.fetchedAt) }))
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

const logOf = (repo) => {
    if (repo.error) return []
    const onSpine = new Set(repo.spine.map((commit) => commit.sha))
    const live = repo.lanes.filter((lane) => (lane.kind === 'working' || lane.kind === 'fresh') && !lane.aside)
    const newestFirst = (a, b) => (b.head?.at ?? 0) - (a.head?.at ?? 0)
    const rows = []
    if (!live.length) {
        rows.push(el('li', { class: 'empty-lanes' },
            el('span', { text: 'No lanes yet. A lane is a folder of its own, on its own branch and port.' }),
            repo.spine?.[0] ? iconButton('plus', 'New lane', {
                title: `A lane from ${repo.integrationBranch} as it is now; or hover any commit of ${repo.integrationBranch} below for one from there`,
                onclick: () => startNaming(repo, repo.spine[0])
            }) : null))
    }
    const spine = spineOf(repo, live)
    // Origin ahead of main, with commits this log does not hold: a dashed row above main's newest says so, with Pull.
    const upstream = repo.main?.upstream
    if (upstream?.behind > 0 && !onSpine.has(upstream.sha)) {
        rows.push(el('li', { class: 'commit remote-ahead' },
            el('span', { class: 'tag remote', text: upstream.name }),
            el('span', { class: 'subject muted', text: `${plural(upstream.behind, 'newer commit')} than ${repo.integrationBranch}, as of the last fetch` }),
            pullButton(repo)))
    }
    spine.forEach((commit, index) => {
        for (const lane of live.filter((candidate) => candidate.base === commit.sha).sort(newestFirst)) rows.push(laneCard(repo, lane))
        rows.push(commitRow(repo, commit, index === 0 ? 'tip' : '', index === 0 ? repo.integrationBranch : null))
        rows.push(inlineDetails(repo, commit))
    })
    if (spine.length < repo.spine.length) {
        rows.push(el('li', { class: 'older', text: `${plural(repo.spine.length - spine.length, 'older commit')} of ${repo.integrationBranch}: Show in an Editor Tab has them` }))
    }
    const older = live.filter((lane) => !onSpine.has(lane.base)).sort(newestFirst)
    // Main's line going on below what is drawn: dashed, as ISL draws it.
    if (repo.spineMore && spine.length === repo.spine.length && !older.length) rows.push(el('li', { class: 'continues', 'aria-hidden': 'true' }))
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

/** The landing order at the head of a repository, in groups, with Land next when one is ready. */
const queueOf = (repo) => {
    if (repo.error) return []
    const groups = landingGroupsOf(repo.lanes)
    if (!groups.length) return []
    const ready = groups.find((group) => group.verdict === 'land now')
    const next = ready ? repo.lanes.find((lane) => lane.name === ready.lanes[0].name) : null
    const busy = busyIn(repo.id)
    const tone = { 'land now': 'done', 'gate now': 'info', 'commit first': 'warn', 'hold the gate': 'warn', 'rebase first': 'risk', parked: 'quiet', quiet: 'quiet' }
    return [el('div', { class: 'queue' },
        el('span', { class: 'queue-title', text: 'Landing order' }),
        el('div', { class: 'queue-groups' }, groups.map((group) => el('span', { class: 'queue-group' },
            el('span', { class: 'queue-label', text: group.label }),
            group.lanes.map((item) => {
                const lane = repo.lanes.find((candidate) => candidate.name === item.name)
                const words = item.after.length ? `${item.name}, after ${item.after.join(' and ')}` : item.days ? `${item.name}, quiet for ${quietFor(item.days)}` : item.name
                const chip = el('span', { class: 'queue-item', tabindex: '0', role: 'button', title: `${words}: ${VERDICT_WORDS[lane?.queue?.verdict]?.[1] ?? group.label.toLowerCase()}` },
                    el('span', { class: `queue-dot ${tone[group.verdict] ?? 'quiet'}`, 'aria-hidden': 'true' }),
                    el('span', { class: 'queue-name', text: item.name }),
                    item.after.length ? el('span', { class: 'queue-after', text: `after ${item.after.join(', ')}` }) : null)
                chip.addEventListener('click', () => focusLane(repo.id, item.name))
                chip.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); focusLane(repo.id, item.name) } })
                return chip
            })))),
        el('span', { class: 'grow' }),
        next ? iconButton('land', `Land ${next.name}…`, {
            class: 'btn primary', disabled: busy,
            title: `Check that ${next.name} can land, then ask: it is ready, and first among any it collides with`,
            onclick: () => check(repo, next, 'land')
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
    return el('li', { 'data-key': key, tabindex: '0' },
        el('span', { class: 'tag lane-name', text: lane.name, title: portOf(lane) }),
        el('span', { class: 'muted', text: [lane.ahead ? plural(lane.ahead, 'commit') : 'nothing committed', lane.dirty ? `${lane.dirty} uncommitted` : null,
            lane.aside ? `set aside ${ago(Date.parse(lane.aside))}` : null, lane.quiet ? `quiet for ${quietFor(lane.quietDays)}` : null].filter(Boolean).join(' · ') }),
        el('span', { class: 'grow' }),
        el('div', { class: 'actions' },
            iconButton('unaside', 'Bring back', { disabled: busy, title: 'Into the landing order and the log again', onclick: () => press({ repo: repo.id, verb: 'resume', lane: lane.name }) }),
            lane.exists && !lane.operation ? iconButton('trash', 'Drop…', { class: 'btn quiet', disabled: busy, title: 'Remove its folder and keep its branch, after a check', onclick: () => check(repo, lane, 'drop') }) : null,
            gotoButton(repo, lane)),
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
    el('span', { class: 'n', text: String(count) }),
    running ? el('span', { class: 'busy', title: 'Something is running in it' }) : null)
    nav.replaceChildren(
        tab(null, 'All', repos.reduce((sum, repo) => sum + liveLanes(repo).length, 0), 'Every repository, one after another ([ and ] step through them)'),
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

const sectionFor = (repo) => {
    let kept = sections.get(repo.id)
    if (kept) return kept
    kept = {
        root: el('section', { class: 'repo' }),
        head: el('div', {}),
        queue: el('div', {}),
        log: (() => { const log = el('ol', { class: 'log' }); listenForDrops(log); return log })(),
        settled: el('div', {})
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
    const focusedKey = document.activeElement?.closest?.('[data-key]') === document.activeElement ? document.activeElement.dataset.key : null
    // A field being typed in is drawn again with what was typed (drafts) and keeps the keyboard where it was.
    const typing = document.activeElement?.dataset?.draft
    const caret = typing ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null

    const where = (current.roots?.length ? current.roots : [current.scan]).join(', ')
    $('where').textContent = where + (current.kit ? ` · lanekit ${current.kit}` : '')
    drawSwitcher()
    sayTitle()
    const pane = $('repos')
    const shown = shownRepos()
    const ids = new Set(shown.map((repo) => repo.id))
    for (const [id, kept] of sections) {
        if (!ids.has(id)) { kept.root.remove(); sections.delete(id) }
    }
    if (!current.repos.length) {
        pane.replaceChildren(el('div', { class: 'empty' },
            el('p', { class: 'empty-title', text: 'No repository here has lanes yet.' }),
            el('p', { class: 'muted', text: `LaneKit looks in ${where}: a checkout with a lane.config.json, one directly inside, or the one a lane belongs to. It appears here by itself.` }),
            el('p', {}, 'To give a repository lanes, run ', el('code', { text: 'node ~/.lanekit/bin/adopt.mjs' }), ' in it, or ask your agent to follow ',
                el('a', { href: 'https://github.com/Oerba-Labs/lanekit/blob/main/INSTALL.md', target: '_blank', rel: 'noopener noreferrer', text: 'INSTALL.md' }), '.')))
        return
    }
    const empty = $('empty')
    if (empty) empty.remove()
    shown.forEach((repo, index) => {
        const kept = sectionFor(repo)
        kept.head.replaceChildren(...headOf(repo))
        kept.queue.replaceChildren(...queueOf(repo))
        kept.log.replaceChildren(...logOf(viewOf(repo)))
        kept.settled.replaceChildren(...settledOf(repo))
        // Moved only when out of place: moving a section takes the focus out of its form.
        const there = pane.children[index]
        if (there !== kept.root) pane.insertBefore(kept.root, there ?? null)
    })
    for (const node of [...pane.children]) {
        if (![...sections.values()].some((kept) => kept.root === node)) node.remove()
    }
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
    ['j  ↓', 'the next lane'], ['k  ↑', 'the lane before'], ['Enter', host.inEditor ? 'its changes' : 'its files'],
    ['g', 'gate it'], ['l', 'land it, after a check'], ['r', 'rebase it onto main'], ['p', 'push it'],
    ...(host.inEditor ? [['o', 'go to it: the files you have open and your terminal move to it'], ['a', 'start an agent in it']] : []),
    ['c', 'commit what is uncommitted'], ['u', 'uncommit its newest commit'], ['f', 'fetch'], ['n', 'a new lane, on the one in focus or main'],
    ['[  ]', 'the repository before, or the next, All among them'], ['?', 'these keys'],
    ['Esc', 'close the details, this, or the output']
]
const keysPanel = el('div', { class: 'keys', hidden: true, role: 'dialog', 'aria-label': 'Keys' },
    el('p', { class: 'keys-title', text: 'Keys' }),
    el('dl', {}, KEYS.map(([key, what]) => [el('dt', { text: key }), el('dd', { text: what })])))
document.body.append(keysPanel)
const toggleKeys = (show = keysPanel.hidden) => { keysPanel.hidden = !show }
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
    const repo = here?.repo ?? shownRepos().find((candidate) => !candidate.error)
    if (key === 'n' && repo) {
        const from = here?.lane?.stack?.[0] ? { commit: here.lane.stack[0], lane: here.lane.name } : null
        if (from) startNaming(repo, from.commit, from.lane); else if (repo.spine?.[0]) startNaming(repo, repo.spine[0])
        return done()
    }
    if (key === 'f' && repo) { press({ repo: repo.id, verb: 'fetch' }); return done() }
    if (!here) return
    const { lane } = here
    const confirm = (verb) => { pending.set(here.key, { verb, stage: 'confirm' }); draw(true) }
    const act = {
        Enter: () => host.inEditor && (lane.kind === 'working' || lane.dirty) ? openIn('changes', { repo: repo.path, lane: lane.name }) : toggle(`${here.key}:files`),
        c: () => { if (lane.dirty && !lane.operation) select({ repo: repo.id, lane: lane.name, form: 'commit' }) },
        u: () => { if (lane.ahead > 0 && !lane.operation) uncommitLane(repo, lane) },
        g: () => confirm('gate'),
        l: () => check(repo, lane, 'land'),
        r: () => lane.behind > 0 && confirm('rebase'),
        p: () => lane.upstream?.behind > 0 ? confirm('push-force') : press({ repo: repo.id, verb: 'push', lane: lane.name }),
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
