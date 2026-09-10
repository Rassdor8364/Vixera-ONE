/**
 * Signed, expiring OAuth state tokens for `connector-link`.
 *
 *   token = base64url(JSON{ userId, provider, exp, nonce }) + "." + base64url(HMAC-SHA256(payload))
 *
 * The state carries the identity of the user who started the link: the
 * provider redirects the system browser to the callback without a Vixera
 * session, so the signed state is the ONLY thing that ties the callback to
 * a user. Tampering, a foreign key or expiry all reject.
 */
import { isUuid, type UserId } from "@vixera/domain";
import type { FunctionEnv } from "./env.ts";
import { EnvError } from "./env.ts";

export type LinkProvider = "google" | "microsoft";

export interface LinkState {
  readonly userId: UserId;
  readonly provider: LinkProvider;
  /** Unix epoch milliseconds. */
  readonly exp: number;
  readonly nonce: string;
}

export const LINK_STATE_TTL_MS = 10 * 60_000;

export class LinkStateError extends Error {
  constructor(readonly reason: "malformed" | "signature" | "expired" | "payload") {
    super(`Invalid link state (${reason})`);
    this.name = "LinkStateError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(data)));
}

/**
 * The HMAC key: `VIXERA_LINK_STATE_SECRET` when set, otherwise a key derived
 * from the service role key (HMAC of a fixed label) so a deployment that
 * forgot the secret still signs states — with a key that never leaves the
 * server and is never the service role key itself.
 */
export async function linkStateSecret(env: FunctionEnv): Promise<string> {
  if (env.linkStateSecret) return env.linkStateSecret;
  if (!env.supabaseServiceRoleKey) throw new EnvError("VIXERA_LINK_STATE_SECRET");
  return base64UrlEncode(await hmac(env.supabaseServiceRoleKey, "vixera-one:link-state:v1"));
}

export async function signLinkState(secret: string, input: { userId: UserId; provider: LinkProvider }, now: Date, ttlMs = LINK_STATE_TTL_MS): Promise<{ token: string; expiresAt: string }> {
  const state: LinkState = { userId: input.userId, provider: input.provider, exp: now.getTime() + ttlMs, nonce: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))) };
  const payload = base64UrlEncode(encoder.encode(JSON.stringify(state)));
  const sig = base64UrlEncode(await hmac(secret, payload));
  return { token: `${payload}.${sig}`, expiresAt: new Date(state.exp).toISOString() };
}

export async function verifyLinkState(secret: string, token: string, now: Date): Promise<LinkState> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new LinkStateError("malformed");
  const [payload, sig] = parts as [string, string];
  const expected = await hmac(secret, payload);
  let given: Uint8Array;
  try {
    given = base64UrlDecode(sig);
  } catch {
    throw new LinkStateError("malformed");
  }
  if (!timingSafeEqual(expected, given)) throw new LinkStateError("signature");
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(base64UrlDecode(payload)));
  } catch {
    throw new LinkStateError("payload");
  }
  if (!isLinkState(parsed)) throw new LinkStateError("payload");
  if (parsed.exp <= now.getTime()) throw new LinkStateError("expired");
  return parsed;
}

export function isLinkProvider(value: unknown): value is LinkProvider {
  return value === "google" || value === "microsoft";
}

function isLinkState(value: unknown): value is LinkState {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.userId === "string" && isUuid(v.userId) && isLinkProvider(v.provider) && typeof v.exp === "number" && Number.isFinite(v.exp) && typeof v.nonce === "string" && v.nonce.length > 0;
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}
