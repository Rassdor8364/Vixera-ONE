/**
 * Decimal-string helpers for money values.
 *
 * Money never travels as a float past the connector boundary. Providers hand
 * us JSON numbers (Plaid) or already-formatted strings (mock fixtures); these
 * helpers turn either into a canonical signed decimal string with at least two
 * fraction digits ("12400.00", "-2400.00", "0.005"), and negate such strings
 * without ever going through floating point arithmetic.
 */
import { ConnectorError } from "@vixera/domain";

const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/** Canonical form: optional "-", digits, at least two fraction digits, no "-0". */
export function canonicalDecimal(value: string): string {
  const trimmed = value.trim();
  if (!DECIMAL_RE.test(trimmed)) {
    throw new ConnectorError("invalid_response", `Not a decimal string: ${JSON.stringify(value)}`, false);
  }
  const negative = trimmed.startsWith("-");
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw = "0", fracRaw = ""] = unsigned.split(".");
  const intPart = intPartRaw.replace(/^0+(?=\d)/, "");
  const frac = fracRaw.length < 2 ? fracRaw.padEnd(2, "0") : fracRaw.replace(/0+$/, "").padEnd(2, "0");
  const isZero = /^0*$/.test(intPart) && /^0*$/.test(frac);
  return `${negative && !isZero ? "-" : ""}${intPart}.${frac}`;
}

/** Formats a provider JSON number as a canonical decimal string. */
export function decimalFromNumber(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConnectorError("invalid_response", `Not a finite amount: ${String(value)}`, false);
  }
  // Number#toString is the shortest round-trip form, so a JSON literal such
  // as 12.34 survives untouched. Only very large / very small magnitudes use
  // exponent notation, which toFixed removes.
  const text = value.toString();
  const plain = /e/i.test(text) ? value.toFixed(10) : text;
  return canonicalDecimal(plain);
}

/** Flips the sign of a decimal string without parsing it as a number. */
export function negateDecimal(value: string): string {
  const canonical = canonicalDecimal(value);
  if (/^-?0\.0+$/.test(canonical)) return canonical.replace(/^-/, "");
  return canonical.startsWith("-") ? canonical.slice(1) : `-${canonical}`;
}
