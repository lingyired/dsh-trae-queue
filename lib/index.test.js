/**
 * dsh-trae-queue — Host-half regression tests.
 *
 * Run with:  node --test lib/index.test.js
 *
 * These drive the REAL route handler the browser calls, through a stubbed
 * `globalThis.fetch` and a throwaway `keys.env`, rather than poking at helpers.
 * The contract this file exists to protect is the response the page renders, so
 * the assertions are made on the JSON that actually goes out over the wire.
 *
 * Four situations matter, and three of them are the ones a naive reading gets
 * wrong:
 *
 *  - a normal snapshot is projected field-for-field;
 *  - `ok: false` is forwarded as a 200 with `ok: false`, never as an HTTP error
 *    (the card has to be able to say WHICH part of CPA is unreachable);
 *  - a row with no `position` yet is kept, with `position` absent — the first
 *    SSE event of an episode has no position, and dropping the row would hide a
 *    real waiter while coercing it to 0 would claim it is next;
 *  - an empty `active` is a real answer ("nobody is waiting"), not an error.
 *
 * No test framework is added: node's built-in test runner is enough for a
 * package that deliberately ships without a toolchain.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from './index.js'

const ROUTE_PATH = '/api/trae/queue'
const UPSTREAM = 'http://127.0.0.1:8317/v0/management/plugins/trae/queue'

/** A still-queued request, as the trae plugin publishes it. */
function active(overrides = {}) {
  return {
    uid: '4053245665740660',
    nickname: 'lingyirEd',
    variant: 'cn',
    model: 'deepseek-v4.1-flash',
    queue_id: '5zyI415F...',
    queue_type: 1,
    request_uuid: '16ddbd82-69fa-4061-95fd-b5f8e2859d14',
    position: 537,
    max_position: 560,
    min_position: 512,
    message: 'Too many current requests. Your queue position is 537. Please wait for a while.',
    phase: 'queued',
    queued_ms: 23400,
    updated_ms: 1000,
    ...overrides,
  }
}

/** A finished queue episode. */
function recent(overrides = {}) {
  return {
    uid: '4053245665740660',
    nickname: 'lingyirEd',
    variant: 'cn',
    model: 'deepseek-v4.1-flash',
    max_position: 560,
    min_position: 512,
    waited_ms: 125000,
    finished_at: 1790673900000,
    outcome: 'started',
    ...overrides,
  }
}

/** A full upstream document with the frozen field names. */
function snapshot(overrides = {}) {
  return {
    ok: true,
    now: '2026-09-29T17:40:00+08:00',
    active: [active()],
    recent: [recent()],
    ...overrides,
  }
}

/**
 * Drive the route with a stubbed management API.
 *
 * @param payload - what the queue endpoint answers.
 * @param options.status - when set, the stub answers this non-2xx status instead.
 * @param options.transport - `'throw'` makes the stub reject, like a dead socket.
 * @param options.remoteAddress - the caller's socket address.
 * @param options.config - an explicit row config (defaults to the temp key file).
 * @param options.calls - when 1, the handler is called this many times (the
 *   second call exercises the cache); the management call count comes back too.
 * @returns `{ status, document, requests }`.
 */
async function callRoute(payload, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'trae-queue-'))
  const keyFile = join(dir, 'keys.env')
  writeFileSync(keyFile, 'CPA_MGMT_KEY=test-key\n')

  let handler
  apply(
    { webServer: { register: (route) => { handler = route.handler; return () => {} } }, effect: () => {} },
    options.config ?? { keysPath: keyFile },
  )

  const requests = []
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init })
    if (options.transport === 'throw') throw new Error('connect ECONNREFUSED 127.0.0.1:8317')
    if (options.status !== undefined) return { ok: false, status: options.status, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => payload }
  }

  try {
    const times = typeof options.calls === 'number' ? options.calls : 1
    let status
    let document
    for (let i = 0; i < times; i += 1) {
      status = undefined
      document = undefined
      await handler(
        { socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' }, url: ROUTE_PATH },
        { writeHead: (code) => { status = code }, end: (text) => { document = JSON.parse(text) } },
      )
    }
    return { status, document, requests }
  } finally {
    globalThis.fetch = original
  }
}

