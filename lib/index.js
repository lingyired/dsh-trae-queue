/**
 * trae-queue — Host half.
 *
 * Surfaces the one thing an operator cannot see from inside dsh: what is
 * currently stuck in Trae's **upstream queue**. Trae answers a busy account with
 * SSE queue events instead of tokens, CLIProxyAPI's trae plugin tracks them, and
 * this package republishes the plain snapshot the Web page renders.
 *
 * The projection is deliberately two lists and nothing else:
 *
 *  - `active` — requests still queued right now. `position` is the live queue
 *    position (it counts DOWN as Trae admits work), `queuedMs` is how long the
 *    request has been waiting in total, and `updatedMs` is how long ago the
 *    upstream last moved it. A request whose `updatedMs` keeps growing while
 *    `position` stands still is the signal that the queue is not moving.
 *  - `recent` — the queue episodes that already ended, newest first, each with
 *    the best position it reached and how it finished (`started` / `error` /
 *    `canceled`).
 *
 * The browser cannot read CPA directly: its management API is another origin
 * (no CORS) and its key is a secret that must not reach the page bundle. So the
 * Host reads CPA over loopback and republishes a secret-free projection at
 * `/api/trae/queue`, which the Client half polls from its settings section and
 * its sidebar-foot indicator.
 *
 * A failing upstream is reported inside an `ok: false` document rather than as
 * an HTTP error, so the card can name what is unreachable instead of showing a
 * bare transport failure.
 *
 * @module dsh-trae-queue
 */
import { readFileSync } from 'node:fs'

/** Loader row name; also the label used in effect diagnostics. */
export const name = 'trae-queue'

/** The Host serves the projection over the browser carrier. */
export const inject = ['webServer']

const ROUTE_PATH = '/api/trae/queue'
/** The trae plugin's management endpoint below `/v0/management`. */
const QUEUE_PATH = '/plugins/trae/queue'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8317'
const DEFAULT_KEYS_PATH = '/Users/lingsmbp/Library/Application Support/CLIProxyAPI/keys.env'
const REQUEST_TIMEOUT_MS = 8000
/** Coalescing window: the page polls faster than Trae moves a queue anyway. */
const CACHE_MS = 5000
/** How many finished episodes the card is allowed to render. */
export const RECENT_LIMIT = 5

/** Addresses the DSH page itself uses; every other caller is refused. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Resolve the deployment-varying settings from the row config.
 * @param config - the row's `config` object, possibly empty.
 * @returns the resolved settings.
 */
function resolveSettings(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  return {
    baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl !== '' ? raw.baseUrl.replace(/\/+$/, '') : DEFAULT_BASE_URL,
    keysPath: typeof raw.keysPath === 'string' && raw.keysPath !== '' ? raw.keysPath : DEFAULT_KEYS_PATH,
    managementKey: typeof raw.managementKey === 'string' && raw.managementKey !== '' ? raw.managementKey : undefined,
  }
}

/**
 * Read CPA's management key. Config wins; otherwise the plaintext copy CPA's own
 * control helpers keep beside the config (`keys.env`) is read at request time, so
 * no secret is duplicated into a dsh configuration layer.
 * @param settings - resolved plugin settings.
 * @returns the management key.
 * @throws when neither source supplies one.
 */
