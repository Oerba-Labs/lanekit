/**
 * `lane web`: a page of every lane, and the buttons that make, gate, land and sweep them.
 *
 *     ./<slug> lane web                       this repository, on 127.0.0.1:13338
 *     node <lanekit>/dev/lane.mjs web --scan /work --port 13338 --ssh-host orpheus.coder \
 *         --browser-editor '../code/?folder='
 *
 * WHAT IT IS FOR. `lane list` and `lane queue` answer in a terminal for one repository at a
 * time; this answers for every repository in a workspace at once, on one page, and keeps
 * answering. Each lane is drawn above the commit of the integration branch it forked from,
 * with its own commits, its port, its gate and the queue's verdict, the way a smartlog
 * draws a stack.
 *
 * WHAT IT CARRIES. The service in lib/service.mjs, over HTTP: every button, every rule and
 * every refusal is there, shared with the editor's extension (vscode/), which carries the
 * same page by message instead. What is left here is the server: routes, headers, and a
 * press refused unless it comes from the page itself.
 *
 * WHAT IT WILL NOT DO. Listen anywhere but the loopback: the page is reached through
 * Coder's proxy, which admits only the workspace's owner, or through a forward.
 *
 * No dependency: `node:http` and the files in web/.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { PACKAGE_ROOT } from '../lib/config.mjs'
import { createService } from '../lib/service.mjs'
import { findRepos } from '../lib/state.mjs'

const WEB = path.join(PACKAGE_ROOT, 'web')

const DEFAULT_PORT = 13338
const BODY_CAP = 16 * 1024

const FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/lanes.css': ['lanes.css', 'text/css; charset=utf-8'],
    '/lanes.js': ['lanes.js', 'text/javascript; charset=utf-8']
}

// ---------------------------------------------------------------------------
// the server
// ---------------------------------------------------------------------------

const send = (response, status, body, type = 'application/json; charset=utf-8') => {
    response.writeHead(status, {
        'Content-Type': type,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        // The page's own files and its own API, nothing else: no inline script, no other origin.
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
    })
    response.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
}

const readBody = (request) => new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
        size += chunk.length
        if (size > BODY_CAP) { reject(new Error('too large')); request.destroy() } else chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
})

/**
 * The route a request is for, from the END of its path.
 *
 * Coder's proxy may hand the path on with its `/@owner/workspace/apps/lanes` prefix or
 * without it, and a forward hands it on bare; matching the tail serves all three, and the
 * page only ever asks for addresses relative to where it was served.
 */
const routeOf = (pathname) => {
    if (pathname.endsWith('/healthz')) return { name: 'health' }
    if (pathname.endsWith('/api/state')) return { name: 'state' }
    if (pathname.endsWith('/api/jobs')) return { name: 'jobs' }
    const job = /\/api\/jobs\/([a-z0-9-]+)$/.exec(pathname)
    if (job) return { name: 'job', id: job[1] }
    for (const [tail, file] of Object.entries(FILES)) {
        if (tail !== '/' && pathname.endsWith(tail)) return { name: 'file', file }
    }
    if (pathname.endsWith('/')) return { name: 'file', file: FILES['/'] }
    return { name: 'missing' }
}

export const startServer = ({ scan, port = DEFAULT_PORT, sshHost = null, browserEditor = null }) => {
    const service = createService({ dirs: [scan] })

    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, 'http://lanes.invalid')
        const route = routeOf(url.pathname)
        try {
            if (request.method === 'GET' && route.name === 'health') return send(response, 200, 'ok\n', 'text/plain; charset=utf-8')
            if (request.method === 'GET' && route.name === 'file') {
                const [file, type] = route.file
                return send(response, 200, fs.readFileSync(path.join(WEB, file)), type)
            }
            if (request.method === 'GET' && route.name === 'state') {
                return send(response, 200, { ...await service.state(), scan, open: { sshHost, browserEditor } })
            }
            if (request.method === 'GET' && route.name === 'job') {
                const job = service.job(route.id, url.searchParams.get('from'))
                return job ? send(response, 200, job) : send(response, 404, { error: 'no such job' })
            }
            if (request.method === 'POST' && route.name === 'jobs') {
                // A header a form cannot set and a type a form cannot send: another page cannot
                // press these buttons by posting at this address.
                if (request.headers['x-lanes'] !== '1' || !String(request.headers['content-type']).startsWith('application/json')) {
                    return send(response, 403, { error: 'this address takes presses from the lanes page only' })
                }
                let body
                try {
                    body = JSON.parse(await readBody(request))
                } catch {
                    return send(response, 400, { error: 'the request was not JSON this page understands' })
                }
                const pressed = await service.press(body ?? {})
                return send(response, pressed.status, pressed.body)
            }
            return send(response, route.name === 'missing' ? 404 : 405, { error: 'not here' })
        } catch (error) {
            return send(response, 500, { error: error.message })
        }
    })

    return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, service }))
    })
}

const usage = () => {
    console.error('\n  usage: lane web [--scan <dir>] [--port <port>] [--ssh-host <host>] [--browser-editor <url prefix>]\n')
    process.exit(2)
}

export const main = async (argv) => {
    const value = (flag) => {
        if (!argv.includes(flag)) return undefined
        const given = argv[argv.indexOf(flag) + 1]
        if (given === undefined || given.startsWith('--')) usage()
        return given
    }
    const port = value('--port') === undefined ? DEFAULT_PORT : Number(value('--port'))
    if (!Number.isInteger(port) || port < 0 || port > 65535) usage()
    const scan = path.resolve(value('--scan') ?? process.cwd())
    if (!findRepos(scan).length) {
        console.error(`\n  no repository with lanes in ${scan}, or directly under it; the page will say so until one appears\n`)
    }
    try {
        const started = await startServer({ scan, port, sshHost: value('--ssh-host') ?? null, browserEditor: value('--browser-editor') ?? null })
        console.log(`\n  lanes of ${scan} on http://127.0.0.1:${started.port}/\n`)
    } catch (error) {
        console.error(`\n  could not listen on 127.0.0.1:${port}: ${error.message}\n`)
        process.exit(1)
    }
}
