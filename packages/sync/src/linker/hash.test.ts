import { describe, expect, it } from "vitest";
import { SEPARATOR, fnv1a, hashParts } from "./hash.ts";

describe("fnv1a", () => {
  it("matches the reference FNV-1a 32-bit vectors", () => {
    expect(fnv1a("")).toBe("811c9dc5");
    expect(fnv1a("a")).toBe("e40c292c");
    expect(fnv1a("foobar")).toBe("bf9cf968");
  });

  it("is stable and sensitive to every part", () => {
    const base = hashParts("Northwind kickoff", "2026-09-11T14:00:00.000Z", "2026-09-11T15:00:00.000Z", "confirmed");
    expect(base).toBe(hashParts("Northwind kickoff", "2026-09-11T14:00:00.000Z", "2026-09-11T15:00:00.000Z", "confirmed"));
    expect(base).not.toBe(hashParts("Northwind kickoff", "2026-09-11T15:00:00.000Z", "2026-09-11T16:00:00.000Z", "confirmed"));
    expect(base).not.toBe(hashParts("Northwind kickoff", "2026-09-11T14:00:00.000Z", "2026-09-11T15:00:00.000Z", "cancelled"));
    expect(hashParts(null, undefined, 1)).toBe(fnv1a(`${SEPARATOR}${SEPARATOR}1`));
    expect(hashParts("ab", "c")).not.toBe(hashParts("a", "bc"));
  });
});