function managementKey(settings) {
  if (settings.managementKey !== undefined) return settings.managementKey
  let text
  try {
    text = readFileSync(settings.keysPath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${settings.keysPath}: ${error.message}`)
  }
  const match = /^\s*CPA_MGMT_KEY\s*=\s*"?([^"\n]+)"?/m.exec(text)
  if (match === null) throw new Error(`no CPA_MGMT_KEY in ${settings.keysPath}`)
  return match[1].trim()
}

/**
 * Read one CPA management endpoint.
 * @param baseUrl - CPA origin.
 * @param path - management path below `/v0/management`.
 * @param key - management key.
 * @returns the parsed JSON body.
 * @throws when the transport fails or answers a non-2xx status.
 */
async function managementGet(baseUrl, path, key) {
  const response = await fetch(`${baseUrl}/v0/management${path}`, {
    headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${path} answered ${response.status}`)
  return await response.json()
}

/** A finite number, or undefined — so a missing field never renders as NaN. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** A non-empty string, or undefined. */
function str(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The label a row falls back to when Trae gave no nickname for the account.
 * Never empty: a queue row with no name at all still has to be addressable.
 */
function accountLabel(row) {
  return str(row.nickname) ?? str(row.uid) ?? '未知账号'
}

/**
 * Project one still-queued request into the fields the card renders.
 *
 * `position` is passed through as `undefined` when the upstream has not sent one
 * yet — the first SSE event of an episode carries only the queue id, so a row
 * legitimately exists before it has a position. Dropping the row (or coercing
 * the field to 0) would either hide a real waiter or claim it is about to be
 * served.
 */
function readActive(row) {
  return {
    uid: str(row.uid),
    nickname: accountLabel(row),
    variant: str(row.variant),
    model: str(row.model),
    queueId: str(row.queue_id),
    queueType: num(row.queue_type),
    requestUuid: str(row.request_uuid),
    position: num(row.position),
    maxPosition: num(row.max_position),
    minPosition: num(row.min_position),
    message: str(row.message),
    phase: str(row.phase),
    queuedMs: num(row.queued_ms),
    updatedMs: num(row.updated_ms),
  }
}

/**
 * Project one finished queue episode into the fields the card renders. Only the
 * extremes are kept: the best position reached is the interesting number, and
 * the live per-tick positions of an episode that is over are noise.
 */
function readRecent(row) {
  return {
    uid: str(row.uid),
    nickname: accountLabel(row),
    variant: str(row.variant),
    model: str(row.model),
    maxPosition: num(row.max_position),
    minPosition: num(row.min_position),
    waitedMs: num(row.waited_ms),
    finishedAt: num(row.finished_at),
    outcome: str(row.outcome),
  }
}

/**
 * Waiting rows, closest-to-the-front first. Trae counts down as it admits work,
 * so a SMALLER position is closer to being served. Rows with no position yet go
 * last rather than first: an unknown position is not evidence of being next, and
 * a stable sort keeps the upstream's own order among equals.
 */
function byPosition(a, b) {
  const left = a.position === undefined ? Number.POSITIVE_INFINITY : a.position
  const right = b.position === undefined ? Number.POSITIVE_INFINITY : b.position
  return left - right
}

/**
 * Finished episodes, newest first. The upstream order is not part of the frozen
 * contract, so the Host fixes it here and every consumer renders the same list.
 */
function byFinishedAt(a, b) {
  const left = a.finishedAt === undefined ? Number.NEGATIVE_INFINITY : a.finishedAt
  const right = b.finishedAt === undefined ? Number.NEGATIVE_INFINITY : b.finishedAt
  return right - left
}

/**
 * Collect the projection. A failing upstream is reported inside an `ok: false`
 * document rather than as an HTTP error, so the card can name which part of CPA
 * is unreachable.
 *
 * The upstream's own `ok: false` (the trae plugin could not read Trae's queue)
 * is forwarded verbatim plus the local `fetchedAt` / `baseUrl`, so the card says
 * "the plugin could not read the queue" rather than "CLIProxyAPI is down" —
 * those are different problems with different fixes.
 *
 * @param settings - resolved plugin settings.
 * @returns the JSON document the route answers with.
 */
async function collect(settings) {
  const fetchedAt = new Date().toISOString()
  let key
  try {
    key = managementKey(settings)
  } catch (error) {
    return { ok: false, fetchedAt, baseUrl: settings.baseUrl, error: error.message }
  }
  try {
    const body = await managementGet(settings.baseUrl, QUEUE_PATH, key)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, fetchedAt, baseUrl: settings.baseUrl, error: `${QUEUE_PATH} did not answer a JSON object` }
    }
    // The trae plugin reports "queue unreadable" in-band. Pass it through
    // unchanged instead of inventing an empty queue, which would read as
    // "nobody is waiting" — the opposite of what the plugin just said.
    if (body.ok !== true) {
      return {
        ok: false,
        fetchedAt,
        baseUrl: settings.baseUrl,
        error: str(body.error) ?? `${QUEUE_PATH} reported ok:false without an error`,
      }
    }
    const active = Array.isArray(body.active) ? body.active.map(readActive).sort(byPosition) : []
    const recent = Array.isArray(body.recent) ? body.recent.map(readRecent).sort(byFinishedAt) : []
    return {
      ok: true,
      fetchedAt,
      baseUrl: settings.baseUrl,
      // Trae's own wall clock, forwarded so the card can show the time the
      // snapshot describes rather than the browser's.
      now: str(body.now),
      active,
      recent,
      // Sliced by the Host as well as the Client so a page that forgets to
      // limit still cannot try to render ten thousand finished episodes.
      recentTotal: recent.length,
      recentShown: recent.slice(0, RECENT_LIMIT),
    }
  } catch (error) {
    return {
      ok: false,
      fetchedAt,
      baseUrl: settings.baseUrl,
      error: error.name === 'TimeoutError'
        ? `CLIProxyAPI did not answer within ${REQUEST_TIMEOUT_MS} ms`
        : error.message,
    }
  }
}

/**
 * Register the loopback-guarded projection route.
 * @param ctx - the plugin context.
 * @param config - the row's `config` object.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  let cache = { at: 0, document: undefined }
  const route = {
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      const address = req.socket === null || req.socket === undefined ? undefined : req.socket.remoteAddress
      if (typeof address !== 'string' || !LOOPBACK.has(address)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ ok: false, error: 'forbidden: loopback only' }))
        return
      }
      const now = Date.now()
      if (cache.document === undefined || now - cache.at > CACHE_MS) {
        cache = { at: now, document: await collect(settings) }
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(cache.document))
    },
  }
  const dispose = ctx.webServer.register(route)
  ctx.effect(() => dispose, `${name}: ${ROUTE_PATH}`)
}
