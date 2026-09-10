import { describe, expect, it } from "vitest";
import {
  ModelRegistry,
  ModelUnavailableError,
  NullModelProvider,
  type CompletionRequest,
  type CompletionResult,
  type ModelProvider,
} from "./model-provider.ts";

class EchoProvider implements ModelProvider {
  constructor(readonly id: string) {}
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
});
