# currentUser() strategy

`currentUser()` in `packages/domain/src/identity/current-user.ts` is the single
source of truth for "who is using Vixera right now". Nothing else in the codebase
may hard-code an email, a machine account, or a UUID.

## Today (Phase 1, one user)

```ts
setCurrentUserProvider(devUserProvider);   // at app / function startup
const { id } = currentUser();              // DEV_USER_ID
```

`DEV_USER_ID = 00000000-0000-4000-8000-000000000001` is a fixed UUID seeded into
`auth.users` by `supabase/seed.sql`. The seed's email (`dev@vixera.local`) is only a
login credential for the local auth server; it is never used as a key. The user's
real email, Windows account name and machine are never consulted.

## Where the id flows

* **Stores** are bound to one user id at construction:
  `new SupabaseSpineStore(client, currentUser().id)`. No store method takes a user id.
* **RLS** enforces `user_id = auth.uid()`; the JWT's `sub` is the same UUID.
* **Edge Functions** derive the user from the verified JWT (`supabase.auth.getUser()`)
  and construct a `SessionCurrentUserProvider` for the request. Cron-triggered
  syncs iterate users from `connector_accounts` with the service role, setting the
  provider per user before running the engine.
* **Rows** always carry `user_id` (seam 1), written from the store's bound id.

## Later (public product)

Replace the provider, not the call sites:

```ts
setCurrentUserProvider(new SupabaseSessionCurrentUserProvider(client));
```

The session provider throws `NoCurrentUserError` until a session exists; the Field
shows the sign-in state. Multi-account-per-provider, RLS and `user_id` everywhere
mean nothing else changes when the second human arrives.

## Rules

1. Never read `process.env.USER`, `whoami`, hostnames or emails to decide identity.
2. Never accept a user id from provider data or from a client payload.
3. Tests set a static provider explicitly (`setCurrentUserProvider(devUserProvider)`).
