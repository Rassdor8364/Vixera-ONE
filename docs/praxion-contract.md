# Praxion local contract (v1.0.0)

Praxion (`ai.vixera.praxion`) is a separate product in a separate repository. It
owns the document artifact: rendering, annotation, comparison, signing, page
state, structured document content. Vixera One (`ai.vixera.one`) owns context.
Praxion is treated as a **third-party local connector**: no shared database, no
imported internals, no access to Praxion's persistence, optional at runtime.

Code: `packages/connectors/praxion` (`@vixera/praxion`).

| File | Role |
| --- | --- |
| `src/contract.ts` | constants, endpoint table, JSON shapes, error envelope, capability list |
| `src/version.ts` | semver parse + `isContractCompatible` |
| `src/transport.ts` | `PraxionTransport` seam, `FetchPraxionTransport` (loopback only) |
| `src/connector.ts` | `PraxionConnector` interface, `PraxionClient`, availability model |
| `src/testing/in-memory-praxion.ts` | in-process fake of the server side + transport wrapper |
| `src/testing/fixtures.ts` | fixture documents (obviously fake data) |
| `scripts/mock-server.ts` | Node HTTP wrapper around the fake for local development |

## Transport

Loopback HTTP, JSON bodies, base URL `http://127.0.0.1:47815`
(`PRAXION_DEFAULT_BASE_URL`). The client talks to a `PraxionTransport`:

```ts
interface PraxionTransport {
  request<T>(input: { method: "GET" | "POST"; path: string; body?: unknown; timeoutMs?: number })
    : Promise<{ status: number; body: T | null; failure?: { kind: "timeout" | "network"; message: string } }>;
}
```

A transport **never throws for a connection that could not be made**: refused
connection, DNS failure or timeout resolve to `status: 0` with a `failure`
descriptor, so the client degrades instead of crashing. Non-JSON or empty
bodies parse to `null`. The transport can later be backed by the Tauri HTTP
plugin or a named pipe without changing any caller.

## Endpoints

All paths are under `/v1`. `{id}` is Praxion's document id, URL-encoded.

| Endpoint | Method | 200 body | Errors |
| --- | --- | --- | --- |
| `/v1/health` | GET | `PraxionHealth` | 426 (body = `PraxionHealth`) |
| `/v1/context/current` | GET | `PraxionCurrentContext` | — |
| `/v1/documents/{id}` | GET | `PraxionDocumentMetadata` | 404 |
| `/v1/documents/{id}/content` | GET | `PraxionStructuredContent` | 404 |
| `/v1/documents/{id}/location` | GET | `PraxionLocation` | 404 |
| `/v1/documents/{id}/selection` | GET | `PraxionSelection` | 404 |
| `/v1/documents/open` | POST `PraxionOpenRequest` | `PraxionOpenResponse` | 400, 404 |
| `/v1/actions` | POST `PraxionActionRequest` | `PraxionActionResponse` | 400, 404, 422 |

Route note for servers: `POST /v1/documents/open` must be matched before
`GET /v1/documents/{id}`; the method disambiguates.

## JSON shapes

