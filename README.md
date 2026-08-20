# Lit & More Status Board — backend, persistence, history and MCP

Backend infrastructure for the existing Lit & More status board. The board UI is
not part of this repo and is not redesigned by it: this provides the API, the
database, version history, and an MCP server so both a human in a browser and a
Claude/Cowork agent can read and write the same board safely.

```
Browser ──► REST API ──┐
                       ├──► boardService ──► Postgres (board + board_history)
Claude/Cowork ──► MCP ─┘
```

There is exactly one implementation of board logic ([src/board/service.ts](src/board/service.ts)).
REST and MCP are thin transports over it, so the browser and the automation
cannot behave differently.

## Live

| | |
| --- | --- |
| **Board** | https://status-board-eight.vercel.app/ |
| **API** | `GET`/`PUT` https://status-board-eight.vercel.app/api/board |
| **MCP** | `POST` https://status-board-eight.vercel.app/api/mcp |
| **Health** | https://status-board-eight.vercel.app/api/health |
| **Repo** | https://github.com/Georgekiama/status-board |
| **Database** | Neon PostgreSQL, seeded with the real board (4 areas, 18 projects) |

Everything under `/api/` except `/api/health` requires a credential — either the
static `API_TOKEN` or an OAuth access token. The board picks the static token up
automatically from `/config.js`. Claude/Cowork connectors use OAuth; see
[Connecting Claude or Cowork](#connecting-claude-or-cowork).

Custom domain (e.g. `status.litnmore.com`) is not attached yet — add it in the
Vercel project's domain settings and every path above works unchanged.

---

## Quick start

```bash
npm install
cp .env.example .env                              # then set DATABASE_URL
npm run db:migrate
npm run db:seed -- --file seed/initial-board.json  # the board's own starting data
npm run dev                                       # http://localhost:3000
npm test
```

With no Postgres to hand, `DATABASE_URL=pglite://.pglite/statusboard` runs a
real Postgres compiled to WASM against a local directory — no server, no Docker.

[seed/initial-board.json](seed/initial-board.json) is the `seedData` object
extracted verbatim from `status-board.html` (4 areas, 18 projects). Seeding with
it means the first person to open the hosted board sees the real content rather
than an empty page.

---

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | yes | Postgres connection string. In production, the Neon **pooled** URL. |
| `ALLOWED_ORIGINS` | no | Comma-separated browser origins allowed to call the API. Leave **empty** when the frontend is served from the same origin (the recommended setup). Never a wildcard. |
| `API_TOKEN` | recommended | When set, every `/api/board*` and `/api/mcp` request must present a credential. `/api/health` stays open so uptime checks keep working. Unset means the API is open. See [Access control](#access-control). |
| `BOARD_PASSWORD` | required for connectors | Shared password for the OAuth sign-in page. Without it `/oauth/authorize` returns 503 and no connector can be authorized. |
| `PUBLIC_BASE_URL` | no | Overrides the base URL used in OAuth metadata. Normally derived from the request; only needed behind a proxy that rewrites `Host`. |
| `PORT` | no | Local dev port. Ignored on Vercel. |
| `TEST_DATABASE_URL` | no | Where `npm test` runs. Defaults to in-memory PGlite; `DATABASE_URL` is deliberately ignored so tests can never touch production. |
| `SKIP_MIGRATIONS` | no | Set to `1` to stop the server and stdio MCP from migrating on boot. |
| `BOARD_API_ENDPOINT` | no | Override the API URL the browser calls. Only needed if the board is hosted on a different origin than the API. |

Credentials stay server-side. Nothing in `public/` ever sees the database, and
the browser only ever talks to `/api/*`.

`.env` is loaded automatically by every `npm run` script and is gitignored.

---

## Access control

Two credential types are accepted, both resolved by one function
([src/oauth/authenticate.ts](src/oauth/authenticate.ts)) so REST and MCP cannot
drift apart:

| Credential | Used by | Notes |
| --- | --- | --- |
| Static `API_TOKEN` | the board page, the CLI check scripts | One shared secret. Delivered to the browser via `/config.js`. |
| OAuth access token | Claude/Cowork connectors | Per-client, expiring, revocable. See [Connecting Claude or Cowork](#connecting-claude-or-cowork). |

`/api/health` is deliberately exempt from both, so uptime checks keep working.
The OAuth endpoints are exempt too — a client cannot present a credential until
it has been through the flow that issues one.

A credential is required only when `API_TOKEN` is set. That keeps local
development and the test suite open by default while production stays closed.

The board runs in a browser, so it needs that token client-side. It is **not**
committed: `scripts/write-config.ts` writes `public/config.js` from the
environment during the Vercel build, and `public/config.js` is gitignored. Local
development skips the file entirely — the Node server serves `/config.js`
straight from the environment, so there is nothing to keep in sync.

```
<script src="/config.js">     window.BOARD_API_OPTIONS = { token: "…" }
<script src="/board-api.js">  reads those options, sends the bearer token
```

### What this does and does not protect

It stops drive-by access: a scanner or a stranger with the bare API URL gets 401,
and the MCP endpoint cannot be driven by an anonymous client.

It does **not** protect the board from anyone who can load the page, because
`/config.js` is served to the browser and is therefore readable by any visitor.
That is inherent to putting a credential in a browser, not a flaw in the wiring.
If the board needs to be genuinely private, put the deployment behind Vercel's
access controls or an SSO proxy and give the MCP connector a bypass token — see
[Known v1 limitations](#known-v1-limitations).

### Rotating the token

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
```

Put the new value in `API_TOKEN` in the Vercel project and redeploy (the build
regenerates `config.js`), then update the MCP connector and any local `.env`.
`config.js` is served `no-store`, so no browser keeps serving an old token.

---

## Connecting Claude or Cowork

Claude custom connectors cannot use a static bearer token. On a `401` they follow
the MCP authorization spec: fetch discovery metadata, register themselves
dynamically, and run an authorization-code exchange. A plain `Bearer` challenge
leaves them nowhere to go, which is why adding the connector originally failed
with *"Couldn't register with Status Board's sign-in service."*

So this deployment is also a small OAuth 2.1 authorization server.

### Adding the connector

1. Make sure `BOARD_PASSWORD` is set in the Vercel project. Without it the
   sign-in page returns 503 and authorization cannot be granted.
2. In Claude, add a custom connector with the MCP URL:
   `https://status-board-eight.vercel.app/api/mcp`
3. Leave the OAuth Client ID and Secret fields **empty** — the connector
   registers itself automatically.
4. Claude opens a sign-in page. Enter the board password. That is the only
   moment a human is involved.
5. The connector is now authorized and `get_board` / `update_board` are available.

### What it implements

| Endpoint | Purpose |
| --- | --- |
| `/.well-known/oauth-protected-resource` | RFC 9728 — names the authorization server guarding `/api/mcp` |
| `/.well-known/oauth-authorization-server` | RFC 8414 — endpoints and capabilities |
| `POST /oauth/register` | RFC 7591 dynamic client registration |
| `GET`/`POST /oauth/authorize` | sign-in page, then a redirect carrying the code |
| `POST /oauth/token` | authorization-code and refresh-token grants |
| `POST /oauth/revoke` | RFC 7009 revocation |

Deliberate choices:

- **PKCE is mandatory and S256 only.** `plain` offers no protection against an
  intercepted code, and every current MCP client supports S256.
- **Authorization codes live 120 seconds and are single-use.** Redemption is an
  atomic `UPDATE ... WHERE used_at IS NULL`, so a replay loses the race even if
  it arrives simultaneously.
- **Refresh tokens rotate.** The old one is revoked as part of the swap, so a
  leaked refresh token dies the next time the real client refreshes.
- **Redirect URIs must match exactly** what the client registered, and an
  unknown `client_id` or `redirect_uri` renders an error page rather than
  redirecting — redirecting to an unverified URI is how open redirectors happen.
- **Nothing secret is stored in the clear.** Client secrets, codes and tokens are
  kept as SHA-256 hashes and looked up by hash. `BOARD_PASSWORD` is never stored
  at all, only compared in constant time.

### Managing access

```bash
npm run oauth:admin                          # list clients and their live tokens
npm run oauth:admin -- --revoke sbc_abc123   # cut off one connector
npm run oauth:admin -- --prune               # delete expired codes and tokens
```

Revoking takes effect on the next request — there is no cached token to wait out.

### Verifying it

```bash
npm run oauth:check -- --url https://status-board-eight.vercel.app
npm run oauth:check -- --url https://... --password '<BOARD_PASSWORD>'
```

Without `--password` it checks everything up to the sign-in prompt: the 401
challenge, both discovery documents, registration, the sign-in page, and that an
unregistered `redirect_uri` and a wrong password are both refused. With
`--password` it completes the exchange, uses the token against the board and MCP,
then revokes both tokens so nothing is left live.

---

## Database

PostgreSQL via Drizzle ORM. Two tables, kept deliberately small.

**`board`** — the current board, a single row pinned to `id = 1` by a CHECK
constraint.

| column | type | notes |
| --- | --- | --- |
| `id` | integer PK | always `1` |
| `version` | integer | incremented on every successful write |
| `data` | jsonb | the board document, stored exactly as the frontend sends it |
| `created_at` / `updated_at` | timestamptz | |

**`board_history`** — every board that has been replaced.

| column | type | notes |
| --- | --- | --- |
| `id` | serial PK | the handle you pass to `db:restore` |
| `version` | integer | the version this snapshot *was* while current |
| `data` | jsonb | the archived board |
| `source` | text | `rest` / `mcp` / `seed` / `restore` — the interface whose write **replaced** this snapshot |
| `replaced_at` | timestamptz | |

`source` answers "what did the board look like before the automated update?":
the row marked `mcp` holds the board as it was *immediately before* the agent
wrote. A version is either current or archived, never both.

### Migration procedure

```bash
npm run db:generate   # regenerate SQL after editing src/db/schema.ts
npm run db:migrate    # apply pending migrations (idempotent, safe to re-run)
```

Generated SQL lives in [drizzle/](drizzle/) and is committed. `npm run db:migrate`
picks the right migrator for the driver in `DATABASE_URL`, so the same command
works against Neon, plain Postgres and PGlite.

### Neon setup

1. Create a Neon project and database.
2. Copy the **pooled** connection string (`...-pooler...`, with `?sslmode=require`).
3. Put it in `.env` locally and in the Vercel environment variables.
4. `npm run db:migrate`.

The Neon **serverless (WebSocket)** driver is used rather than the HTTP driver,
because the HTTP driver cannot do transactions and archiving-then-replacing must
be atomic. Driver selection is automatic from the host name
([src/db/client.ts](src/db/client.ts)).

**This is done.** The project database is connected, migrated and seeded with the
real board, and every layer has been verified against it — see
[Verified against Neon](#verified-against-neon).

### How the board is stored

Postgres `jsonb` keeps object keys in sorted order, so a board read back has its
keys in a different order than it was sent. Values, arrays and nesting are
preserved exactly, and array order is what drives what the team sees — areas and
projects render in stored order. The frontend reads by property name, so key
order is invisible to it.

The practical consequence is only for tooling: compare boards by value
(`assert.deepStrictEqual`, or the `sameBoard` helper in the check scripts), never
by `JSON.stringify` equality, or you will see a phantom difference. There is a
test pinning this behaviour in `tests/db.test.ts`.

---

## API

Same origin as the board HTML, so no CORS is involved in the recommended
deployment.

### `GET /api/board`

```json
{
  "board": { "areas": [ { "name": "Legal ops / trial support", "projects": [ … ] } ] },
  "version": 7,
  "createdAt": "2026-08-19T07:02:29.649Z",
  "updatedAt": "2026-08-19T07:04:11.220Z"
}
```

Also sets `X-Board-Version` and `X-Board-Updated-At`. Responses are `no-store`.
On a database that has never been written, returns `{ "areas": [] }` at version 1.

### `PUT /api/board`

Send the complete board. Either shape is accepted:

```json
{ "areas": [ … ] }
{ "board": { "areas": [ … ] } }
```

In order: **validate → archive the current board → replace it**. Validation
happens before any database access, so a rejected payload cannot disturb what is
stored.

Required on every project: a non-empty unique `id`, and a `status` of exactly
`green`, `amber`, `red` or `gray`. Everything else is optional and unknown fields
pass straight through. `status` is closed because the frontend does
`STATUS[p.status].cls` on every row — a value outside that set throws and renders
the entire board blank, so accepting one would take the board down for the team.

```json
{
  "board": { "areas": [ … ] },
  "version": 8,
  "previousVersion": 7,
  "historyId": 42,
  "warnings": [],
  "createdAt": "…",
  "updatedAt": "…"
}
```

`warnings` are non-fatal observations — duplicate project id, missing project or
area name, an `updated` value that is not a date, an empty board. They never block
a write; they are advice, and the MCP agent gets them back in its tool result.

Optional optimistic concurrency: include `"expectedVersion": 7` in the body, or
send `If-Match: "7"`. If the board has moved on, the write is refused with `409`
and nothing changes. Omit it and the behaviour is plain last-write-wins.

### Other endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/board/history?limit=50` | Previous versions, newest first, without payloads |
| `GET /api/board/history/:id` | One archived version including its board |
| `GET /api/health` | Liveness plus database reachability. Never requires a token, so uptime checks keep working. |
| `POST /api/mcp` | MCP endpoint (below) |

### Error shape

Every failure returns JSON, so the UI can always show a reason:

```json
{ "error": { "code": "invalid_board", "message": "…", "issues": [ { "path": "board.areas[0].projects[0].id", "message": "…" } ] } }
```

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `invalid_board`, `invalid_json` | Payload rejected; board untouched |
| 401 | `unauthorized` | `API_TOKEN` is set and the request did not present it |
| 404 | `not_found` | Unknown route or history id |
| 405 | `method_not_allowed` | |
| 409 | `version_conflict` | Stale `expectedVersion`; board untouched |
| 413 | `payload_too_large` | Over 2 MB |
| 503 | `database_unavailable` | Database unreachable. Message states the change was **not** saved. |

---

## Frontend integration

`status-board.html` persists itself through the Claude Artifact API, in exactly
two places ([status-board.html:165](status-board.html#L165) and
[:176](status-board.html#L176)):

```js
const res = await window.storage.get('board-data', true);
data = JSON.parse(res.value);

await window.storage.set('board-data', JSON.stringify(data), true);
```

[public/board-api.js](public/board-api.js) is a drop-in replacement for that
object backed by the real API. Integrating the board is **one added line** and no
UI changes — [public/index.html](public/index.html) is `status-board.html` with
exactly this inserted above its own `<script>`, and nothing else:

```html
<script src="/board-api.js"></script>
```

- `storage.get(key, shared)` → `GET /api/board`, resolving to
  `{ value: <json string> }` so the board's `JSON.parse(res.value)` works unchanged.
- `storage.set(key, jsonString, shared)` → `PUT /api/board`, with rapid edits
  debounced into one request and all writes serialised so two saves cannot
  interleave. A board object or an API envelope is accepted too.
- The key is accepted and ignored: the board is one shared document.
- `storage.delete()` is a deliberate no-op — wiping a shared board is never what
  anyone means.

### Two hazards it handles

**A save can fail.** On failure the promise rejects, so the board's own handler
shows "Save failed — changes are local to this session only", *and* a banner
appears. The banner matters because the board says nothing at all when a **load**
fails.

**A failed load must not destroy the board.** `loadData()` falls back to its
built-in `seedData` and immediately saves it when `get` rejects — against a live
API that would replace real content with stale seed content on any brief outage.
So `set` refuses to write until a load has actually succeeded (`LOAD-GUARD` in
board-api.js), which turns that path into a harmless no-op instead of data loss.
This is tested directly, in `tests/frontend-storage.test.ts` under "the seed-data
overwrite hazard".

To use your own indicator instead of the banner:

```html
<script>
  window.BOARD_API_OPTIONS = {
    banner: false,
    onStatus: (state, detail) => {
      /* state: loading | loaded | saving | saved | offline | error */
    },
  };
</script>
<script src="/board-api.js"></script>
```

Other options: `endpoint`, `token`, `debounceMs`, `retries`. Retries apply only
to network failures and 5xx — a rejected payload is never retried, because the
result would be identical.

The board is served from `public/index.html`, same origin as the API, so no CORS
is involved. When the frontend developer updates `status-board.html`, re-copy it
and re-insert that one script tag.

### One thing to know about the "Reload latest data" button

That button (`#resetData`) deliberately replaces the whole board with the
hard-coded `seedData` from inside the HTML, after a confirm dialog. It worked as a
local reset inside an artifact; against a shared board it discards everyone's
edits. It is recoverable — the discarded board is archived like any other write,
so `npm run db:history` then `npm run db:restore -- --id <id>` brings it back — but
consider removing the button or relabelling it, which is a frontend decision.

---

## MCP server

Two tools, both going through the same `boardService` as REST.

| Tool | Behaviour |
| --- | --- |
| `get_board()` | Returns the current board, its version, and area/project counts. Equivalent to `GET /api/board`. |
| `update_board(board, expectedVersion?)` | Validates, archives the current board, writes the new one. Returns the new version, the history id it was archived as, and any warnings. Equivalent to `PUT /api/board`. |

`update_board` is annotated as destructive and its description tells the agent to
call `get_board` first and send the **complete** board back, because a partial
board deletes rows. When a write shrinks the project count, the response says so
and names the history id to restore from.

Two transports, same server:

- **Streamable HTTP** at `POST /api/mcp` — stateless, for the Cowork/Claude
  connector.
- **stdio** via `npm run mcp:stdio` — for a local Claude Desktop / Claude Code
  connection:

```json
{
  "mcpServers": {
    "status-board": {
      "command": "npm",
      "args": ["run", "--silent", "mcp:stdio"],
      "cwd": "/path/to/statusboard",
      "env": { "DATABASE_URL": "postgresql://…" }
    }
  }
}
```

When `API_TOKEN` is set, the HTTP MCP endpoint requires it too — it can write the
board, so it is never less protected than the REST API.

---

## Deployment (Vercel)

**Deployed.** Frontend and API on one origin, which removes CORS entirely. Pushes
to `main` redeploy automatically.

### The functions are pre-bundled — do not "clean this up"

`api/index.js`, `api/mcp.js` and `api/diag.js` are **generated files that are
committed on purpose**. Two platform behaviours force this, both discovered the
hard way:

1. **Vercel does not ship the `src/` tree into a function.** It transpiles
   `api/*.ts` per file rather than bundling, so a function importing
   `../src/board/types` fails at module load with `ERR_MODULE_NOT_FOUND` and every
   request returns `FUNCTION_INVOCATION_FAILED`.
2. **Vercel only detects functions that exist in the repository.** Generating them
   during the build is not enough — the paths 404.

So [scripts/build-functions.mjs](scripts/build-functions.mjs) bundles the sources
in [functions/](functions/) into `api/*.js` with esbuild, and the result is
committed. `node_modules` stays external (`packages: "external"`) because
third-party packages *do* resolve fine at runtime from `/var/task/node_modules`;
only this project's own code needs inlining. That keeps each function around
23 KB rather than 750 KB.

The build regenerates them on every deploy, so production can never run a stale
bundle. To check the committed copies match the sources:

```bash
npm run verify:functions   # rebuilds, then fails if git sees a diff under api/
```

**Editing a function means editing `functions/*.ts`, then running
`npm run build:functions` and committing both.** Never edit `api/*.js` by hand.

`pg` and PGlite must also stay out of the bundle — their import specifiers in
[src/db/client.ts](src/db/client.ts) are assembled at runtime for that reason, and
there is a comment there explaining why. `pg` depends on `pg-cloudflare`, which
imports `cloudflare:sockets`, a specifier that does not resolve off Cloudflare.

### /api/diag

[functions/diag.ts](functions/diag.ts) is a diagnostic endpoint that imports each
module of the real graph inside try/catch and reports which one fails, plus the
Node version and whether each environment variable is *present* (never its
value). It exists because a module-load crash produces no usable response, and
there is no other way to see the error without platform log access — it is what
identified the bundling problem.

It is unauthenticated by design, since its value is working when everything else
is broken. It reveals the Node version and this project's module paths, nothing
more. Delete `functions/diag.ts`, re-run `npm run build:functions`, and remove
`api/diag.js` if you would rather not expose that.

### First-time setup

1. Push this repo to GitHub and import it into Vercel. No framework preset.
2. Set environment variables in the Vercel project (all three environments, or at
   least Production):
   - `DATABASE_URL` — the Neon pooled URL
   - `API_TOKEN` — the generated token; the build bakes it into `config.js`
   - `ALLOWED_ORIGINS` — leave empty for same-origin
3. Deploy. Vercel runs `npm run build`, which typechecks, writes
   `public/config.js`, and rebuilds the function bundles.
4. Run migrations against the production database, from your machine with the
   production `DATABASE_URL` set: `npm run db:migrate`.
5. Verify: `npm run smoke -- --url https://<deployment>`.
6. Optionally point a custom domain at the deployment in Vercel's domain settings.

Routing ([vercel.json](vercel.json)): `api/mcp.js` serves `/api/mcp`; every other
`/api/*` path is rewritten to `api/index.js`, which dispatches through the shared
handler. `public/` is served statically, so `/` is the board, and `/config.js` is
served `no-store` so a rotated token takes effect immediately.

If the build fails on the TypeScript step, that is `npm run build` doing its job —
fix the type error rather than removing the check.

### URLs to hand to the frontend developer

Live now:

```
Board                https://status-board-eight.vercel.app/
Board API   GET/PUT  https://status-board-eight.vercel.app/api/board
History     GET      https://status-board-eight.vercel.app/api/board/history
Health      GET      https://status-board-eight.vercel.app/api/health
MCP         POST     https://status-board-eight.vercel.app/api/mcp
```

Attaching a custom domain later changes only the host.

All of `/api/*` except `/api/health` requires `Authorization: Bearer <API_TOKEN>`.
The board itself needs no manual wiring — it picks the token up from `/config.js`.

For the Cowork/Claude MCP connector, use the `/api/mcp` URL with an
`Authorization: Bearer <API_TOKEN>` header. Verify it before handing it over:

```bash
npm run mcp:check -- --url https://status-board-eight.vercel.app --token <API_TOKEN>
```

Until the domain is live, the same paths work on the `*.vercel.app` deployment
URL. **These URLs are not yet live** — the deployment has not been performed from
this repo (no hosting account or Neon project was available here).

---

## Running the tests

```bash
npm test              # everything, 205 tests
npm run test:db       # schema, migrations, JSONB round-trip, transactions
npm run test:validate # accepted and rejected payloads, warnings
npm run test:api      # GET/PUT, rejections, CORS, token, real HTTP
npm run test:history  # A -> B -> C archiving, listing, restore
npm run test:mcp      # both tools, and REST/MCP cross-visibility
node --import tsx --test tests/integration.test.ts      # two clients, failures, races
node --import tsx --test tests/frontend-storage.test.ts # the window.storage shim
npm run typecheck
```

Tests default to in-memory PGlite, so they need no setup and cannot touch a live
database. To run the same suite against Neon or local Postgres:

```bash
TEST_DATABASE_URL='postgresql://…' npm test
```

Every test file resets both tables between tests, so pointing it at a real
database **will empty those tables**. Use a scratch database, never production.

To check a running deployment instead:

```bash
npm run smoke -- --url https://status-board-eight.vercel.app            # REST, read-only
npm run smoke -- --url https://status-board-eight.vercel.app --write    # REST round-trip

npm run mcp:check -- --url https://status-board-eight.vercel.app          # MCP, read-only
npm run mcp:check -- --url https://status-board-eight.vercel.app --write  # MCP round-trip

npm run oauth:check -- --url https://status-board-eight.vercel.app        # OAuth, no password needed
```

`smoke` covers REST plus an MCP handshake. `mcp:check` connects as a real MCP
client: lists tools, calls `get_board`, confirms MCP and REST agree, confirms an
invalid board is rejected without changing anything, and with `--write` calls
`update_board` and verifies the history row is recorded as an `mcp` write. Both
are safe against a live board — `--write` sends back exactly what it read, so the
content does not change, though it does bump the version and add a history row.

### What the suite covers

- **Database** — connection, migration idempotency, JSONB preserving unknown
  fields exactly, singleton enforcement, history insertion and ordering, and
  transaction rollback leaving the board intact.
- **Validation** — the plan's shape accepted, malformed payloads rejected
  (missing `areas`, bad project structure, missing/empty ids, wrong types,
  non-serialisable and oversized payloads), unknown frontend fields preserved,
  and questionable-but-usable values surfaced as warnings rather than refused.
- **REST** — status codes, headers, empty/initial state, envelope tolerance,
  405/404, CORS allow-listing, optional token, and the same flows over a real
  socket.
- **Safety** — for every class of bad request: response is 4xx, the stored board
  is byte-identical, the version does not move, and no history row is written.
- **History** — the A→B→C chain, gap-free versions, a version never both current
  and archived, and restore (including that a restore is itself undoable).
- **MCP** — tool discovery and annotations, both tools, validation rejection
  leaving the board untouched, `expectedVersion` protecting a human edit,
  shrink warnings, and REST↔MCP cross-visibility both directions, over the
  in-memory transport and over `/api/mcp`.
- **Integration** — load/edit/save/reload persistence, two clients sharing one
  database, concurrent writes getting distinct versions with no lost history,
  and failure behaviour: database down → 503 saying "not saved", health
  reporting down, client disconnect mid-request, oversized body, and a JSON
  error body on every failure.
- **OAuth** — PKCE verification including refusal of `plain` and out-of-range
  verifiers; both discovery documents; the 401 challenge carrying a
  `resource_metadata` pointer; dynamic client registration including refusal of
  `javascript:`/`data:`/`file:` and non-loopback `http` redirect URIs; the sign-in
  page; and then the attacks — unknown client, unregistered `redirect_uri`
  (asserting no redirect happens), missing PKCE, wrong verifier, replayed code,
  code issued to another client, mismatched `redirect_uri` at exchange, wrong
  client secret, refresh-token reuse after rotation, cross-client refresh, and
  that a revoked token is refused by the board immediately.
- **Config seam** — `renderConfig` output, `/config.js` delivery and no-store
  headers, and the board bootstrapping through config.js against a
  token-protected API — including that a missing token fails loudly instead of
  looking like it worked.
- **Frontend shim** — the exact two calls status-board.html makes, driven
  against the real server; a failed save rejecting and reporting "not saved"
  rather than appearing to succeed; and the seed-overwrite hazard, including that
  a store which never loaded refuses to write.
- **The real board** — the seed board extracted from the HTML validates with zero
  warnings and survives validation byte for byte.

---

## Restoring a previous board version

```bash
npm run db:history                        # list versions, newest first
npm run db:history -- --id 42             # print that archived board
npm run db:history -- --id 42 --out backup.json
npm run db:restore -- --id 42 --dry-run   # show what would change
npm run db:restore -- --id 42             # restore it
```

A restore is an ordinary write: the board it rolls over is archived first, so it
is itself undoable — the command prints the id to undo it.

This is CLI-only on purpose. There is no public rollback endpoint, because there
is no authentication in v1.

### Backups

Neon's own point-in-time restore covers catastrophe. For a file copy before a
risky change:

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" \n  https://status-board-eight.vercel.app/api/board | jq .board > board-backup.json
npm run db:seed -- --file board-backup.json --force   # restore it later
```

---

## Known v1 limitations

1. **No user accounts — one shared password, and a token the browser can read.**
   The MCP side is now properly protected: connectors hold per-client, expiring,
   revocable OAuth tokens gated behind `BOARD_PASSWORD`. The **browser** side is
   the weak half — the board page is served the static `API_TOKEN` at
   `/config.js`, so anyone who can open the board can read it and call the API
   directly. There are also no individual accounts, no roles, and no record of
   *which person* made a change (only whether it came from the browser, the agent,
   a seed or a restore). Closing the browser gap means putting the deployment
   behind Vercel's access controls or an SSO proxy, or giving the board itself a
   sign-in. **Until then, treat the board URL as the secret.**
2. **Last write wins.** Two people editing simultaneously: the later save
   overwrites the earlier one wholesale. The overwritten version is always in
   `board_history`, so nothing is lost permanently, but no one is warned.
   Optimistic concurrency exists and is tested — the client just has to opt in by
   sending `expectedVersion`. Recommended next step: have the frontend send the
   version it loaded and show a "reload, someone else saved" prompt on 409. That
   is a frontend change, so it is left switched off pending your call.
3. **No live updates.** Browser B sees browser A's changes on refresh, not
   automatically. Polling `GET /api/board` and comparing `version` would be a
   small addition if wanted.
4. **The board's own reset button discards everyone's edits.** See above. Left
   alone because changing UI behaviour is the frontend developer's call.
5. **No history pruning.** Every write keeps a full board copy. At a few KB per
   version this is fine for years; revisit if the board grows a lot.
6. **Not deployed.** No production URL exists yet (no hosting account or Neon
   project was available during implementation). The steps above are untested
   against real Vercel and Neon, though every code path is driver-agnostic and
   tested against real Postgres.

## Board contract, confirmed against status-board.html

The board shape is exactly what the plan described, verified against the real
file:

```json
{ "areas": [ { "name": "…", "projects": [
  { "id": "fl-sweep", "name": "…", "owner": "…", "status": "amber",
    "note": "…", "updated": "2026-07-07", "flag": true } ] } ] }
```

- Nothing else appears at any level: project keys are exactly `flag, id, name,
  note, owner, status, updated`; area keys exactly `name, projects`; top level
  exactly `areas`. Extra fields are still preserved if the frontend adds any.
- `status` is one of `green` (Moving), `amber` (Watch), `red` (Blocked),
  `gray` (Needs update) — note **`gray`, not `grey`**. All four are in use.
- `owner` and `updated` are legitimately empty strings on new rows, so empty is
  accepted; a non-date `updated` warns rather than failing.
- New project ids are generated as `p-<Date.now()>`.
- The seed board in the HTML has no duplicate ids and passes validation with zero
  warnings — there is a test asserting exactly that, so a future edit to the seed
  data that the API would reject fails the suite.

## Layout

```
status-board.html  the frontend developer's original, kept unmodified for reference
public/index.html  the same file plus two <script> tags — what actually gets served
public/board-api.js  window.storage replacement backed by the API
public/config.js   generated at build time from API_TOKEN; gitignored
seed/              initial-board.json, extracted from the HTML's seedData
src/oauth/         the authorization server: metadata, registration, authorize,
                   token, revocation, storage, and the shared authenticator
src/board/         types, validation, errors, and boardService — the single source of truth
src/db/            Drizzle schema, driver selection, migration runner
src/http/          transport-agnostic API handler, CORS, Node server, Vercel adapter
src/mcp/           MCP server (two tools) plus HTTP and stdio transports
api/               Vercel functions: index.ts (REST catch-all), mcp.ts
functions/         serverless function sources (TypeScript) -- edit these
api/               esbuild output, COMMITTED so Vercel detects it -- never hand-edit
scripts/           migrate, seed, history, restore, smoke, mcp-check, oauth-check,
                   oauth-admin, write-config, build-functions
tests/             one file per layer, in the order the plan requires them
drizzle/           generated migration SQL (committed)
```

---

## Status against the plan's definition of done

Done and tested:

- [x] Existing status-board HTML inspected; board JSON contract confirmed against it
- [x] Drizzle schema and migrations working, idempotent, driver-agnostic
- [x] Current board stored and retrieved; `GET /api/board`; `PUT /api/board`
- [x] Previous versions archived before every update
- [x] Invalid payloads rejected safely; a failed update cannot corrupt the board
- [x] REST API tests pass
- [x] Existing HTML loads and saves through the API (`public/index.html`, one added line)
- [x] Persistence across reload, and across two independent clients
- [x] Save/API failure behaviour tested, including the seed-overwrite hazard
- [x] MCP `get_board()` and `update_board()` work, through the same service layer
- [x] MCP updates create history records; REST and MCP read each other's writes
- [x] Restore/backup procedure documented and working (`db:history`, `db:restore`)
- [x] Deployment steps, environment variables, and test instructions documented

- [x] **Neon PostgreSQL database connected**, migrated, and seeded with the real board
- [x] **Production API deployed** and verified
- [x] **Production MCP endpoint deployed** and verified
- [x] **URLs documented for the frontend developer** (see [Live](#live))
- [x] **Deployment and rollback/backup procedures documented**

Every box on the plan's checklist is now ticked. The one thing deliberately not
done is attaching a custom domain, which is a DNS decision rather than a code one.

Re-verify at any time:

```bash
npm run smoke -- --url https://status-board-eight.vercel.app --write
npm run mcp:check -- --url https://status-board-eight.vercel.app --write
```

## Verified against Neon

Every layer was exercised against the real Neon database, not just PGlite:

| Check | Result |
| --- | --- |
| Driver detection and connection | `neon` driver selected from the hostname |
| `npm run db:migrate` | schema created, idempotent on re-run |
| `npm run db:seed` | real board written, 4 areas / 18 projects |
| `npm run smoke -- --write` | 16/16 — GET, PUT, headers, invalid-PUT rejection, no-op on rejection, MCP handshake, write round-trip |
| `npm run mcp:check -- --write` | 17/17 — tool discovery, `get_board`, MCP↔REST agreement, invalid board rejected without change, `update_board`, history recorded as `mcp` |
| `npm run db:history` | version sequence and `source` correct across seed / rest / mcp / restore writes |
| `npm run db:restore` | dry run, real restore, and the printed undo id all correct |

The automated suite itself still runs on PGlite by design: it truncates both
tables between tests, so pointing it at Neon would wipe the board. Its job is
logic correctness; the commands above are what prove the Neon transport.

## Verified against production

| Check | Result |
| --- | --- |
| `smoke --write` against the deployment | 16/16 |
| `mcp:check --write` against the deployment | 17/17 — including history recorded as an `mcp` write |
| `/api/health` | `{"ok":true,"database":"up"}` — production reaches Neon |
| `/api/board` without a token | 401 |
| `/api/mcp` without a token | 401 |
| `/api/health` without a token | 200, as intended for uptime checks |
| `/api/diag` module probe | every module resolves |
| Board page, `/config.js`, `/board-api.js` | all served, token delivered to the page |
| **Browser path** | the live `config.js` and `board-api.js` were loaded in a sandbox and driven through the board's own two storage calls: load, parse, save, reload, and a rejected save that surfaced as a rejection without damaging the board |

The browser-path check is the one that matters most, because it exercises the
real deployed scripts rather than a local copy. It is content-neutral — it writes
back exactly what it read.
