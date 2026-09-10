# Screen context adapters

Everything Vixera learns about "what is on screen" passes through one seam,
`ScreenContextAdapter` in `packages/domain/src/screen-context/adapter.ts`.
This is mandatory seam #4 of the brief. Phase 1 ships two implementations in
`packages/connectors/screen-context` (`@vixera/screen-context`). There is no
OCR and no accessibility screen reading.

## The seam

```ts
interface ScreenContextAdapter {
  readonly id: string;
  readonly source: "praxion" | "explicit_capture" | "windows_foreign_app" | "android_assist";
  isAvailable(): Promise<boolean>;                 // cheap, safe to call often
  getCurrentContext(): Promise<ScreenContext | null>; // null when nothing is in focus
}

interface ScreenContext {
  source; capturedAt;
  document: { title; externalRef; mimeType; praxionDocumentId } | null;
  location: PraxionLocation | null;                // { page, position, selectionText }
  selection: string | null;
  structuredContent: StructuredBlock[] | null;     // when the source can provide it
  text: string | null;                             // for text-only sources
  metadata: JsonObject;
}
```

`ScreenContextRegistry` (domain) holds adapters in priority order. `current()`
returns the first adapter that is both available and has a context; an adapter
that throws is treated as unavailable. UI, One Command and intelligence code
hold the registry and never talk to Praxion or a capture surface directly.

## Implementations (Phase 1)

### `PraxionStructuredContentAdapter` — source `praxion` (primary)

Wraps a `PraxionConnector` (`@vixera/praxion`).

* `isAvailable()` ⇔ `connector.availability().state === "available"`. The
  connector caches its health probe, so this costs nothing per call.
* `getCurrentContext()` reads `currentContext()` and, when Praxion advertises
  `structured_content`, `getContent(documentId)`; it folds document summary,
  location, selection (falling back to `location.selectionText`) and blocks
  into one `ScreenContext`. Blocks are capped by `maxBlocks` (default 500);
  `metadata.truncated` reports server- or client-side truncation,
  `metadata.contentAvailable` whether blocks were obtainable at all.
* Returns `null` when Praxion has no focused document. Never throws on an
  absent Praxion: the connector already degrades to `null`.
* `document.externalRef` is Praxion's path when known, else its document id;
  `document.praxionDocumentId` is always Praxion's id so the ingestion /
  linker can attach it to `Document.praxionDocumentId`.

Options: `{ maxBlocks?: number; includeContent?: boolean }`.

### `ExplicitCaptureAdapter` — source `explicit_capture` (secondary)

The user hands Vixera something on purpose (Android share sheet, capture
button, drop on the Field). The surface calls:

```ts
adapter.provide({ text?, title?, blocks?, documentRef?, metadata?, capturedAt? }): ScreenContext
adapter.clear(): void
```

One capture is held at a time; `isAvailable()` is true only while a capture is
held, so the registry only falls through to it when the user gave Vixera
something. A capture needs at least text, blocks or a document reference
(otherwise `TypeError`). `text` is derived from blocks when only blocks are
provided. Nothing is observed; this is not screen reading.

### `createScreenContextRegistry({ praxion?, praxionOptions?, explicit? })`

Builds the Phase 1 registry: Praxion first, explicit capture second. Pass what
exists on the device; on Android there is no Praxion, on Windows there may be
none installed. Both absent ⇒ `current()` is `null` and the Field shows its
empty state.

```ts
const praxion = new PraxionClient(new FetchPraxionTransport());
const explicit = new ExplicitCaptureAdapter();
const registry = createScreenContextRegistry({ praxion, explicit });
// share sheet → explicit.provide({ ... }); UI → registry.current()
```

## Deferred, on purpose

The `source` union already names two further implementations that are **not**
built in Phase 1:

| Source | Would be | Why deferred |
| --- | --- | --- |
| `windows_foreign_app` | `WindowsForeignAppAdapter`: foreground window of arbitrary Windows apps via UI Automation / OCR | The brief excludes floating overlays, OCR-everything and complex shell integration; Praxion covers documents, which is the Phase 1 need |
| `android_assist` | `AndroidAssistAdapter`: Android accessibility / assist-structure reading | The brief excludes Android accessibility screen reading; explicit share/capture is the Android surface |

When either is built it implements the same `ScreenContextAdapter` interface
and registers between Praxion and explicit capture. No caller changes. The
principle stays: Vixera reads structured content from cooperating sources and
explicit user input, not the screen at large.

## Tests

`packages/connectors/screen-context/src/screen-context.test.ts` covers: the
Praxion adapter's output shape (no Praxion wire fields leak), unavailable /
incompatible Praxion ⇒ not available and no throw, truncation, content-less
Praxion builds, explicit capture lifecycle, and the registry's fall-through
(Praxion down ⇒ explicit capture; Praxion up but nothing focused ⇒ explicit
capture; both absent ⇒ `null`).
