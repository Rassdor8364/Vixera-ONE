import { describe, expect, it } from "vitest";
import { ref } from "@vixera/domain";
import {
  InMemoryAuditSink,
  Intelligence,
  LocalityError,
  ModelCancelledError,
  ModelOutputError,
  ModelRegistry,
  ModelTimeoutError,
  ModelUnavailableError,
  ScriptedModelProvider,
  TaskRunner,
  noContext,
  selectContext,
  v,
  type StructuredTaskSpec,
} from "./index.ts";

const echoSpec: StructuredTaskSpec<{ say: string }, { said: string }> = {
  name: "echo",
  system: "echo",
  prompt: (i) => i.say,
  validate: (x) => (v.object(x) && v.string(x["said"]) ? v.pass({ said: x["said"] }) : v.fail("said missing")),
};

function setup(answers: ConstructorParameters<typeof ScriptedModelProvider>[0], opts: ConstructorParameters<typeof ScriptedModelProvider>[1] = {}) {
  const provider = new ScriptedModelProvider(answers, opts);
  const audit = new InMemoryAuditSink();
  const runner = new TaskRunner(new ModelRegistry().register(provider), { audit, timeoutMs: 200 });
  return { provider, audit, runner };
}

describe("TaskRunner", () => {
  it("returns validated JSON and records a content-free audit event", async () => {
    const { runner, audit } = setup('{"said":"hi"}');
    const run = await runner.run(echoSpec, { say: "PRIVATE WORDS" }, noContext());
    expect(run.output).toEqual({ said: "hi" });
    expect(run.provider).toBe("scripted");
    const [event] = audit.events();
    expect(event).toMatchObject({ task: "echo", provider: "scripted", model: "scripted-1", outcome: "ok", promptBytes: "PRIVATE WORDS".length });
    expect(JSON.stringify(event)).not.toContain("PRIVATE WORDS");
    expect(JSON.stringify(event)).not.toContain("hi");
  });

  it("accepts fenced JSON but nothing that is not one JSON value", async () => {
    const fenced = setup('```json\n{"said":"ok"}\n```');
    expect((await fenced.runner.run(echoSpec, { say: "x" }, noContext())).output).toEqual({ said: "ok" });
    const prose = setup('Sure! {"said":"ok"} hope that helps');
    await expect(prose.runner.run(echoSpec, { say: "x" }, noContext())).rejects.toBeInstanceOf(ModelOutputError);
    expect(prose.audit.events()[0]?.outcome).toBe("invalid_output");
  });

  it("rejects output the validator refuses, with the reason and no content", async () => {
    const { runner, audit } = setup('{"wrong":"shape"}');
    const err = await runner.run(echoSpec, { say: "x" }, noContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelOutputError);
    expect((err as ModelOutputError).reason).toBe("said missing");
    expect((err as Error).message).not.toContain("shape");
    expect(audit.events()[0]).toMatchObject({ outcome: "invalid_output", errorName: "ModelOutputError" });
  });

  it("times out even when the provider ignores the signal", async () => {
    const provider = new ScriptedModelProvider(() => new Promise<string>(() => {}), { capabilities: { cancellation: false } });
    const audit = new InMemoryAuditSink();
    const runner = new TaskRunner(new ModelRegistry().register(provider), { audit, timeoutMs: 20 });
    const err = await runner.run(echoSpec, { say: "x" }, noContext()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelTimeoutError);
    expect((err as ModelTimeoutError).timeoutMs).toBe(20);
    expect(audit.events()[0]?.outcome).toBe("timeout");
  });

  it("cancels through the caller's signal and reports cancelled, not timeout", async () => {
    const { runner, audit } = setup('{"said":"late"}', { delayMs: 500 });
    const controller = new AbortController();
    const pending = runner.run(echoSpec, { say: "x" }, noContext(), { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ModelCancelledError);
    expect(audit.events()[0]?.outcome).toBe("cancelled");
  });

  it("refuses a remote provider for a local-only task before sending anything", async () => {
    const { runner, provider, audit } = setup('{"said":"x"}');
    await expect(runner.run(echoSpec, { say: "x" }, noContext(), { requireLocality: "local" })).rejects.toBeInstanceOf(LocalityError);
    expect(provider.requests).toHaveLength(0);
    expect(audit.events()[0]?.outcome).toBe("locality_refused");
  });

  it("with no provider registered, the null provider makes the failure explicit", async () => {
    const audit = new InMemoryAuditSink();
    const runner = new TaskRunner(new ModelRegistry(), { audit });
    await expect(runner.run(echoSpec, { say: "x" }, noContext())).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(audit.events()[0]).toMatchObject({ provider: "null", outcome: "unavailable" });
  });
});

describe("Intelligence tasks", () => {
  const items = [
    { ref: ref("mail_message", "m1"), fields: { subject: "Invoice 0231", fromDisplayName: "Eric" } },
    { ref: ref("document", "d1"), fields: { title: "Invoice #0231", kind: "invoice" } },
  ];

  it("classifyIntent sends the command and catalog only — no context items", async () => {
    const provider = new ScriptedModelProvider('{"intent":{"type":"find_person","query":"eric"},"confidence":0.8}');
    const intel = new Intelligence(new ModelRegistry().register(provider));
    const run = await intel.classifyIntent({ text: "find eric", area: "now", focusType: "thread", timezone: "Europe/Stockholm", catalog: [{ type: "find_person", description: "find a person", example: '{"type":"find_person","query":"eric"}' }] });
    expect(run.output).toEqual({ intent: { type: "find_person", query: "eric" }, confidence: 0.8 });
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain("find eric");
    expect(prompt).toContain("Focus: thread");
    expect(prompt).not.toContain("mail_message:");
  });

  it("a model cannot cite a ref it was not shown", async () => {
    const ctx = selectContext(items);
    const good = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"summary":"Eric sent invoice 0231.","citedRefs":[{"type":"mail_message","id":"m1"}]}')));
    expect((await good.summarizeContext({}, ctx)).output.citedRefs).toEqual([ref("mail_message", "m1")]);
    const forged = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"summary":"…","citedRefs":[{"type":"mail_message","id":"someone-elses"}]}')));
    await expect(forged.summarizeContext({}, ctx)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("the prompt carries exactly the serialized selection, nothing outside it", async () => {
    const provider = new ScriptedModelProvider('{"answer":"0231","citedRefs":[],"confidence":0.5}');
    const intel = new Intelligence(new ModelRegistry().register(provider));
    const ctx = selectContext(items);
    await intel.answerQuestion({ question: "which invoice?" }, ctx);
    const prompt = provider.requests[0]?.messages[0]?.content ?? "";
    expect(prompt).toContain(ctx.serialize());
    expect(prompt).not.toContain("fromEmail");
  });

  it("suggestions are notes and considerations with refs — never actions", async () => {
    const ctx = selectContext(items);
    const ok = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"suggestions":[{"text":"Invoice 0231 is unpaid","kind":"consider","refs":[{"type":"document","id":"d1"}]}]}')));
    expect((await ok.deriveSuggestions({}, ctx)).output.suggestions[0]?.kind).toBe("consider");
    const action = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"suggestions":[{"text":"pay it","kind":"execute","refs":[]}]}')));
    await expect(action.deriveSuggestions({}, ctx)).rejects.toBeInstanceOf(ModelOutputError);
  });

  it("extractFacts and compareContext validate their shapes and refs", async () => {
    const ctx = selectContext(items);
    const facts = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"facts":[{"name":"amount","value":4800,"sourceRef":{"type":"document","id":"d1"}},{"name":"due","value":null,"sourceRef":null}]}')));
    expect((await facts.extractFacts({ fields: [{ name: "amount", description: "total", type: "number" }] }, ctx)).output.facts).toHaveLength(2);
    const cmp = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"summary":"s","differences":[{"aspect":"count","left":"1","right":"2","refs":[{"type":"mail_message","id":"m1"}]}]}')));
    expect((await cmp.compareContext({ leftLabel: "Aug", rightLabel: "Sep", aspect: "travel" }, ctx)).output.differences).toHaveLength(1);
    const bad = new Intelligence(new ModelRegistry().register(new ScriptedModelProvider('{"facts":[{"name":"x","value":{"nested":1},"sourceRef":null}]}')));
    await expect(bad.extractFacts({ fields: [] }, ctx)).rejects.toBeInstanceOf(ModelOutputError);
  });
});
