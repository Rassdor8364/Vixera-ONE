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
