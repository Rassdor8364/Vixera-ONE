/**
 * Model abstraction for Vixera One.
 *
 * Vixera One IS the intelligence layer; language-model providers are
 * adapters behind this interface. Phase 1 needs only the seam: a request /
 * result shape, an error for "no model configured", a null provider, and a
 * registry so callers ask for "the default model" instead of a vendor.
 *
 * Real provider adapters come later and MUST implement `ModelProvider`. They
 * run SERVER-SIDE ONLY (Edge Functions): API keys live in Supabase secrets,
 * never in client code, never in the spine, never in source. There is no
 * model marketplace and no per-user model settings in Phase 1. The intended
 * first consumers are a model-backed `IntentRouter` (packages/command) and
 * conclusion generation (`Conclusion.producedBy = "model:<provider>/<model>"`).
 */

export interface CompletionMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface CompletionRequest {
  readonly system?: string;
  readonly messages: readonly CompletionMessage[];
  readonly maxTokens?: number;
  readonly temperature?: number;
  readonly responseFormat?: "text" | "json";
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

export interface ModelProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

/** Thrown when a completion is requested but no usable model is available. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly providerId: string,
    message = `Model provider "${providerId}" is not available`,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/**
 * The provider Vixera runs with when nothing is configured. Every call
 * throws `ModelUnavailableError`, so callers degrade explicitly (rules,
 * empty state) instead of silently pretending a model answered.
 */
export class NullModelProvider implements ModelProvider {
  readonly id = "null";

  async complete(_request: CompletionRequest): Promise<CompletionResult> {
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
}