```ts
type PraxionCapability =
  | "open" | "current_context" | "structured_content" | "selection" | "location" | "metadata"
  | "action:compare" | "action:annotate" | "action:sign" | "action:goto";

interface PraxionHealth {
  app: "praxion";
  contractVersion: string;        // "1.0.0" — the contract the server implements
  appVersion: string;             // Praxion's own version, informational
  capabilities: PraxionCapability[];
}

interface PraxionDocumentSummary {
  id: string;                     // Praxion's id; Vixera stores it as Document.praxionDocumentId
  title: string;
  path: string | null;            // absolute path on this device, null if in-memory
  mimeType: string;
  pageCount: number | null;
}

interface PraxionLocation {       // identical to @vixera/domain PraxionLocation
  page: number | null;
  position: object | null;        // opaque to Vixera (Praxion-defined)
  selectionText: string | null;
}

interface PraxionCurrentContext {
  document: PraxionDocumentSummary | null;   // null = nothing focused
  location: PraxionLocation | null;
  selection: string | null;
  capturedAt: string;             // ISO-8601
}

interface PraxionDocumentMetadata extends PraxionDocumentSummary {
  sizeBytes: number | null;
  contentHash: string | null;     // sha256 hex when Praxion has the bytes
  createdAt: string | null;
  modifiedAt: string | null;
  metadata: object;               // Praxion-defined, opaque to Vixera
}

interface PraxionStructuredContent {
  documentId: string;
  blocks: StructuredBlock[];      // @vixera/domain StructuredBlock: { kind, text, page, metadata? }
  truncated: boolean;             // server cut the list (very large documents)
}

interface PraxionSelection { documentId: string; text: string | null }

interface PraxionOpenRequest { path?: string; documentId?: string; location?: PraxionLocation; focus?: boolean }
interface PraxionOpenResponse { document: PraxionDocumentSummary }

interface PraxionActionRequest { action: "compare" | "annotate" | "sign" | "goto"; documentId: string; params: object }
interface PraxionActionResponse {
  accepted: boolean;              // Praxion will perform it
  supported: boolean;             // false = this build cannot perform this action
  message: string | null;
}

interface PraxionErrorEnvelope { error: { code: string; message: string } }
```

Error codes: `bad_request` (400), `not_found` (404), `conflict` (409),
`unsupported_action` (422), `unsupported_contract` (426), `internal` (500).

Nothing on the wire carries a Vixera user id. Praxion is login-free and
single-user; the Vixera `userId` is attached by the spine store when context is
persisted (`currentUser()`), never taken from Praxion.

## Versioning and compatibility

* `PRAXION_CONTRACT_VERSION = "1.0.0"` is the contract this client speaks.
* Every request carries `X-Praxion-Contract: <major>` (`PRAXION_CONTRACT_HEADER`).
* `GET /v1/health` reports the server's `contractVersion`.
* **Compatible** when majors are equal and `server.minor >= client.minor`
  (`isContractCompatible(server, client)`). Servers add endpoints and fields in
  minor releases; a client written against an older minor keeps working.
  Breaking changes bump the major. Patch is ignored. Malformed version strings
  are never compatible.
* A server that does not support the requested major replies
  **`426 Upgrade Required` with its `PraxionHealth` as the body** on any
  endpoint, so the client can report both versions from a single round trip.

The client resolves availability as:

```ts
type PraxionAvailability =
  | { state: "available"; contractVersion; appVersion; capabilities }
  | { state: "unavailable"; reason: "not_running" | "timeout" | "error"; detail }
  | { state: "incompatible"; serverVersion; clientVersion };
```

| Observation | Result |
| --- | --- |
| status 0, network failure | `unavailable / not_running` |
| status 0, aborted by timeout | `unavailable / timeout` |
| 426 | `incompatible` (serverVersion from the body) |
| 200 but body is not a Praxion health payload | `unavailable / error` (something else on the port) |
| 200, `isContractCompatible` false | `incompatible` |
| any other non-2xx | `unavailable / error` |

## Client (`PraxionClient`)

```ts
const connector = new PraxionClient(new FetchPraxionTransport(), { cacheMs: 5000 });
```

* `availability()` probes `/v1/health` with a 750 ms timeout and caches the
  result for `cacheMs` (default 5 s); concurrent callers share one probe.
  When Praxion is absent every other method costs nothing beyond that cached
  probe. `invalidate()` forces a re-probe (e.g. after the user launches Praxion).
* Reads (`currentContext`, `getDocument`, `getContent`, `getLocation`,
  `getSelection`) return `null` when Praxion is unavailable or incompatible,
  when the server does not advertise the matching capability (no request is
  made), on 404, and when the connection is lost mid-session (the cache is
  refreshed with the new state). `currentContext()` is also `null` when no
  document is focused.
