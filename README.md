# dsh-trae-queue

A dsh profile bundle that shows **what is sitting in Trae's upstream queue** on
the Web settings page, as its own section (`Trae · 排队`, order 153 — directly
below the CLIProxyAPI status section), plus a **sidebar-foot indicator that only
appears while a request is really waiting**.

Trae answers a busy account with SSE queue events instead of tokens. The
CLIProxyAPI `trae` plugin tracks those events and publishes the snapshot through
a management endpoint; this bundle reads that endpoint over loopback and puts it
on screen. Nothing here talks to Trae directly.

## What it shows

| Seat | Source | Rendered |
|---|---|---|
| Sidebar foot (`sidebar.footer.action`) | the Host projection's `active` | one line, `⏳ 537 位 · 24 秒`, plus `· 共 2 个` when more than one request is waiting; the 56px rail collapses it to `⏳` over the number, with the whole sentence in the tooltip. **Renders nothing at all when the queue is empty.** |
| Settings section (`settings.section`) | `active` + `recent` | **排队中**: every waiting request with its nickname/variant/model, **its current position**, how long it has waited, the upstream's own `message` verbatim, and the `512–560` range plus "N 秒前上游更新". **最近结束**: the finished episodes with the best position reached, how long they waited, and how they ended. |

### The sidebar foot renders nothing when idle

There is no `空闲` placeholder and no greyed-out row. A seat that is always
present stops being a signal, and this one only has news when a request is
actually waiting — so it takes no space until then. `ok: false` from the Host is
also rendered as nothing rather than as an alarming glyph: this seat reports the
queue, it is not a health indicator.

Visual weight follows the sibling `dsh-cliproxyapi-status` foot row: mostly
typography on a transparent background, inheriting the host's tokens
(`--dsw-alias-label-primary`) so it tracks the active theme instead of pinning a
palette. The one piece of colour is the accent glyph itself.

### Durations are written the way a person says them

`24 秒`, `2 分 5 秒`, `1 小时 3 分` — never `23400ms`. One formatter covers
`queued_ms`, `updated_ms` and `waited_ms`, so the three can never drift apart in
wording. A missing number renders as `—`, never as `NaN 秒`: the first SSE event
of an episode legitimately carries no timing yet.

## Data source

```
settings section / sidebar foot (lib/client.js)
        │ fetch  api/trae/queue            (same origin, no CORS, no secret)
        ▼
GET /api/trae/queue (lib/index.js, loopback only, 5s cache)
        │
        ▼
GET http://127.0.0.1:8317/v0/management/plugins/trae/queue
    Authorization: Bearer <CPA_MGMT_KEY>
    Accept: application/json
```

The management key is read from
`~/Library/Application Support/CLIProxyAPI/keys.env` (`CPA_MGMT_KEY=…`) at
request time, exactly like `dsh-cliproxyapi-status`. It never enters the page
bundle, and it is never copied into a dsh configuration layer.

### Response fields (the frozen contract)

`active[]` — requests still queued:

| Field | Meaning |
|---|---|
| `uid`, `nickname`, `variant`, `model` | who is waiting, and for which model |
| `queue_id`, `queue_type`, `request_uuid` | the upstream's identifiers for this episode |
| `position` | **the live queue position.** Counts DOWN as Trae admits work — a smaller number is closer to being served |
| `max_position`, `min_position` | the extremes of the range Trae quoted |
| `message` | Trae's own sentence, e.g. `Too many current requests. Your queue position is 537. …` |
| `phase` | `queued` or `processing` |
| `queued_ms` | how long this request has been waiting in total |
| `updated_ms` | how long ago the upstream last moved it. Growing while `position` stands still is the signal that the queue is not moving |

`recent[]` — finished episodes:

| Field | Meaning |
|---|---|
| `uid`, `nickname`, `variant`, `model` | who was waiting |
| `max_position`, `min_position` | the best position it reached, and the worst |
| `waited_ms` | total time spent in the queue |
| `finished_at` | Unix **milliseconds** |
| `outcome` | `started` (it was admitted and answered), `error`, or `canceled` |

The Host republishes these under camelCase names (`position`, `maxPosition`,
`queuedMs`, `maxPosition`, `waitedMs`, `finishedAt`, …) and adds only
`ok` / `fetchedAt` / `baseUrl` / `now` plus a `recentShown` slice.

Two orderings are fixed by the Host rather than trusted from upstream, so every
consumer renders the same list: `active` is sorted by `position` ascending
(closest to the front first, positionless rows last), and `recent` is sorted by
`finished_at` descending.

## Configuration

