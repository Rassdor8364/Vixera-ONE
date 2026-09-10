import assert from "node:assert/strict";
import { MockConnector } from "@vixera/sync";
import { buildRegistry } from "./connectors.ts";
import { oauthRedirectUri, readEnv, requireSupabase } from "./env.ts";

function envFrom(vars: Record<string, string>) {
  return readEnv((name) => vars[name]);
}

Deno.test("readEnv never throws; missing provider secrets leave the provider unconfigured", () => {
  const env = envFrom({});
  assert.equal(env.supabaseUrl, null);
  assert.equal(env.google, null);
  assert.equal(env.microsoft, null);
  assert.equal(env.plaid, null);
  assert.equal(env.functionsUrl, null);
  assert.equal(env.enableMockConnector, false);
  assert.throws(() => requireSupabase(env), { name: "EnvError" });
  assert.throws(() => oauthRedirectUri(env), { name: "EnvError" });

  const partial = envFrom({ GOOGLE_CLIENT_ID: "id-only", SUPABASE_URL: "https://x.supabase.co/" });
  assert.equal(partial.google, null);
  assert.equal(partial.functionsUrl, "https://x.supabase.co/functions/v1");
  assert.equal(oauthRedirectUri(partial), "https://x.supabase.co/functions/v1/connector-link/callback");
  const explicit = envFrom({ VIXERA_FUNCTIONS_URL: "https://vixera.example/fn/", SUPABASE_URL: "https://x.supabase.co" });
  assert.equal(explicit.functionsUrl, "https://vixera.example/fn");
});

Deno.test("registry: empty without configuration, mock only when enabled", () => {
  assert.deepEqual(buildRegistry(envFrom({})).providers(), []);
  assert.deepEqual(buildRegistry(envFrom({ VIXERA_ENABLE_MOCK_CONNECTOR: "false" })).providers(), []);
  const mock = new MockConnector();
  const registry = buildRegistry(envFrom({ VIXERA_ENABLE_MOCK_CONNECTOR: "true" }), { mock });
  assert.deepEqual(registry.providers(), ["mock"]);
  assert.equal(registry.get("mock"), mock);
});

Deno.test("registry: providers appear exactly when their secrets (and the callback URL) exist", () => {
  const full = envFrom({
    SUPABASE_URL: "https://x.supabase.co",
    GOOGLE_CLIENT_ID: "g",
    GOOGLE_CLIENT_SECRET: "gs",
    MICROSOFT_CLIENT_ID: "m",
    MICROSOFT_CLIENT_SECRET: "ms",
    MICROSOFT_TENANT: "organizations",
    PLAID_CLIENT_ID: "p",
    PLAID_SECRET: "ps",
    PLAID_ENV: "production",
  });
  assert.deepEqual(buildRegistry(full).providers().sort(), ["google", "microsoft", "plaid"]);
  assert.equal(full.plaid?.environment, "production");
  assert.equal(full.microsoft?.tenant, "organizations");

  const noCallback = envFrom({ GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "gs", PLAID_CLIENT_ID: "p", PLAID_SECRET: "ps" });
  assert.deepEqual(buildRegistry(noCallback).providers(), ["plaid"]);
  assert.equal(noCallback.plaid?.environment, "sandbox");

  const msOnly = envFrom({ SUPABASE_URL: "https://x.supabase.co", MICROSOFT_CLIENT_ID: "m", MICROSOFT_CLIENT_SECRET: "ms" });
  assert.deepEqual(buildRegistry(msOnly).providers(), ["microsoft"]);
  assert.equal(buildRegistry(msOnly).has("google"), false);
});
