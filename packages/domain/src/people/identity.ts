import type { PersonIdentityKind } from "../entities/person.ts";

/**
 * Identity normalization used to reconcile people across connectors without
 * pretending entity resolution is solved: exact normalized email / phone /
 * provider-id matches only. Fuzzy name matching is deliberately not here.
 */

export interface IdentityKey {
  readonly kind: PersonIdentityKind;
  readonly value: string;
}

/** RFC 5322 dot-atom, roughly: no whitespace, no angle brackets, quotes, commas, colons or a second @. */
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!LOCAL_PART.test(local) || local.length > 64) return null;
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain) && domain !== "localhost") return null;
  return `${local}@${domain}`;
}

/** Best-effort E.164: keeps a leading +, strips separators. Returns null when too short. */
export function normalizePhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7) return null;
  return (plus ? "+" : "") + digits;
}

export function providerIdentity(provider: string, id: string): string {
  return `${provider}:${id}`;
}

export function emailKey(raw: string): IdentityKey | null {
  const v = normalizeEmail(raw);
  return v ? { kind: "email", value: v } : null;
}

export function phoneKey(raw: string): IdentityKey | null {
  const v = normalizePhone(raw);
  return v ? { kind: "phone", value: v } : null;
}

/** "Eric Lindqvist" from "eric.lindqvist@studio.se" when no name was given. */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ");
}

/**
 * Parses "Name <addr@x>" / "addr@x" / "<addr@x>" into parts. The name is
 * everything before the LAST "<", with surrounding quotes and backslash
 * escapes removed, so `Eric "Studio" Lindqvist <eric@x>` keeps its sender
 * instead of being dropped.
 */
export function parseAddress(raw: string): { email: string; name: string | null } | null {
  const lt = raw.lastIndexOf("<");
  const gt = raw.lastIndexOf(">");
  if (lt >= 0 && gt > lt) {
    const email = normalizeEmail(raw.slice(lt + 1, gt));
    if (!email) return null;
    const name = unquote(raw.slice(0, lt));
    return { email, name: name.length ? name : null };
  }
  const email = normalizeEmail(raw);
  return email ? { email, name: null } : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const inner = /^"(.*)"$/s.exec(trimmed)?.[1] ?? trimmed;
  return inner.replace(/\\(.)/g, "$1").trim();
}

/**
 * Splits a header into addresses. Commas inside quotes and angle brackets are
 * respected; RFC 2822 groups (`Team: a@x, b@x;`) are flattened to their
 * members; an unbalanced quote falls back to a plain comma split rather than
 * swallowing the rest of the header into one bogus address.
 */
export function parseAddressList(raw: string | null | undefined): { email: string; name: string | null }[] {
  if (!raw) return [];
  const parts = splitAddresses(raw) ?? raw.split(",");
  return parts.map(parseAddress).filter((a): a is { email: string; name: string | null } => a !== null);
}

/** Quote- and bracket-aware split; null when a quote is left open at the end. */
function splitAddresses(raw: string): string[] | null {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = false;
  let escaped = false;
  for (const ch of raw) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (quoted && ch === "\\") {
      cur += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch === "<") angle = true;
    else if (!quoted && ch === ">") angle = false;
    if (!quoted && !angle && ch === ":" && !cur.includes("@")) {
      // `Group name:` — drop the label, keep parsing the members.
      cur = "";
      continue;
    }
    if (!quoted && !angle && (ch === "," || ch === ";")) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (quoted) return null;
  if (cur.trim()) parts.push(cur);
  return parts;
}
