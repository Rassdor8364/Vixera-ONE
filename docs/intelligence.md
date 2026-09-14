# Intelligence

`packages/intelligence` (`@vixera/intelligence`). Vixera One *is* the
intelligence layer; language models are adapters behind a seam. This package
is where the seam lives, and it is deliberately small: a provider contract, a
way to select context a model may see, six task shapes, and an audit trail
that never contains content.

**Status:** Implemented, fixture-tested with a scripted provider. **No real
provider adapter exists** — not Vixera AI, not Claude, not OpenAI, not Gemini,
not a local model. Prompts are plain and untuned. Nothing in the Field calls
this package yet; the first consumer is the model-backed intent router
(`docs/field.md` → One Command), which is wired with `null` until a server-side
classifier exists.

## Contract

```
ModelProvider { id, capabilities, complete(request, { signal }) }
ModelCapabilities { locality: local|remote, structuredOutput, maxInputTokens, cancellation }
ModelRegistry     register / get / default / matching(requirements)
```

Adapters that hold API keys run **server-side only** (Edge Functions), keys in
Supabase secrets. The registry on a device may hold a local model one day; it
holds the `NullModelProvider` today, which throws `ModelUnavailableError` so
every caller degrades explicitly.

## Context a model may see

A model is never handed "the user's context". It is handed a
`ContextSelection`, built by `selectContext(items, budget)`:

- every item is reduced to the fields on `CONTEXT_FIELD_ALLOWLIST` for its
  entity type — subjects, titles, dates, amounts, states; **never bodies,
  never snippets, never raw addresses, never tokens**. Each list is checked at
  compile time against the entity's own type (`satisfies FieldsOf<T>`), so a
  misspelled or removed field is a type error, and a test asserts no
  allow-listed field name even smells like a secret;
- the whole selection sits under a byte budget (16 KiB by default), an item
  cap (50) and a per-field cap (500 chars). A caller may ask for more, but a
  budget is clamped to the ceiling — 64 KiB, 200 items, 2000 chars — and to a
  floor, so no caller can turn "a selection" back into "everything"; bytes are
  UTF-8 bytes, not characters. What did not fit is counted, not silently lost;
- an entity type with no allow-list is an error, not an empty send;
- `serialize()` is deterministic (sorted fields, one line per item), so the
  same selection produces the same prompt bytes;
- `manifest` records refs, field names, sizes and truncation — what was sent,
  by reference, with no values. That is what the audit log stores.

`classifyIntent` takes **no** context at all: the command text, the area, the
type of the focused entity and the timezone. Names and ids stay on the device;
the executor resolves them, so an ambiguous "Marta" is candidates, not a guess.

## Tasks

`Intelligence` exposes six operations. Each takes typed input and a
`ContextSelection`, sends one JSON-formatted request, and validates the reply
against a hand-written validator. Any `EntityRef` in a reply must be one that
was in the selection — a model cannot cite what it was not shown.

| Task | Output | Notes |
| --- | --- | --- |
| `classifyIntent` | `{ intent: object, confidence }` | opaque here; `@vixera/command`'s `parseIntent` decides if it is an `Intent` |
| `summarizeContext` | `{ summary, citedRefs }` | |
| `extractFacts` | `{ facts: [{ name, value, sourceRef }] }` | scalar values only |
| `compareContext` | `{ summary, differences: [{ aspect, left, right, refs }] }` | |
| `deriveSuggestions` | `{ suggestions: [{ text, kind: note\|consider, refs }] }` | **suggestions, never actions**; `kind: "execute"` is rejected |
| `answerQuestion` | `{ answer, citedRefs, confidence }` | |

`TaskRunner` is the one path to a provider — by convention: nothing in the type
system stops code from calling `provider.complete` directly, so "every model
call goes through the runner" is a review rule, checked by reading, not a
guarantee the compiler gives. The runner enforces the timeout (default 15 s) by
racing the call, so a provider that ignores its `AbortSignal` still times out;
forwards the caller's signal for cancellation, and refuses to send at all when
that signal is already aborted; refuses a remote provider when
`requireLocality: "local"` is set, before sending anything; consults the
capabilities a provider declares rather than decorating with them — a provider
without `structuredOutput` is refused, and a prompt past `maxInputTokens` (at
four bytes per token, system prompt included) is refused before it is sent;
accepts fenced JSON but nothing that is not one JSON value; hands each
validator the task's *input* as well as the reply, so a reply is checked against
the ask (facts for fields that were requested, differences citing refs from the
compared sides) and not only against a shape; and raises a distinct error class
per failure (`ModelUnavailableError`, `ModelTimeoutError`, `ModelCancelledError`,
`ModelOutputError`, `LocalityError`, `CapabilityError`), none of which carries
prompt or response text.

## Audit

Every run records a `ModelRequestAuditEvent`: task, provider, model, start
time, duration, outcome, token usage, prompt size in bytes, and the context
manifest. **No prompt, no context values, no output.** Sinks are injected;
the default discards. `InMemoryAuditSink` keeps the last N for a dev surface
or a test. A server can forward events to a per-user table with the same
guarantee.

## What a model may never do

- write to the spine — outputs are data; changes go through typed actions
  with the user in the loop (`docs/architecture.md`, ADR-012);
- call a provider API on its own — every provider call goes through
  `TaskRunner`, with a bounded selection, a timeout and an audit event (a
  convention enforced in review, see above);
- see a field that is not allow-listed, or cite a ref that was not sent.

## Adding a provider

Implement `ModelProvider`, declare honest `capabilities`, register it in the
process that holds its key (an Edge Function), and put nothing vendor-specific
above this package. The Field asks for "the default model", never for a brand.
