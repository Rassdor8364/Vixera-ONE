import { describe, expect, it } from "vitest";
import { displayNameFromEmail, normalizeEmail, normalizePhone, parseAddress, parseAddressList } from "./identity.ts";

describe("identity normalization", () => {
  it("lower-cases and validates emails", () => {
    expect(normalizeEmail("  Eric.Lindqvist@Studio.SE ")).toBe("eric.lindqvist@studio.se");
    expect(normalizeEmail("nope")).toBeNull();
    expect(normalizeEmail("@x.com")).toBeNull();
  });
  it("normalizes phones loosely toward E.164", () => {
    expect(normalizePhone("+46 (70) 123-45 67")).toBe("+46701234567");
    expect(normalizePhone("123")).toBeNull();
  });
  it("derives a display name from an email", () => {
    expect(displayNameFromEmail("eric.lindqvist@studio.se")).toBe("Eric Lindqvist");
  });
  it("parses RFC-style address headers", () => {
    expect(parseAddress('"Eric Lindqvist" <Eric@studio.se>')).toEqual({ email: "eric@studio.se", name: "Eric Lindqvist" });
    expect(parseAddress("Eric Lindqvist <eric@studio.se>")).toEqual({ email: "eric@studio.se", name: "Eric Lindqvist" });
    expect(parseAddress("eric@studio.se")).toEqual({ email: "eric@studio.se", name: null });
    expect(parseAddressList('"Ruiz, Marta" <marta@ruiz.law>, priya@northwind.com')).toEqual([
      { email: "marta@ruiz.law", name: "Ruiz, Marta" },
      { email: "priya@northwind.com", name: null },
    ]);
  });
});

describe("address parsing survives real headers", () => {
  it("keeps a sender whose display name contains quotes", () => {
    expect(parseAddress('Eric "Studio" Lindqvist <eric@studio.se>')).toEqual({ email: "eric@studio.se", name: 'Eric "Studio" Lindqvist' });
    expect(parseAddress('"Ruiz, Marta" <m@r.law>')).toEqual({ email: "m@r.law", name: "Ruiz, Marta" });
    expect(parseAddress('"O\\"Brien" <o@x.com>')).toEqual({ email: "o@x.com", name: 'O"Brien' });
  });

  it("flattens RFC 2822 groups to their members instead of inventing a person named after the group", () => {
    expect(parseAddressList("Team: a@x.com, b@x.com;")).toEqual([{ email: "a@x.com", name: null }, { email: "b@x.com", name: null }]);
    expect(parseAddressList("Accounts: Ann <ann@x.com>; Bob <bob@y.com>")).toEqual([{ email: "ann@x.com", name: "Ann" }, { email: "bob@y.com", name: "Bob" }]);
  });

  it("an unbalanced quote does not swallow the rest of the header", () => {
    const parsed = parseAddressList('"Ruiz, Marta <m@r.law>, priya@northwind.com');
    expect(parsed.map((a) => a.email)).toEqual(["m@r.law", "priya@northwind.com"]);
  });

  it("rejects local parts that are not addresses", () => {
    for (const bad of ["eric lindqvist@studio.se", "<eric>@studio.se", "a@b@studio.se", '"ruiz, marta <m@r.law>, priya@northwind.com', "team: a@x.com"]) {
      expect(normalizeEmail(bad), bad).toBeNull();
    }
    expect(normalizeEmail("Eric.Lindqvist+inv@Studio.SE")).toBe("eric.lindqvist+inv@studio.se");
  });
});
