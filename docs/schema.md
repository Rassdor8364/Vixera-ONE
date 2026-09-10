# Database schema (context spine)

Source of truth: `supabase/migrations/*.sql`. This page explains the shape; the
SQL is authoritative. `pnpm db:verify` applies every migration to a throwaway
Postgres and asserts the invariants listed at the end.

## Invariants

* Every table in `public` has `user_id uuid not null references users(id)`
  (`users.id` is the user id itself). Enforced by `scripts/sql/verify.sql`.
* Every table has RLS enabled and user-scoped policies (`user_id = auth.uid()`).
  The service role bypasses RLS and must scope its own queries.
* Connector rows are keyed by natural keys so re-syncing is idempotent.
* Child rows can only reference parents owned by the same user: every foreign
  key to `devices`, `connector_accounts`, `people`, `threads`, `documents` and
  `money_accounts` is a composite `(user_id, id)` key (nullable ones use
  `on delete set null (column)` so `user_id` is never nulled).
* The graph is one typed edge table; polymorphic targets are validated by trigger,
  and so are `context_events.subject`, `conclusions.subject` and `handoffs.focus`.
* Clients (the `authenticated` role) cannot write `connector_accounts` except
  `label`, `status`, `metadata`; cannot write `connector_sync_states` except
  `enabled`; and cannot write `action_requests` at all. Those rows are the
  server's (connector-link, the sync engine, action-dispatch).

## Entities

| Table | Purpose | Natural key |
| --- | --- | --- |
| `users` | profile row per auth user | `id` |
| `devices` | installed Vixera instances (handoff endpoints, ingestion provenance) | `id` |
| `connector_accounts` | one provider account (Gmail #1, Gmail #2, Graph, Plaid item) | `(user_id, provider, external_account_id)` |
| `connector_sync_states` | per (account, capability) cursor / status / error | `(connector_account_id, capability)` |
| `people` | normalized humans | `id` |
| `person_identities` | email / phone / provider ids → person | `(user_id, kind, value)` |
| `threads` | something happening in the user's life/work | `id` |
| `documents` | document **context** (no rendering state) | `id`; also `(user_id, content_hash)` index |
| `mail_messages` | mail as input to context | `(user_id, connector_account_id, external_id)` |
| `money_accounts` | bank accounts + balances | `(user_id, connector_account_id, external_id)` |
| `money_transactions` | signed transactions (negative = leaves account) | `(user_id, connector_account_id, external_id)` |
| `time_events` | calendar events | `(user_id, connector_account_id, external_calendar_id, external_id)` |
| `context_events` | things that happened; input to NOW/Quiet | `(user_id, dedupe_key)` |
| `conclusions` | Vixera's own statements about an entity | `id` |
| `ingest_items` | explicit share / capture / drop queue | `id` |
| `handoffs` | Vixera-owned cross-device context transfer | `id` |
| `action_requests` | server action audit + idempotency | `(user_id, idempotency_key)` |
| `relationships` | the context graph | `(user_id, from_type, from_id, kind, to_type, to_id)` |

### Enumerations

`entity_type`, `relationship_kind`, `provider_id`, `connector_capability`,
`connector_account_status`, `credential_location`, `sync_status`, `attention`,
`handoff_state`, `ingest_kind`, `ingest_source`, `ingest_status`,
`document_source`, `money_account_type`, `time_event_status`, `thread_status`,
`action_request_status`, `platform`. Each is mirrored by a TypeScript union in
`packages/domain`; `schema-sync.test.ts` fails if they drift.

## The graph

```
relationships(from_type, from_id) --kind--> (to_type, to_id)
```

* `vx_relate(...)` inserts idempotently (raises confidence on conflict).
* `vx_validate_relationship()` (trigger) rejects edges whose endpoints do not exist
  **for the same user**.
* `vx_on_entity_deleted('<type>')` (trigger on every entity table) deletes dangling
  edges, context events and conclusions.
* `vx_neighbors(type, id)` returns edges in both directions.

Kinds: `relates_to`, `belongs_to`, `originated_from`, `has_person`, `has_time`,
`has_document`, `has_money`, `has_mail`, `replaces`, `mentions`, `attached_to`, `about`.

## JSON column shapes

| Column | Shape |
| --- | --- |
| `mail_messages.to_addresses`, `cc_addresses` | `[{ "email", "name", "personId"? }]` |
| `mail_messages.attachments` | `[{ "attachmentId", "filename", "mimeType", "sizeBytes" }]` |
| `time_events.organizer`, `participants[]` | `{ "email", "name", "response", "isOrganizer", "isSelf", "personId"? }` |
| `documents.location` | `{ "kind": "device_path" \| "storage" \| "provider" \| "url" \| "none", ... }` |
| `documents.source_ref` | provider ids, e.g. `{ "connectorAccountId", "messageExternalId", "attachmentId" }` |
| `connector_sync_states.checkpoint` | provider cursor (`{ historyId }`, `{ deltaLink }`, `{ cursor }`) |
| `handoffs.praxion_location` | `{ "page", "position", "selectionText" }` |

Numeric money columns (`numeric(20,4)`) are handled as decimal **strings** in
TypeScript; never floats.

## Credentials

`connector_accounts.credential_ref` is an opaque Vault id. `vx_credential_put/get/delete`
(security definer, `service_role` only) are the only way in or out, and they are
bound to accounts: `get`/`delete` only act on a ref that some account row carries,
and `put` with an explicit ref refuses a ref that belongs to another account.
`pnpm db:verify` exercises them against a plaintext Vault stand-in. See
`credentials.md`.

## Storage and Realtime

Bucket `artifacts` (private): objects live under `<user_id>/…`; policies allow only
the owner. Realtime publication includes `context_events`, `handoffs`, `threads`,
`ingest_items`, `connector_sync_states`, `action_requests` (RLS applies to
subscriptions).

## Scheduled sync

`vx_trigger_scheduled_sync()` posts to the `connector-sync` Edge Function through
`pg_net`, every 10 minutes via `pg_cron`. The function URL and shared secret are
read from Vault (`vixera_functions_url`, `vixera_sync_secret`); see `supabase.md`.

## Verified invariants (`scripts/sql/verify.sql`)

1. Every table has `user_id`.
2. Every table has RLS and at least one policy.
3. The dev user sees seeded rows and can write its own rows; it cannot write
   `credential_ref`, sync checkpoints or `action_requests`. Another authenticated
   user sees nothing, cannot insert rows for the dev user, cannot reference the
   dev user's parents through any foreign key, and cannot call Vault functions.
4. Dangling and self relationships are rejected; `vx_relate` is idempotent;
   deleting an entity removes its edges and conclusions.
5. Natural-key upserts and context-event dedupe do not duplicate rows.
6. Dangling subjects on `context_events`, `conclusions` and `handoffs.focus` are rejected.
7. As `service_role`, `vx_credential_put/get/delete` round-trip a credential,
   refuse another account's ref, and `vx_connector_account_disconnect` removes it.