Both fields default to this machine's layout, so the row config is optional:

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8317` | the CLIProxyAPI origin |
| `keysPath` | `~/Library/Application Support/CLIProxyAPI/keys.env` | file holding `CPA_MGMT_KEY`, read per request |
| `managementKey` | unset | set to bypass the file and pass a key directly |

## Failure behavior

A failing upstream is reported **inside an `ok: false` document, always with
HTTP 200** — never as an HTTP error. That is deliberate: the card has to be able
to say *which* part of the chain broke, and an HTTP status would collapse three
very different situations into one generic transport failure.

| Situation | Reported |
|---|---|
| CPA unreachable | `ok:false` naming the origin and the transport error (`… answered 404`, `ECONNREFUSED …`) |
| timeout | `ok:false`, `CLIProxyAPI did not answer within 8000 ms` |
| `keys.env` missing or without `CPA_MGMT_KEY` | `ok:false` naming the file; CPA is never contacted |
| upstream answers `ok:false` (the trae plugin could not read Trae's queue) | forwarded verbatim — this is **not** "CLIProxyAPI is down", and the two have different fixes |
| non-loopback caller | `403 {"ok":false,"error":"forbidden: loopback only"}` |

An empty `active` list is a **real answer** ("nobody is waiting"), not an error,
and it is kept distinct from `ok:false` at every layer.

## Install / re-enable

```sh
dsh plugin --profile desktop add /Users/lingsmbp/Documents/github/dsh-trae-queue
```

Or select `dsh-trae-queue` on the Web sidebar's **Plugins** page. A profile reset
rewrites the profile's `package.json` and `cordis.patch.yml`, so after a reset
the registry row is gone and this bundle has to be selected again; the package
stays installed at the path above.

## Tests

```sh
/Users/lingsmbp/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node \
  --test /Users/lingsmbp/Documents/github/dsh-trae-queue/lib/index.test.js
```

16 tests, no framework (node's built-in runner is enough for a package that
deliberately ships without a toolchain). They drive the **real route handler**
through a stubbed `globalThis.fetch` and a throwaway `keys.env`, asserting on the
JSON that actually goes out over the wire — including the four situations a naive
reading gets wrong: `ok:false` staying a 200, a positionless waiter being kept
with `position` absent rather than dropped or coerced to `0`, an empty `active`
being a real answer, and the loopback guard refusing non-local callers.

## Conventions reused from `dsh-cliproxyapi-status`

Every slot name, register option and wiring idiom below was copied from the
working sibling plugin rather than invented; the shapes were then re-checked
against the dsh source (`packages/client/ui-sidebar/src/client/contract/slots.ts`,
`packages/client/ui-settings/src/client/contract/slots.ts`,
`packages/host/webserver/src/index.ts`, `packages/util/package-manifest/src/types.ts`).

| Thing | Value | Where it comes from |
|---|---|---|
| Settings slot | `settings.section` (`kind: 'list'`, `scope: 'root'`) | declared by `client-ui-settings-general`; owner option `close` unused here |
| Register options | `{ name, id, order, label }` with `label` a **thunk** | `label` is re-read on every projection, which is what keeps a localized nav row fresh without re-registering |
| Section order | `153` | the sibling plugin claims `152`; shipped sections are `0/10/15/20/25` |
| Footer slot | `sidebar.footer.action` (`kind: 'list'`, `scope: 'root'`) | declared by `client-ui-sidebar`; owner passes exactly one prop, `wide: boolean`, which is the only thing deciding rail vs wide |
| Footer order | `41` | the sibling plugin claims `40` |
| Cordis `inject` | `['slots']` | the only client service either half needs |
| Host `inject` | `['webServer']` | `ctx.webServer.register({ kind: 'exact', path, handler })` returns the disposer, handed to `ctx.effect(() => dispose, …)` |
| Host exports | `name`, `inject`, `apply` | the loader row shape |
| Client exports | `apply`, `inject` on `module.exports` | plus the `window.__ModuleLoader__.load({ id, factory })` lazy-CJS artifact |
| `package.json` `dsh.client` | `platform: "web"`, `inject: ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-settings']` | copied **verbatim** from the sibling plugin. `dsh.client.inject` is documented as *informational package-name dependencies, not Cordis service injection*, so this is parity rather than a runtime requirement — which is why `@deepseek-ai/dsh-client-ui-sidebar` (the declarer of `sidebar.footer.action`) is deliberately **not** added: the working sibling registers on the same slot without it, and diverging here would be a silent behaviour change |
| Module requests | `react` only | the client bundle-purity gate rejects anything outside the default externals that the package did not declare |
| Key handling | `managementKey(settings)`, config wins, else `keys.env` per request | copied from the sibling's `lib/index.js` |
| `collect()` shape | `{ ok, fetchedAt, baseUrl, error? }` on failure | copied from the sibling: the failure travels in the body, not in the status code |
| Route guard | `LOOPBACK = {127.0.0.1, ::1, ::ffff:127.0.0.1}` → `403` | copied from the sibling |
| Cache | 5 s coalescing, 8 s upstream timeout | same constants as the sibling |

One deliberate divergence: copy is **Chinese-only**. The sibling carries an `en`
table chosen by `document.documentElement.lang`; this seat is read by one
operator, and a second table would be a promise this file does not keep.

Polling is every **5 seconds**, matching the Host's 5-second cache — polling
faster would only re-read the same document.
