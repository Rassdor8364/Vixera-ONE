# Smoke tests against real providers and the live project

Everything in this repository is verified against fixtures, an in-memory
spine, a local PostgREST and a throwaway PostgreSQL. Nothing here has run
against a real Google, Microsoft or Plaid account, and the live Supabase
project is three schema migrations behind this branch. This page is the list of
procedures that turn "fixture-tested" into "integration-tested", in the order
they must run, with what each proves and what it cannot.

Status vocabulary (used everywhere in `docs/`): **Implemented** (code exists,
type-checks), **Fixture-tested** (unit / conformance tests against fakes),
**Integration-tested** (ran against the real service once, by a person),
**Device-tested** (ran on the target hardware), **Production-verified** (ran
against the live project with a real user's data).

Credentials never enter this repository. Every step below assumes the person
running it holds them in the provider console and in `supabase secrets`.

## 0. Bring the live project up to date — Production-verified: no

The live project (`uhdlacchajiblhmgasjg`) has migrations 1–8 applied.
Migrations 9 (`realtime_replica_identity`), 10 (`ingest_attempts`), 11
(`handoff_focus_and_status`), 12 (`sync_state_reconcile`) and 13
(`sync_state_error_code`) are on this branch only. Until 9 is applied the
Realtime DELETE exposure it closes is live; until 10 is applied
`ingest.submit` fails on insert (the `attempts` column is missing); until 12
is applied a full resync fails writing its `reconcile` state; until 13 is
applied every sync fails at its end, writing `last_error_code`.

```bash
supabase link --project-ref uhdlacchajiblhmgasjg
supabase db push                          # migrations 9–13
SUPABASE_ACCESS_TOKEN=sbp_… scripts/deploy-functions.sh uhdlacchajiblhmgasjg
```

Then in the dashboard: Auth → Email Templates → *Reset Password* must include
`{{ .Token }}` (`docs/supabase.md` → Auth); without it the recover-by-code
screen can never succeed.

Proves: schema and functions match the branch. Cannot prove: anything about
providers.

## 1. Sign-in lifecycle — Device-tested: no

On a Windows machine with the installer from `dist/installers`:

1. Create an account from the door, open the confirmation link, sign in with
   "Keep me signed in" off; quit; relaunch → the door again.
2. Sign in with it on; relaunch → the Field. Sign in on a second device (or
   the Android companion); sign out on the first → the second stays signed in
   (`scope: "local"`).
3. "Forgot?" → code from the email → new password → the Field opens.
4. `credential_get("supabase.session")` after sign-out returns nothing
   (`docs/credentials.md`); the Credential Manager shows only
   `ai.vixera.one/*` entries.

Proves: F1–F4 of the auth work on real Supabase Auth. Cannot prove: the
Android Keystore path (needs a device, step 5).

## 2. Google — Integration-tested: no

Needs a Google Cloud OAuth client (Web application) with the redirect URI
`https://uhdlacchajiblhmgasjg.supabase.co/functions/v1/connector-link/callback`,
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `supabase secrets`, and a test
Google account whose mailbox and calendar you can edit.

1. Quiet → Sources → Connect Google. Untick the Calendar scope on the consent
   screen. Expect: one `connector_accounts` row with `capabilities = ["mail"]`
   (scope-derived), `connector_sync_states` for mail only.
2. Disconnect; connect again with both scopes. Expect: the same row (found by
   `(provider, externalAccountId)`), both capabilities, the mail checkpoint
   kept.
3. `POST connector-sync` with the user JWT. Expect: `report.outcomes` with
   `mail: ok` and `calendar: ok`, `mail_messages` rows for the last 30 days
   **without** anything in Trash, Spam, Drafts or Chats, sent mail present
   with `from = null`. Check `context_events` for `mail.received` per message.
4. In Gmail: trash one message, star nothing, move one to Spam, send one, and
   restore one from Trash. Sync again. Expect: the trashed and spammed rows
   gone (with their context events), the sent one present, the restored one
   back — with **zero** `messages.get` calls for the trash/spam moves (check
   the function log for `gmail.history.folded`).
5. In Calendar: create a weekly series with three instances inside the window,
   sync, then delete the whole series. Sync again. Expect: all three
   `time_events` gone (`calendar.series.cancelled` in the log).
6. Revoke the app at myaccount.google.com/permissions. Sync. Expect: account
   `needs_reauth` with a `last_error` that names `invalid_grant` and carries
   no token; the Field offers reconnect; reconnecting restores `active` and
   keeps the checkpoints.
7. Rotate the client secret in the console without updating `supabase
   secrets`. Sync. Expect: the account stays `active`; the sync state is
   `error` with a message naming the OAuth client configuration; fix the
   secret; the next sync recovers without a re-link.
8. Delete one synced message for good (Trash → Delete forever), then kill the
   checkpoint: `update connector_sync_states set checkpoint = '{"historyId":"1"}'`
   on the mail row. Sync. Expect: `gmail.history.expired`, a backfill with
   `fullResync`, then `sync: full resync reconciled` with `removed: 1`, the
   purged row gone with its context events, and nothing older than 30 days
   touched (ADR-017).

Cannot prove offline: Gmail's exact history record shapes for label moves,
and whether Google reports a cancelled recurring master under
`singleEvents=true` as the code assumes (the reference says instances only;
the code handles both shapes). Step 5 settles it.

## 3. Microsoft — Integration-tested: no

Needs an Entra app registration (Web, same redirect URI), `MICROSOFT_CLIENT_ID`
/ `MICROSOFT_CLIENT_SECRET`, and a Microsoft 365 or Outlook.com test account.

1. Connect. Expect: one row, `["mail", "calendar"]`.
2. Sync. Expect: inbox rows for 30 days with text bodies (no HTML tags in
   `body_text`), attachment `documents` with `location.kind = "provider"`;
   the calendar rows for −30 … +90 days. All-day events created in a
   UTC+13/+14 zone (set the account's time zone to Auckland and create one)
   land on their own civil date.
3. Let the backfill run under a tight budget (`connector-sync` with a
   `budgetMs` override, or a mailbox with thousands of messages). Expect:
   the run reports `interrupted`, the checkpoint holds
   `{ backfill: { nextLink } }`, and the next run resumes from it instead of
   starting over.
4. Wait longer than Graph's delta-token lifetime (or revoke the token in the
   Entra portal and re-consent). Sync. Expect: a `microsoft.mail.delta.expired`
   or `checkpoint.rejected` log line and a full re-list, not a permanent
   `unknown` error.
5. Revoke consent at myaccount.microsoft.com → the account goes
   `needs_reauth` after exactly one token call (`microsoft.credential.refresh`
   once in the log).
6. Delete one synced inbox message for good, then point the mail checkpoint at
   a dead link (`{"deltaLink":"https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=dead"}`).
   Sync. Expect: `microsoft.mail.delta.expired` or
   `microsoft.mail.checkpoint.rejected`, a restarted backfill, then `sync: full
   resync reconciled` with `removed: 1` (ADR-017).

Cannot prove offline: whether a stored `$skiptoken` is still honoured hours
later (the connector assumes it and falls back to a restart), and the
Windows zone names a given tenant emits (the table covers CLDR 2021a plus
two legacy ids).

## 4. Plaid — Integration-tested: no

Needs `PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV=sandbox`, and Hosted Link
enabled for the client.

1. Connect bank → the hosted link opens → sandbox institution `user_good` /
   `pass_good`. Expect: one row, `money_accounts` with balances as strings
   (`"1234.56"`, never a float), `money_transactions` with `authorizedAt`
   null unless the sandbox sent `authorized_datetime` with a time of day.
2. Sync twice. Expect: the second run changes nothing but account balances
   (`inserted 0, deleted 0`); the checkpoint is the `has_more: false` cursor.
3. Sandbox `/sandbox/item/fire_webhook` or `/sandbox/transactions/create`,
   then sync. Expect: the delta applied, a pending→posted transition leaving
   one row.
4. `/sandbox/item/reset_login` → sync → `needs_reauth`, with
   `metadata.reauthCode = "ITEM_LOGIN_REQUIRED"` on the row. Quiet → Sources
   shows "Reconnect" on that account: it opens Link in update mode (the
   `/link/token/create` call carries `access_token` and no `products`); finish
   with `user_good` / `pass_good`, press "I finished linking the bank". Expect:
   the **same** row back to `active` with its checkpoint (the next sync is a
   no-op, not a re-backfill), still one `connector_accounts` row, no
   `/item/public_token/exchange` in the function log, `reauthCode` gone.
   Pressing "I finished" before finishing Link must answer 409, and closing
   Link with an error must answer 400 and leave the row parked.
5. `/sandbox/item/remove` (the Item is gone), sync → `needs_reauth` with
   `reauthCode = "ITEM_NOT_FOUND"`; "Reconnect" must be refused with
   `relink_impossible` and the message to disconnect and connect again.

## 5. Android companion — Device-tested: no

On a device with the APK from `dist/installers`:

1. Sign in; force-stop; relaunch → still signed in (Keystore-backed session).
2. Share a PDF from Files and a screenshot from Photos → both appear in Files
   → Arriving, then as documents. Share a 200 MB video → refused with the
   size message, nothing in the cache directory afterwards.
3. Enable a device backup, restore to another device → the app asks to sign
   in (`allowBackup="false"`: no session travels).
4. Airplane mode, share a file, disable airplane mode → the item goes from
   `received` to `processed` without touching it (the Field retries
   `ingest-process` when the connection returns).

## 6. Release — Production-verified: no

`pnpm release:verify` passes on artifacts built from a clean tree at one
commit; that is what this branch ships. Installing the Windows installer over
a previous version and the APK over a previous APK (same signer) is the part
no script can do.

## What the fixture suites already cover

So this page is not read as "nothing is tested": 702 vitest tests across the
packages, the live PostgREST suite (119, real PostgREST 12.2.3 over a real
PostgreSQL), 55 Deno tests for the Edge Functions and 37 Rust tests cover every
branch above against fakes built from recorded provider shapes. What they
cannot do is disagree with the provider — that is what the steps above are
for.