// ---------------------------------------------------------------------------
// A normal snapshot
// ---------------------------------------------------------------------------

test('a normal snapshot is projected field-for-field', async () => {
  const { status, document } = await callRoute(snapshot())

  assert.equal(status, 200)
  assert.equal(document.ok, true)
  assert.equal(document.baseUrl, 'http://127.0.0.1:8317')
  assert.equal(document.now, '2026-09-29T17:40:00+08:00')
  assert.equal(typeof document.fetchedAt, 'string')

  assert.equal(document.active.length, 1)
  const row = document.active[0]
  assert.equal(row.nickname, 'lingyirEd')
  assert.equal(row.model, 'deepseek-v4.1-flash')
  assert.equal(row.phase, 'queued')
  // The live position and both timings are the whole point of the panel.
  assert.equal(row.position, 537)
  assert.equal(row.queuedMs, 23400)
  assert.equal(row.updatedMs, 1000)
  assert.equal(row.minPosition, 512)
  assert.equal(row.maxPosition, 560)
  // The upstream sentence is carried verbatim: it is the only place the exact
  // wording appears and an operator compares it with the Trae log.
  assert.equal(row.message, 'Too many current requests. Your queue position is 537. Please wait for a while.')

  assert.equal(document.recent.length, 1)
  assert.equal(document.recent[0].outcome, 'started')
  assert.equal(document.recent[0].waitedMs, 125000)
  assert.equal(document.recent[0].finishedAt, 1790673900000)
})

test('the request carries the management key and asks for JSON', async () => {
  const { requests } = await callRoute(snapshot())
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, UPSTREAM)
  assert.equal(requests[0].init.headers.authorization, 'Bearer test-key')
  assert.equal(requests[0].init.headers.accept, 'application/json')
})

test('the projection is cached for the 5-second window', async () => {
  const { requests, document } = await callRoute(snapshot(), { calls: 2 })
  assert.equal(requests.length, 1, 'a second page hit inside 5s must not re-read CPA')
  assert.equal(document.ok, true)
})

test('waiting rows are ordered by position, closest to the front first', async () => {
  const { document } = await callRoute(snapshot({
    active: [active({ position: 560 }), active({ position: 512 }), active({ position: 537 })],
  }))
  assert.deepEqual(document.active.map((row) => row.position), [512, 537, 560])
})

test('finished episodes are ordered newest first, whatever the upstream order was', async () => {
  const { document } = await callRoute(snapshot({
    recent: [recent({ finished_at: 1000 }), recent({ finished_at: 3000 }), recent({ finished_at: 2000 })],
  }))
  assert.deepEqual(document.recent.map((row) => row.finishedAt), [3000, 2000, 1000])
})

// ---------------------------------------------------------------------------
// The three empty / degraded answers that must not be confused
// ---------------------------------------------------------------------------

test('ok:false is forwarded as a 200 document, never as an HTTP error', async () => {
  // The trae plugin could not read Trae's queue. That is NOT "CLIProxyAPI is
  // down", and the card has to be able to tell the two apart — so the failure
  // travels inside a normal 200 body rather than as a status code the fetch
  // layer would collapse into a generic transport error.
  const { status, document } = await callRoute({ ok: false, error: 'upstream trae queue unreadable: EOF' })
  assert.equal(status, 200, 'ok:false must still be a 200 so the card can read the reason')
  assert.equal(document.ok, false)
  assert.equal(document.error, 'upstream trae queue unreadable: EOF')
  assert.equal(document.baseUrl, 'http://127.0.0.1:8317')
  assert.equal(typeof document.fetchedAt, 'string')
})

test('ok:false with no error text still names itself', async () => {
  const { document } = await callRoute({ ok: false })
  assert.equal(document.ok, false)
  assert.match(document.error, /reported ok:false/)
})

