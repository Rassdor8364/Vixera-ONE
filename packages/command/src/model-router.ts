import type { EntityType } from "@vixera/domain";
import type { CommandContext, FieldArea } from "./intent.ts";
import { INTENT_CATALOG, parseIntent } from "./intent-schema.ts";
import type { IntentRouter, RoutedIntent } from "./router.ts";

/**
 * A model-backed `IntentRouter`.
 *
 * It knows nothing about vendors or transports: it is given an
 * `IntentClassifier`, and the wiring decides what that is — a server-side
 * `Intelligence.classifyIntent` behind an Edge Function, an on-device model,
 * a test double. What the classifier receives is deliberately thin: the
 * command text, the area, the TYPE of the focused entity and the timezone.
 * No names, no ids, no context items. Name resolution stays in the executor,
 * where ambiguity becomes candidates instead of a guess.
 *
 * Whatever comes back is untrusted: `parseIntent` decides whether it is an
 * `Intent` at all, confidence is clamped, and a failure of any kind routes to
 * `unknown` with confidence 0 — the hybrid router then keeps the rules' answer.
 */
export interface IntentClassifierInput {
  readonly text: string;
  readonly area: FieldArea;
  readonly focusType: EntityType | null;
  readonly timezone: string | null;
  readonly catalog: typeof INTENT_CATALOG;
}

export interface IntentClassification {
  /** Opaque until `parseIntent` accepts it. */
  readonly intent: unknown;
  readonly confidence: number;
}

export interface IntentClassifier {
  classify(input: IntentClassifierInput, options?: { readonly signal?: AbortSignal }): Promise<IntentClassification>;
}

export interface ModelIntentRouterOptions {
  /** A model's confidence is capped here so it can never outrank a certain grammar match. Default 0.85. */
  readonly maxConfidence?: number;
  readonly signal?: AbortSignal;
}

export class ModelIntentRouter implements IntentRouter {
  private readonly maxConfidence: number;
  private readonly signal: AbortSignal | undefined;

  constructor(
    private readonly classifier: IntentClassifier,
    options: ModelIntentRouterOptions = {},
  ) {
    this.maxConfidence = options.maxConfidence ?? 0.85;
    this.signal = options.signal;
  }

  async route(text: string, context: CommandContext): Promise<RoutedIntent> {
    const unknown: RoutedIntent = { intent: { type: "unknown", text }, confidence: 0, matchedRule: null, source: "model" };
    let classification: IntentClassification;
    try {
      classification = await this.classifier.classify(
        { text, area: context.area, focusType: context.focus?.type ?? null, timezone: context.timezone ?? null, catalog: INTENT_CATALOG },
        this.signal ? { signal: this.signal } : {},
      );
    } catch {
      // Unavailable, timed out, cancelled, malformed: all the same to the caller — no model answer.
      return unknown;
    }
    const intent = parseIntent(classification.intent);
    if (!intent || intent.type === "unknown") return unknown;
    const raw = Number.isFinite(classification.confidence) ? classification.confidence : 0;
    const confidence = Math.min(this.maxConfidence, Math.max(0, raw));
    return { intent, confidence, matchedRule: `model.${intent.type}`, source: "model" };
  }
}
