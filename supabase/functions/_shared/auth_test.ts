import assert from "node:assert/strict";
import { DEV_USER_ID } from "@vixera/domain";
import { authenticate, bearerToken, type AuthClient } from "./auth.ts";
import { HttpError } from "./http.ts";

function fakeAuth(valid: Record<string, string>): AuthClient {
  return {
    getUser(token) {
      const id = valid[token];
      return Promise.resolve(id ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: "invalid JWT" } });
    },
  };
}

const auth = fakeAuth({ "good-token": DEV_USER_ID, "weird-token": "not-a-uuid" });
const req = (headers: Record<string, string>) => new Request("https://x.test/functions/v1/action-dispatch", { method: "POST", headers });

Deno.test("authenticate: missing bearer is 401", async () => {
  await assert.rejects(() => authenticate(req({}), auth), (err: unknown) => err instanceof HttpError && err.status === 401 && err.code === "unauthorized");
  await assert.rejects(() => authenticate(req({ authorization: "Basic abc" }), auth), (err: unknown) => err instanceof HttpError && err.status === 401);
  await assert.rejects(() => authenticate(req({ authorization: "Bearer " }), auth), (err: unknown) => err instanceof HttpError && err.status === 401);
});

Deno.test("authenticate: invalid token is 401, even when the auth client throws", async () => {
  await assert.rejects(() => authenticate(req({ authorization: "Bearer bad-token" }), auth), (err: unknown) => err instanceof HttpError && err.status === 401);
  await assert.rejects(() => authenticate(req({ authorization: "Bearer weird-token" }), auth), (err: unknown) => err instanceof HttpError && err.status === 401);
  const throwing: AuthClient = { getUser: () => Promise.reject(new Error("network")) };
  await assert.rejects(() => authenticate(req({ authorization: "Bearer good-token" }), throwing), (err: unknown) => err instanceof HttpError && err.status === 401);
});

Deno.test("authenticate: a valid token yields the user id from Auth, never from the body", async () => {
  const identity = await authenticate(req({ Authorization: "bearer good-token" }), auth);
  assert.equal(identity.userId, DEV_USER_ID);
  assert.equal(bearerToken(req({ authorization: "Bearer   spaced  " })), "spaced");
});