test('a row with no position yet is kept, with position absent', async () => {
  // The first SSE event of an episode carries only the queue id. Dropping the
  // row would hide a real waiter; coercing it to 0 would claim it is next.
  const withoutPosition = active({ position: undefined, min_position: undefined, max_position: undefined })
  delete withoutPosition.position
  delete withoutPosition.min_position
  delete withoutPosition.max_position

  const { document } = await callRoute(snapshot({ active: [withoutPosition] }))
  assert.equal(document.ok, true)
  assert.equal(document.active.length, 1, 'a positionless waiter is still a waiter')
  assert.equal(document.active[0].position, undefined)
  assert.equal(document.active[0].maxPosition, undefined)
  assert.equal(document.active[0].uid, '4053245665740660')
})

test('positionless rows sort last and never displace a known position', async () => {
  const unknown = active({ uid: 'unknown-one' })
  // `undefined` would be elided here; only a genuine `delete` reproduces the
  // shape the first SSE event of an episode actually publishes.
  delete unknown.position
  const { document } = await callRoute(snapshot({ active: [unknown, active({ position: 537 })] }))
  // The unknown one must NOT be promoted to the front: "no position yet" is not
  // evidence of being next, and the sidebar foot renders the first row as THE
  // position — a positionless row there would show a countdown with no number.
  assert.equal(document.active[0].position, 537, 'the known position must stay at the front')
  assert.equal(document.active[1].position, undefined)
  assert.equal(document.active[1].uid, 'unknown-one')
})

test('an empty active list is a real answer, not an error', async () => {
  const { status, document } = await callRoute(snapshot({ active: [] }))
  assert.equal(status, 200)
  assert.equal(document.ok, true)
  assert.deepEqual(document.active, [])
  // The history survives, so an idle queue still shows what just happened.
  assert.equal(document.recent.length, 1)
})

test('missing active/recent arrays degrade to empty lists, not to a throw', async () => {
  const { document } = await callRoute({ ok: true, now: '2026-09-29T17:40:00+08:00' })
  assert.equal(document.ok, true)
  assert.deepEqual(document.active, [])
  assert.deepEqual(document.recent, [])
})

// ---------------------------------------------------------------------------
// Failure behavior
// ---------------------------------------------------------------------------

test('a non-loopback caller is refused with 403', async () => {
  const { status, document } = await callRoute(snapshot(), { remoteAddress: '192.168.1.20' })
  assert.equal(status, 403)
  assert.equal(document.ok, false)
  assert.match(document.error, /loopback only/)
})

test('an unreachable CPA is reported inside an ok:false document', async () => {
  const { status, document } = await callRoute(snapshot(), { transport: 'throw' })
  assert.equal(status, 200)
  assert.equal(document.ok, false)
  assert.match(document.error, /ECONNREFUSED/)
})

test('a non-2xx management answer is reported inside an ok:false document', async () => {
  const { status, document } = await callRoute(undefined, { status: 404 })
  assert.equal(status, 200)
  assert.equal(document.ok, false)
  // The route names the endpoint, so a plugin that is not mounted yet reads as
  // "that endpoint 404s" rather than as a generic failure.
  assert.match(document.error, /\/plugins\/trae\/queue answered 404/)
})

test('a missing keys file is named, and CPA is never contacted', async () => {
  const { document, requests } = await callRoute(snapshot(), { config: { keysPath: '/nonexistent/keys.env' } })
  assert.equal(document.ok, false)
  assert.match(document.error, /cannot read \/nonexistent\/keys\.env/)
  assert.equal(requests.length, 0, 'no key means no upstream call')
})

test('a config-supplied management key wins over the keys file', async () => {
  const { requests, document } = await callRoute(snapshot(), {
    config: { keysPath: '/nonexistent/keys.env', managementKey: 'inline-key' },
  })
  assert.equal(document.ok, true)
  assert.equal(requests[0].init.headers.authorization, 'Bearer inline-key')
})
