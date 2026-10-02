/**
 * read.mjs in a worker thread: one message in, `{ dirs, forget, depths }`, one out, the repositories or the
 * error. Kept alive between asks, so the queue's cached plan and GitHub's answers, which
 * live in their modules, are kept too.
 */

import { parentPort } from 'node:worker_threads'

import { readRepos } from './read.mjs'

parentPort.on('message', ({ id, dirs, forget, depths }) => {
    try {
        parentPort.postMessage({ id, repos: readRepos(dirs, forget ?? [], depths ?? {}) })
    } catch (error) {
        parentPort.postMessage({ id, error: error.message })
    }
})
