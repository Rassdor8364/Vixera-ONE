import type { ContextManifest } from "./context-selection.ts";
import type { CompletionUsage } from "./model-provider.ts";

/**
 * Development-level auditability of model requests without logging private
 * content. An audit event says WHICH task ran on WHICH provider with HOW MUCH
 * of WHAT context (by reference), how long it took, and how it ended. It never
 * carries the prompt, the context values or the model's output.
 *
 * Sinks are injected; the default discards. A dev build can install the
 * in-memory sink and show the last N events; a server can forward them to a
 * metrics table keyed by user — still without content.
 */
export type ModelRequestOutcome = "ok" | "unavailable" | "timeout" | "cancelled" | "invalid_output" | "locality_refused" | "capability_refused" | "error";

export interface ModelRequestAuditEvent {
  readonly task: string;
  readonly provider: string;
  /** Provider-specific model name when the call returned one. */
  readonly model: string | null;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: ModelRequestOutcome;
  readonly usage: CompletionUsage | null;
  readonly context: ContextManifest;
  /** Serialized prompt size in UTF-8 bytes (system + user). A size, not the text. */
  readonly promptBytes: number;
  /** Error class name on failure (e.g. "ModelTimeoutError"), never the message. */
  readonly errorName: string | null;
}

export interface ModelRequestAuditSink {
  record(event: ModelRequestAuditEvent): void;
}

export class DiscardingAuditSink implements ModelRequestAuditSink {
  record(_event: ModelRequestAuditEvent): void {}
}

/** Keeps the last `capacity` events, newest last. For dev surfaces and tests. */
export class InMemoryAuditSink implements ModelRequestAuditSink {
  private readonly buffer: ModelRequestAuditEvent[] = [];

  constructor(readonly capacity = 100) {}

  record(event: ModelRequestAuditEvent): void {
    this.buffer.push(event);
    if (this.buffer.length > this.capacity) this.buffer.splice(0, this.buffer.length - this.capacity);
  }

  events(): readonly ModelRequestAuditEvent[] {
    return [...this.buffer];
  }

  clear(): void {
    this.buffer.length = 0;
  }
}
