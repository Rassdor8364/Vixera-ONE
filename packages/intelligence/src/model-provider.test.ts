import { describe, expect, it } from "vitest";
import { ModelUnavailableError } from "./errors.ts";
import { ModelRegistry, NullModelProvider, type CompletionRequest, type CompletionResult, type ModelCapabilities, type ModelProvider } from "./model-provider.ts";

const CAPS: ModelCapabilities = { locality: "remote", structuredOutput: true, maxInputTokens: 8000, cancellation: true };

class EchoProvider implements ModelProvider {
  constructor(
    readonly id: string,
    readonly capabilities: ModelCapabilities = CAPS,
  ) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const last = request.messages.at(-1)?.content ?? "";
    return { text: last, provider: this.id, model: "echo-1", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

describe("model abstraction", () => {
  const request: CompletionRequest = { messages: [{ role: "user", content: "hello" }] };

  it("null provider throws ModelUnavailableError instead of answering", async () => {
    const provider = new NullModelProvider();
    expect(provider.id).toBe("null");
    expect(provider.capabilities.locality).toBe("local");
    await expect(provider.complete(request)).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it("registry defaults to the null provider and hands out registered adapters by id", async () => {
    const registry = new ModelRegistry();
    expect(registry.default().id).toBe("null");
    expect(() => registry.get("missing")).toThrow(ModelUnavailableError);

    registry.register(new EchoProvider("echo"));
    expect(registry.default().id).toBe("echo");
    expect(registry.ids()).toEqual(["echo"]);
    expect(() => registry.register(new EchoProvider("echo"))).toThrow(/already registered/);

    registry.register(new EchoProvider("echo-2"), { asDefault: true });
    expect(registry.default().id).toBe("echo-2");
    registry.setDefault("echo");
    const result = await registry.default().complete(request);
    expect(result).toMatchObject({ text: "hello", provider: "echo", model: "echo-1" });
  });

  it("selects providers by capability, so a task can insist on local inference or structured output", () => {
    const registry = new ModelRegistry()
      .register(new EchoProvider("cloud", CAPS))
      .register(new EchoProvider("on-device", { ...CAPS, locality: "local", maxInputTokens: 2000 }))
      .register(new EchoProvider("plain", { ...CAPS, structuredOutput: false }));
    expect(registry.matching({ locality: "local" }).map((p) => p.id)).toEqual(["on-device"]);
    expect(registry.matching({ structuredOutput: true, maxInputTokens: 4000 }).map((p) => p.id)).toEqual(["cloud"]);
    expect(registry.matching({ maxInputTokens: 1000 }).map((p) => p.id)).toEqual(["cloud", "on-device", "plain"]);
  });
});
