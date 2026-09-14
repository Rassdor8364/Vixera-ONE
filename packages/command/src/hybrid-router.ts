import type { CommandContext } from "./intent.ts";
import type { IntentRouter, RoutedIntent } from "./router.ts";

/**
 * Rules first, model second, executor always typed.
 *
 *   1. The rule-based router answers. If its confidence clears `threshold`,
 *      that is the answer — the model is never consulted, never billed, never
 *      shown the command.
 *   2. Otherwise, if a model router is wired, it is asked. Its answer is used
 *      only when it is a real intent (not `unknown`) AND more confident than
 *      the rules were. A model that fails in any way changes nothing.
 *   3. The rules' answer stands in every other case, including `unknown`.
 *
 * The model never executes anything: both branches produce an `Intent`, and
 * the same `CommandExecutor` runs it through typed reads and typed actions.
 */
export interface HybridIntentRouterOptions {
  /** Rule confidence at or above which the model is not consulted. Default 0.8. */
  readonly threshold?: number;
  /** Called when the model was consulted, with both answers; for dev surfaces and tests. */
  readonly onConsulted?: (rules: RoutedIntent, model: RoutedIntent, chosen: "rules" | "model") => void;
}

export class HybridIntentRouter implements IntentRouter {
  private readonly threshold: number;
  private readonly onConsulted: HybridIntentRouterOptions["onConsulted"];

  constructor(
    private readonly rules: IntentRouter,
    private readonly model: IntentRouter | null,
    options: HybridIntentRouterOptions = {},
  ) {
    this.threshold = options.threshold ?? 0.8;
    this.onConsulted = options.onConsulted;
  }

  async route(text: string, context: CommandContext): Promise<RoutedIntent> {
    const byRules: RoutedIntent = { ...(await this.rules.route(text, context)), source: "rules" };
    if (!this.model || byRules.confidence >= this.threshold) return byRules;
    const byModel = await this.model.route(text, context);
    const useModel = byModel.intent.type !== "unknown" && byModel.confidence > byRules.confidence;
    this.onConsulted?.(byRules, byModel, useModel ? "model" : "rules");
    return useModel ? { ...byModel, source: "model" } : byRules;
  }
}
