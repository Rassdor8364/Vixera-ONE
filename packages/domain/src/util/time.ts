/** Small time helpers shared by connectors and the linker. */

export function toIso(value: Date | string | number): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${String(value)}`);
  return d.toISOString();
}

export function isoDateOnly(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

export function addHours(date: Date, hours: number): Date {
  return new Date(date.getTime() + hours * 3600_000);
}
