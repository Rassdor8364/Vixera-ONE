/**
 * Every way a model call can fail, as a distinct class, so callers degrade
 * deliberately: rules instead of a model, an empty state instead of a guess.
 * None of these ever carry prompt or response content in their message.
 */

/** No usable model: nothing registered, or the id is unknown. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly providerId: string,
    message = `Model provider "${providerId}" is not available`,
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** The call exceeded its `timeoutMs`. */
export class ModelTimeoutError extends Error {
  constructor(
    readonly providerId: string,
    readonly timeoutMs: number,
  ) {
    super(`Model provider "${providerId}" did not answer within ${timeoutMs} ms`);
    this.name = "ModelTimeoutError";
  }
}

/** The caller's `AbortSignal` fired before the call finished. */
export class ModelCancelledError extends Error {
  constructor(readonly providerId: string) {
    super(`Model call to "${providerId}" was cancelled`);
    this.name = "ModelCancelledError";
  }
}

/**
 * The model answered but not in the shape the task requires: not JSON, or
 * JSON that failed the task's validator. `reason` is the validator's one-line
 * verdict, never the output itself.
 */
export class ModelOutputError extends Error {
  constructor(
    readonly providerId: string,
    readonly task: string,
    readonly reason: string,
  ) {
    super(`Model provider "${providerId}" returned an unusable ${task} result: ${reason}`);
    this.name = "ModelOutputError";
  }
}

/** The selected context does not fit the budget, or contains a field the allow-list forbids. */
export class ContextSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextSelectionError";
  }
}

/** The provider declares it cannot do what the task needs (structured output, a prompt this large). */
export class CapabilityError extends Error {
  constructor(
    readonly providerId: string,
    readonly capability: "structuredOutput" | "maxInputTokens",
    detail: string,
  ) {
    super(`Model provider "${providerId}" cannot satisfy ${capability}: ${detail}`);
    this.name = "CapabilityError";
  }
}

/** A task that requires a local model was asked to run on a remote one. */
export class LocalityError extends Error {
  constructor(
    readonly providerId: string,
    readonly required: "local",
  ) {
    super(`Model provider "${providerId}" is remote, but this task requires a ${required} model`);
    this.name = "LocalityError";
  }
}
