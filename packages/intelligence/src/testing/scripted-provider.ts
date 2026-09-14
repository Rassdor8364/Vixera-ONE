import { ModelCancelledError } from "../errors.ts";
import type { CompletionOptions, CompletionRequest, CompletionResult, ModelCapabilities, ModelProvider } from "../model-provider.ts";

/**
 * A test double: answers from a script, optionally after a delay, and records
 * every request so a test can assert what a task sent (tests may look at
 * content; production audit events never do).
 */
export type ScriptedAnswer = string | ((request: CompletionRequest) => string | Promise<string>);

export interface ScriptedProviderOptions {
  readonly id?: string;
  readonly capabilities?: Partial<ModelCapabilities>;
  /** Milliseconds to wait before answering; honours cancellation while waiting. */
  readonly delayMs?: number;
}

export class ScriptedModelProvider implements ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  readonly requests: CompletionRequest[] = [];
  private readonly answers: ScriptedAnswer[];
  private readonly delayMs: number;

  constructor(answers: ScriptedAnswer | readonly ScriptedAnswer[], options: ScriptedProviderOptions = {}) {
    this.id = options.id ?? "scripted";
    this.capabilities = { locality: "remote", structuredOutput: true, maxInputTokens: 8000, cancellation: true, ...options.capabilities };
    this.answers = Array.isArray(answers) ? [...answers] : [answers as ScriptedAnswer];
    this.delayMs = options.delayMs ?? 0;
  }

  async complete(request: CompletionRequest, options: CompletionOptions = {}): Promise<CompletionResult> {
    this.requests.push(request);
    if (options.signal?.aborted) throw new ModelCancelledError(this.id);
    if (this.delayMs > 0) await this.wait(this.delayMs, options.signal);
    const next = this.answers.length > 1 ? this.answers.shift() : this.answers[0];
    if (next === undefined) throw new Error("ScriptedModelProvider has no answer left");
    const text = typeof next === "function" ? await next(request) : next;
    return { text, provider: this.id, model: "scripted-1", usage: { inputTokens: request.messages.length, outputTokens: 1 } };
  }

  private wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ModelCancelledError(this.id));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
