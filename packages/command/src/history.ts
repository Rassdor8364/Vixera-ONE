/**
 * In-memory ring of recent One Command inputs. Feeds `Handoff.commandHistory`
 * so the receiving device knows what the user was doing. Oldest entries
 * fall off when the ring is full; consecutive duplicates collapse.
 */
export class CommandHistory {
  private readonly entries: string[] = [];

  constructor(readonly capacity = 20) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("CommandHistory capacity must be a positive integer");
  }

  push(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (this.entries.at(-1) === t) return;
    this.entries.push(t);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
  }

  /** Oldest first — the order `Handoff.commandHistory` expects. */
  toArray(): string[] {
    return [...this.entries];
  }

  /** The `n` most recent, newest first (for a recall UI). */
  recent(n = this.capacity): string[] {
    if (n <= 0) return [];
    return this.entries.slice(-n).reverse();
  }

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
  }
}
