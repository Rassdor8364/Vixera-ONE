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

export function normalizeEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
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

/** Parses "Name <addr@x>" / "addr@x" / "<addr@x>" into parts. */
export function parseAddress(raw: string): { email: string; name: string | null } | null {
  const m = raw.match(/^\s*(?:"?([^"<]*)"?\s*)?<([^>]+)>\s*$/);
  if (m) {
    const email = normalizeEmail(m[2] ?? "");
    if (!email) return null;
    const name = (m[1] ?? "").trim();
    return { email, name: name.length ? name : null };
  }
  const email = normalizeEmail(raw);
  return email ? { email, name: null } : null;
}

/** Splits a comma-separated header into addresses; commas inside quotes are respected. */
export function parseAddressList(raw: string | null | undefined): { email: string; name: string | null }[] {
  if (!raw) return [];
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of raw) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(parseAddress).filter((a): a is { email: string; name: string | null } => a !== null);
}
