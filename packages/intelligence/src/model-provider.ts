/**
 * Model abstraction for Vixera One.
 *
 * Vixera One IS the intelligence layer; language-model providers are
 * adapters behind this interface. The package is runtime-neutral (Node,
 * Deno, the WebView) and has no vendor code in it. Adapters for Vixera AI,
 * Claude, OpenAI, Gemini or a local model each implement `ModelProvider` and
 * are registered by id; nothing above this layer names a vendor.
 *
 * Adapters that hold API keys run SERVER-SIDE ONLY (Edge Functions): keys
 * live in Supabase secrets, never in client code, never in the spine, never
 * in source. The `locality` capability is how a task refuses to send context
 * off the device when it must stay local.
 *
 * Consumers do not call `complete()` directly for product work; they go
 * through the typed tasks in tasks.ts, which bound the context, validate the
 * output and record an audit event.
 */
import { ModelUnavailableError } from "./errors.ts";

export interface CompletionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CompletionRequest {
  readonly system?: string;
  readonly messages: readonly CompletionMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  /** "json": the provider must return one JSON value and nothing else. */
  readonly responseFormat?: "text" | "json";
}

export interface CompletionOptions {
  /** Cancels the call; the provider must stop work and reject with ModelCancelledError. */
  readonly signal?: AbortSignal;
}

export interface CompletionUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface CompletionResult {
  readonly text: string;
  /** Provider id that produced the result (matches `ModelProvider.id`). */
  readonly provider: string;
  /** Provider-specific model name, informational only. */
  readonly model: string;
  readonly usage?: CompletionUsage;
}

/**
 * What a provider can do, declared up front so a task can pick or refuse a
 * provider without trying it.
 */
export interface ModelCapabilities {
  /** Where inference happens. "local" never leaves the device; "remote" is a network call. */
  readonly locality: "local" | "remote";
  /** The adapter can be told to return a single JSON value and will. */
  readonly structuredOutput: boolean;
  /** Upper bound on request size, in the provider's own tokens. Tasks use it as a rough budget. */
  readonly maxInputTokens: number;
  /** The adapter honours `CompletionOptions.signal` mid-flight (not just before starting). */
  readonly cancellation: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly capabilities: ModelCapabilities;
  complete(request: CompletionRequest, options?: CompletionOptions): Promise<CompletionResult>;
}

/**
 * The provider Vixera runs with when nothing is configured. Every call
 * throws `ModelUnavailableError`, so callers degrade explicitly (rules,
 * empty state) instead of silently pretending a model answered.
 */
export class NullModelProvider implements ModelProvider {
  readonly id = "null";
  // Declares every capability so a task's checks pass and the call itself is
  // what fails — "no model configured" is the message, not "cannot do JSON".
  readonly capabilities: ModelCapabilities = { locality: "local", structuredOutput: true, maxInputTokens: Number.MAX_SAFE_INTEGER, cancellation: true };

  async complete(_request: CompletionRequest, _options?: CompletionOptions): Promise<CompletionResult> {
    throw new ModelUnavailableError(this.id, "No model provider is configured");
  }
}

/**
 * Holds the providers known to this process. `get()` throws for an unknown
 * id; `default()` returns the configured default or the null provider, so
 * asking for a model never returns undefined.
 */
export class ModelRegistry {
  private readonly providers = new Map<string, ModelProvider>();
  private defaultId: string | null = null;

  constructor(private readonly fallback: ModelProvider = new NullModelProvider()) {}

  register(provider: ModelProvider, options: { readonly asDefault?: boolean } = {}): this {
    if (!provider.id) throw new Error("A model provider needs a non-empty id");
    if (this.providers.has(provider.id)) throw new Error(`Model provider "${provider.id}" is already registered`);
    this.providers.set(provider.id, provider);
    if (options.asDefault || this.defaultId === null) this.defaultId = provider.id;
    return this;
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  get(id: string): ModelProvider {
    const provider = this.providers.get(id);
    if (!provider) throw new ModelUnavailableError(id, `Model provider "${id}" is not registered`);
    return provider;
  }

  setDefault(id: string): this {
    this.get(id);
    this.defaultId = id;
    return this;
  }

  /** The default provider, or the fallback (null provider) when none is registered. */
  default(): ModelProvider {
    return this.defaultId === null ? this.fallback : this.get(this.defaultId);
  }

  ids(): string[] {
    return [...this.providers.keys()];
  }

  /** Providers whose capabilities satisfy every given requirement. */
  matching(requirements: Partial<ModelCapabilities>): ModelProvider[] {
    return [...this.providers.values()].filter((p) =>
      (Object.entries(requirements) as [keyof ModelCapabilities, unknown][]).every(([k, v]) =>
        k === "maxInputTokens" ? p.capabilities.maxInputTokens >= (v as number) : p.capabilities[k] === v,
      ),
    );
  }
}