* Writes (`openDocument`, `requestAction`) throw `PraxionUnavailableError`
  (carrying the `PraxionAvailability`) when Praxion cannot take the request.
  `requestAction` returns `{ supported: false }` without a request when the
  capability `action:<name>` is not advertised, and maps a server 422 to the
  same shape.
* Any other unexpected status from a reachable Praxion throws
  `PraxionRequestError { status, code, path }`.
* `supports(capability)` is `availability().state === "available" && capabilities.includes(...)`.

## Security posture

* `FetchPraxionTransport` accepts **only loopback base URLs** (`127.0.0.0/8`,
  `localhost`, `[::1]`) and throws `PraxionTransportError` at construction for
  anything else; a misconfigured base URL can never send document context off
  the machine. The error message never echoes credentials or query strings.
* The mock server binds `127.0.0.1` only. Praxion must do the same.
* No authentication in v1: the loopback boundary is the trust boundary
  (same user session on the same machine). If a platform makes another local
  process a realistic threat, v1.x can add a shared local token as a minor
  revision without changing callers (the header is transport-level).
* Praxion is trusted but not assumed: health payloads are structurally
  validated, and no field from Praxion is ever used as a user id.

## Degradation behaviour (brief: "Local Praxion degradation")

Praxion absent or incompatible ⇒ Vixera still launches, documents remain in
the spine, opening a document falls back to the OS viewer (Rust opener), and
only Praxion-specific features (structured content, compare, annotate, sign,
page state) are disabled. The `ScreenContextRegistry` falls through to explicit
capture (see `screen-context.md`). Nothing throws on a refused connection.

## Running the mock server

```
pnpm praxion:mock
# = node --experimental-strip-types packages/connectors/praxion/scripts/mock-server.ts
```

Serves the in-memory fake on `127.0.0.1:47815` (`PRAXION_MOCK_PORT` overrides
the port) with two fixture documents. "Operating agreement v3.pdf" (18 pages)
is focused at page 7 with a selection about clause 7.1; "Invoice 0231" is
available to open. Quick checks:

```
curl -s http://127.0.0.1:47815/v1/health
curl -s http://127.0.0.1:47815/v1/context/current
curl -s http://127.0.0.1:47815/v1/documents/doc-operating-agreement-v3/content
curl -s -H 'X-Praxion-Contract: 9' -o /dev/null -w '%{http_code}\n' http://127.0.0.1:47815/v1/health   # 426
curl -s -X POST -H 'content-type: application/json' -d '{"documentId":"doc-invoice-0231"}' http://127.0.0.1:47815/v1/documents/open
curl -s -X POST -H 'content-type: application/json' -d '{"action":"goto","documentId":"doc-invoice-0231","params":{"page":2}}' http://127.0.0.1:47815/v1/actions
```

The same fake is available in-process (`InMemoryPraxion` +
`InMemoryPraxionTransport` from `@vixera/praxion`) for tests and for a
"fake Praxion" development mode without a second process. Stop the mock before
running real Praxion; both want the same port.

## What Praxion must implement

1. Listen on `127.0.0.1:47815` (loopback only), JSON over HTTP/1.1.
2. `GET /v1/health` returning `PraxionHealth` with `app: "praxion"`, the
   contract version it implements, and only the capabilities it really has.
3. Read `X-Praxion-Contract` on every request; reply `426` + health payload
   when the major is unsupported.
4. `GET /v1/context/current` reflecting the focused document (or `document: null`).
5. The document endpoints above for every document it has open; `404` +
   envelope for unknown ids; `truncated: true` rather than gigantic content
   bodies (a few thousand blocks is a sensible cap).
6. `POST /v1/documents/open` accepting a path or a known id plus an optional
   location, focusing the window unless `focus: false`.
7. `POST /v1/actions` answering `422 unsupported_action` (or
   `{ supported: false }`) for actions the build cannot perform; never a 500.
8. `{ error: { code, message } }` on every non-2xx.
9. Stay login-free and local: no Vixera identifiers, no cloud, no shared store.
10. Bump the minor for additive changes, the major for breaking ones, and keep
    serving the previous major for at least one release where practical.
