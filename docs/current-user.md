# currentUser() strategy

`currentUser()` in `packages/domain/src/identity/current-user.ts` is the single
source of truth for "who is using Vixera right now". Nothing else in the codebase
may hard-code an email, a machine account, or a UUID.

## Today (Phase 1, one user)

```ts
setCurrentUserProvider(provider);          // once, at app startup
const { id } = currentUser();
```

Two providers exist:

* **Production Field** — `SessionCurrentUserProvider`
  (`apps/desktop/src/bootstrap/identity.ts`) reads the user id of the Supabase
  session and throws `NoCurrentUserError` while signed out; the Field shows the
  sign-in form (email + password into an existing user, no sign-up).
* **Dev-fixture mode / tests** — `StaticCurrentUserProvider` with
  `DEV_USER_ID` (`devUserProvider`), installed by `installDevIdentity` when
  `VITE_VIXERA_DEV_FIXTURES=true`, and by tests explicitly.

`DEV_USER_ID = 00000000-0000-4000-8000-000000000001` is a fixed UUID seeded into
`auth.users` by `supabase/seed.sql`. The seed's email (`dev@vixera.local`) is only a
login credential for the local auth server; it is never used as a key. The user's
real email, Windows account name and machine are never consulted.

## Where the id flows

* **Stores** are bound to one user id at construction:
  `new SupabaseSpineStore(client, currentUser().id)`. No store method takes a user id.
* **RLS** enforces `user_id = auth.uid()`; the JWT's `sub` is the same UUID.
* **Edge Functions** derive the user from the verified Bearer token
  (`authenticate()` in `supabase/functions/_shared/auth.ts`, `auth.getUser(token)`
  against the anon client) and thread it explicitly into a `SupabaseSpineStore`
  bound to that id. `setCurrentUserProvider()` is never called in a function: one
  isolate serves many users, so a process-global provider would be a data-boundary
  bug. Cron-triggered syncs iterate users from `connector_accounts` with the service
  role and build one user-bound store per user. The OAuth callback carries the
  user id in an HMAC-signed, expiring state token (`_shared/state.ts`).
* **Rows** always carry `user_id` (seam 1), written from the store's bound id.

## Later (public product)

Nothing at the call sites changes when the second human arrives: the session
provider is already the production path, RLS and `user_id` everywhere hold, and
multi-account-per-provider is the data model. What is missing is only the
onboarding around it (sign-up, invitations), which is out of Phase 1 scope.

## Rules

1. Never read `process.env.USER`, `whoami`, hostnames or emails to decide identity.
2. Never accept a user id from provider data or from a client payload.
3. Tests set a static provider explicitly (`setCurrentUserProvider(devUserProvider)`).
