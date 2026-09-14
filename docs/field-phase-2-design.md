# Field, Phase 2 — the focus object, the context trail and lenses (design)

**Status: written design only.** Nothing on this page is implemented. Phase 2
gated the Field's evolution on the architecture underneath it being stable
(CI, release, auth, connectors, graph, NOW, routing, intelligence); those are
now in place, and this is the design the next Field work should build from,
written down so it is reviewed before it is coded. It keeps every rule in
`docs/field.md` → "What the Field deliberately is not": no dashboard, no
sidebar of modules, no fake OS chrome, no dock, no taskbar, no permanent AI
panel, no client-side business logic.

## 1. The focus object

Today the Field has a *focused entity* per area (`CommandContext.focus`), set
by clicks and by One Command results, and lost on area change. The focus
object generalises it into one value the whole Field agrees on:

```ts
interface Focus {
  readonly ref: EntityRef;                 // what the person is looking at
  readonly origin: "click" | "command" | "handoff" | "praxion" | "now";
  readonly at: IsoDateTime;
  readonly lens?: LensId;                  // how it is being looked at (§3)
}
```

Rules:

- **One focus at a time**, held by `SpineProvider` next to `version`; every
  area reads it, none owns it. Changing area does not clear it — the areas
  show *their* view of the same object (Money shows a person's transactions,
  Files their documents) — which is what makes the context line honest: it
  names the object, then the area.
- **Praxion is a source of focus, not a sink.** When Praxion reports a
  focused document (`ScreenContextRegistry.current()`), the Field *offers*
  it in the context line ("Praxion: Operating agreement v3.pdf — follow?");
  it never silently replaces a focus the person set. One click adopts it,
  `origin: "praxion"`.
- **Handoffs carry focus** already (`handoffs.focus_type/focus_id`); accepting
  one sets the focus with `origin: "handoff"`. The migration-11 rule applies:
  a focus whose entity vanished is cleared, never a dead reference.
- The focus is **device-local state**, not a spine row: nothing about what
  someone is looking at is written anywhere, and no Realtime channel carries
  it. The only persisted trace is a handoff the person creates on purpose.

## 2. The context trail

A trail is the ordered list of focus objects of this session, most recent
last, bounded (32 entries), device-local, never persisted:

```ts
interface Trail { readonly entries: readonly Focus[]; }   // push on focus change, dedupe consecutive refs
```

It renders as a single quiet row under the context line — entity names only,
no thumbnails, no cards — and answers two questions the current Field
cannot: *how did I get here* (back through the trail) and *what was I doing
before this handoff arrived* (the trail survives accepting one). One Command
gains two intents that read it and nothing else: `back` (previous focus) and
`what was I on` (list the trail); both are grammar rules, no model.

What the trail is not: a history of everything seen in a list, an activity
log, or a source for the NOW engine. NOW reasons over context events; the
trail is the person's own path, and it stays on the device.

## 3. Lenses

A lens is a named, read-only projection of the focus object through the
reader, computed in `@vixera/command` (the same package One Command uses),
rendered by the Field with no business logic of its own:

| Lens | Focus type | Reads | Shows |
| --- | --- | --- | --- |
| `context` (default) | any | `neighbors()` one hop, `listContextEvents({ subject })` | what is attached to this object and what happened to it |
| `people` | thread, document, event, transaction | `neighbors({ type: "person" })` | who is involved, with their role edges (`has_person`, `mentions`) |
| `timeline` | person, thread | context events across all subjects linked to it, by `occurredAt` | the object over time |
| `money` | person, thread | `listMoneyTransactions` scoped by edges (as `showTransactions` does today) | what it cost |
| `compare` | document (two focuses) | Praxion structured content of both, `Intelligence.compareContext` when a model is wired | differences, with refs — data only |

Rules that keep lenses from becoming a dashboard:

- A lens is **chosen, one at a time**, from the context line; it is not a
  grid of panels. The default lens is the area's own view, so a Field with no
  lens chosen looks exactly as it does today.
- Every lens is a **pure function of the reader** — `lens(reader, focus) →
  LensResult` — and therefore testable against the brief world like the
  executor is. Lenses never mutate, never call providers, never hold state.
- A lens that needs a model (`compare`) degrades to "Praxion is not running"
  or "no model is wired" — a sentence, not a spinner — and is otherwise an
  ordinary lens: the model's output is data with refs, validated by
  `@vixera/intelligence`, never an action (ADR-016).
- No lens is ever *suggested* by a model. The person chooses the lens; the
  model may fill one.

## 4. What stays out

- No workspace/desktop metaphor: no windows, no dock, no taskbar, no app
  launcher, no split panes. The Field stays one column of context.
- No "recent items" carousel or thumbnails: the trail is text.
- No persistence of focus or trail to the spine, and no cross-device sync of
  either; a handoff is the deliberate, explicit way to move focus to another
  device, and it already exists.
- No lens that writes: every mutation still goes through `action-dispatch`.

## 5. Order of work (each a small PR with tests)

1. `Focus` in `SpineProvider`, replacing per-area focus; context line renders
   it; the executor's `CommandContext.focus` reads it. Tests: focus survives
   area change; a handoff sets it; a deleted entity clears it.
2. The trail (bounded, deduped) and the two grammar intents. Tests in
   `@vixera/command` against the brief world.
3. `context` and `people` lenses as pure functions with executor-style tests;
   the Field renders `LensResult` with the existing result items.
4. `timeline`, `money`. `compare` only once a model provider exists
   (`docs/intelligence.md` says none does).
5. Praxion focus offer in the context line, behind `isAvailable()`.

Estimated size: ~600 lines of TypeScript plus tests, no schema change, no new
dependency, no new Edge Function.
