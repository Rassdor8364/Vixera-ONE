/**
 * Contract version arithmetic for the Praxion local contract.
 *
 * Rule: a client and a server are compatible when their MAJOR versions are
 * equal and the server's MINOR is greater than or equal to the client's.
 * Servers add endpoints/fields in minor releases (clients written against an
 * older minor still work); breaking changes bump the major. Invalid version
 * strings are never compatible. Patch is informational only.
 */
export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Parses "MAJOR.MINOR.PATCH" (optional prerelease/build suffix). Null when malformed. */
export function parseSemver(value: string): Semver | null {
  if (typeof value !== "string") return null;
  const m = SEMVER_RE.exec(value.trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** Major version of a contract string, or null when the string is malformed. */
export function contractMajor(value: string): number | null {
  return parseSemver(value)?.major ?? null;
}

/**
 * True when a client built against `client` can talk to a server announcing
 * `server`: same major, server minor >= client minor.
 */
export function isContractCompatible(server: string, client: string): boolean {
  const s = parseSemver(server);
  const c = parseSemver(client);
  if (!s || !c) return false;
  return s.major === c.major && s.minor >= c.minor;
}
