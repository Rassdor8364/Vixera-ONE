import { describe, expect, it } from "vitest";
import { canonicalDecimal, decimalFromNumber, negateDecimal } from "./decimal.ts";

describe("decimal strings", () => {
  it("canonicalizes to at least two fraction digits and no negative zero", () => {
    expect(canonicalDecimal("12400")).toBe("12400.00");
    expect(canonicalDecimal("12.5")).toBe("12.50");
    expect(canonicalDecimal("0.125")).toBe("0.125");
    expect(canonicalDecimal("007.10")).toBe("7.10");
    expect(canonicalDecimal("-0")).toBe("0.00");
    expect(canonicalDecimal("-0.00")).toBe("0.00");
    expect(() => canonicalDecimal("12,4")).toThrow(/decimal/);
    expect(() => canonicalDecimal("1e3")).toThrow(/decimal/);
  });

  it("formats provider JSON numbers without float drift", () => {
    expect(decimalFromNumber(12400)).toBe("12400.00");
    expect(decimalFromNumber(6.4)).toBe("6.40");
    expect(decimalFromNumber(23631.9805)).toBe("23631.9805");
    expect(decimalFromNumber(-2400)).toBe("-2400.00");
    expect(decimalFromNumber(1e-7)).toBe("0.0000001");
    expect(() => decimalFromNumber(Number.NaN)).toThrow(/finite/);
    expect(() => decimalFromNumber(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it("negates as a string", () => {
    expect(negateDecimal("2400.00")).toBe("-2400.00");
    expect(negateDecimal("-12400.00")).toBe("12400.00");
    expect(negateDecimal("0.00")).toBe("0.00");
    expect(negateDecimal("-0")).toBe("0.00");
    expect(negateDecimal("0.1")).toBe("-0.10");
  });
});
