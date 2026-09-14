import type { EntityRef } from "@vixera/domain";
import { DiscardingAuditSink, type ModelRequestAuditSink, type ModelRequestOutcome } from "./audit.ts";
import type { ContextSelection } from "./context-selection.ts";
import { LocalityError, ModelCancelledError, ModelOutputError, ModelTimeoutError, ModelUnavailableError } from "./errors.ts";
import type { CompletionUsage, ModelProvider, ModelRegistry } from "./model-provider.ts";

/**
 * Typed, bounded, audited model tasks.
 *
 * A task is: a name, a system instruction, a prompt built from typed input
 * plus a `ContextSelection`, and a validator for the JSON the model returns.
 * `TaskRunner.run` is the one path from "we want a model's help" to a typed
 * result. It enforces the timeout and cancellation whether or not the
 * provider cooperates, refuses remote providers when a task needs a local
 * one, rejects any output the validator does not accept, and records an
 * audit event without content.
 *
 * Nothing here can mutate the spine or call a provider API: a task's output
 * is data handed back to the caller, who decides what — if anything — to do
 * with it through typed actions.
 */

export type ValidationResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };
export type Validator<T> = (value: unknown) => ValidationResult<T>;

export interface StructuredTaskSpec<I, O> {
  readonly name: string;
  readonly system: string;
  prompt(input: I, context: ContextSelection): string;
  readonly validate: Validator<O>;
  readonly maxTokens?: number;
}

export interface TaskOptions {
  /** A specific provider; default is the registry's default. */
  readonly provider?: ModelProvider;
  readonly signal?: AbortSignal;
  /** Overrides the runner's default timeout. */
  readonly timeoutMs?: number;
  /** "local": refuse any provider whose `capabilities.locality` is not "local". */
  readonly requireLocality?: "local";
}

export interface TaskRun<O> {
  readonly output: O;
  readonly provider: string;
  readonly model: string;
  readonly usage: CompletionUsage | null;
  readonly durationMs: number;
}

export interface TaskRunnerOptions {
  readonly audit?: ModelRequestAuditSink;
  /** Default 15 s. */
  readonly timeoutMs?: number;
  readonly clock?: () => number;
}

export class TaskRunner {
  private readonly audit: ModelRequestAuditSink;
  private readonly timeoutMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly registry: ModelRegistry,
    options: TaskRunnerOptions = {},
  ) {
    this.audit = options.audit ?? new DiscardingAuditSink();
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.clock = options.clock ?? (() => Date.now());
  }

  async run<I, O>(spec: StructuredTaskSpec<I, O>, input: I, context: ContextSelection, options: TaskOptions = {}): Promise<TaskRun<O>> {
    const provider = options.provider ?? this.registry.default();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const prompt = spec.prompt(input, context);
    const started = this.clock();
    const startedAt = new Date(started).toISOString();

    const finish = (outcome: ModelRequestOutcome, extra: { model?: string | null; usage?: CompletionUsage | null; errorName?: string | null } = {}) =>
      this.audit.record({
        task: spec.name,
        provider: provider.id,
        model: extra.model ?? null,
        startedAt,
        durationMs: this.clock() - started,
        outcome,
        usage: extra.usage ?? null,
        context: context.manifest,
        promptBytes: prompt.length,
        errorName: extra.errorName ?? null,
      });

    if (options.requireLocality === "local" && provider.capabilities.locality !== "local") {
      finish("locality_refused", { errorName: "LocalityError" });
      throw new LocalityError(provider.id, "local");
    }

    // One controller for both cancellation sources; the provider gets its signal,
    // and the race below enforces the deadline even on a provider that ignores it.
    const controller = new AbortController();
    let timedOut = false;
    const onOuterAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onOuterAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    try {
      const result = await Promise.race([
        provider.complete(
          { system: spec.system, messages: [{ role: "user", content: prompt }], responseFormat: "json", ...(spec.maxTokens !== undefined ? { maxTokens: spec.maxTokens } : {}) },
          { signal: controller.signal },
        ),
        new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new ModelCancelledError(provider.id)), { once: true })),
      ]);

      const parsed = parseJson(result.text);
      if (!parsed.ok) {
        finish("invalid_output", { model: result.model, usage: result.usage ?? null, errorName: "ModelOutputError" });
        throw new ModelOutputError(provider.id, spec.name, parsed.reason);
      }
      const validated = spec.validate(parsed.value);
      if (!validated.ok) {
        finish("invalid_output", { model: result.model, usage: result.usage ?? null, errorName: "ModelOutputError" });
        throw new ModelOutputError(provider.id, spec.name, validated.reason);
      }
      finish("ok", { model: result.model, usage: result.usage ?? null });
      return { output: validated.value, provider: result.provider, model: result.model, usage: result.usage ?? null, durationMs: this.clock() - started };
    } catch (error) {
      if (error instanceof ModelOutputError || error instanceof LocalityError) throw error;
      if (error instanceof ModelUnavailableError) {
        finish("unavailable", { errorName: error.name });
        throw error;
      }
      if (timedOut) {
        finish("timeout", { errorName: "ModelTimeoutError" });
        throw new ModelTimeoutError(provider.id, timeoutMs);
      }
      if (error instanceof ModelCancelledError || controller.signal.aborted) {
        finish("cancelled", { errorName: "ModelCancelledError" });
        throw new ModelCancelledError(provider.id);
      }
      finish("error", { errorName: error instanceof Error ? error.name : "Error" });
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

/** Models wrap JSON in fences more often than not; accept that, nothing else. */
function parseJson(text: string): ValidationResult<unknown> {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false, reason: "not a single JSON value" };
  }
}

// -----------------------------------------------------------------------------
// Validation helpers shared by the task specs. Hand-rolled on purpose: no
// schema library on the dependency list of a package that runs in the WebView,
// Node and Deno alike.
// -----------------------------------------------------------------------------
export const v = {
  object(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  },
  string(value: unknown, max = 4000): value is string {
    return typeof value === "string" && value.length <= max;
  },
  unit(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  },
  array<T>(value: unknown, item: (x: unknown) => x is T, max = 100): value is T[] {
    return Array.isArray(value) && value.length <= max && value.every(item);
  },
  /** An EntityRef the model may only have copied from the context it was given. */
  refFrom(context: ContextSelection): (value: unknown) => value is EntityRef {
    const allowed = new Set(context.manifest.refs.map((r) => `${r.type}:${r.id}`));
    return (value: unknown): value is EntityRef =>
      v.object(value) && typeof value["type"] === "string" && typeof value["id"] === "string" && allowed.has(`${value["type"]}:${value["id"]}`);
  },
  fail(reason: string): ValidationResult<never> {
    return { ok: false, reason };
  },
  pass<T>(value: T): ValidationResult<T> {
    return { ok: true, value };
  },
};
