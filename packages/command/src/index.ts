/**
 * @vixera/command — One Command.
 *
 *   intent.ts       Intent union, FieldArea, CommandContext
 *   grammar.ts      deterministic phrase grammar (pure)
 *   router.ts       IntentRouter seam + RuleBasedIntentRouter (grammar + name classification)
 *   intent-schema.ts parseIntent: the trust boundary for any intent that did not come from the grammar
 *   model-router.ts  ModelIntentRouter: an IntentClassifier (model, server-side) behind the same seam
 *   hybrid-router.ts HybridIntentRouter: rules first; the model only when the rules are unsure
 *   executor.ts     CommandExecutor: intents → CommandResult over CommandReader (a SpineReader slice)
 *   one-command.ts  OneCommand = router + executor + CommandHistory
 *   testing/        FakeSpineReader + the brief's world, for tests of any package
 */
export * from "./intent.ts";
export * from "./reader.ts";
export * from "./grammar.ts";
export * from "./names.ts";
export * from "./router.ts";
export * from "./intent-schema.ts";
export * from "./model-router.ts";
export * from "./hybrid-router.ts";
export * from "./executor.ts";
export * from "./history.ts";
export * from "./one-command.ts";
export * from "./time-range.ts";
