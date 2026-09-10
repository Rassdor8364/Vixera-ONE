import type { CommandExecutor, CommandResult } from "./executor.ts";
import { CommandHistory } from "./history.ts";
import type { CommandContext } from "./intent.ts";
import type { IntentRouter, RoutedIntent } from "./router.ts";

/**
 * One Command = router + executor (+ history). The Field calls `run(text,
 * context)` and renders the result; it never touches the spine for commands.
 */
export interface OneCommandOptions {
  readonly router: IntentRouter;
  readonly executor: CommandExecutor;
  readonly history?: CommandHistory;
}

export interface OneCommandRun {
  readonly routed: RoutedIntent;
  readonly result: CommandResult;
}

export class OneCommand {
  readonly history: CommandHistory;
  private readonly router: IntentRouter;
  private readonly executor: CommandExecutor;

  constructor(options: OneCommandOptions) {
    this.router = options.router;
    this.executor = options.executor;
    this.history = options.history ?? new CommandHistory();
  }

  async run(text: string, context: CommandContext): Promise<OneCommandRun> {
    const routed = await this.router.route(text, context);
    const result = await this.executor.execute(routed.intent, context);
    if (routed.intent.type !== "unknown") this.history.push(text);
    return { routed, result };
  }
}
