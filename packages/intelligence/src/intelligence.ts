import type { EntityRef } from "@vixera/domain";
import type { ContextSelection } from "./context-selection.ts";
import { noContext } from "./context-selection.ts";
import { ModelRegistry } from "./model-provider.ts";
import { TaskRunner, clip, v, type StructuredTaskSpec, type TaskOptions, type TaskRun, type TaskRunnerOptions } from "./tasks.ts";

/**
 * The product-facing surface: six task-shaped operations over a registry of
 * providers. Each takes typed input and an explicit `ContextSelection`, and
 * returns typed output whose entity references are checked against that
 * selection — a model cannot cite something it was not shown.
 *
 * None of these return actions. `deriveSuggestions` returns text with
 * references; turning a suggestion into a change is the caller's job, through
 * the typed action seam, with the user in the loop.
 *
 * Prompts here are deliberately plain: there is no provider to tune them
 * against yet. They will change; the shapes should not.
 */

// --- classify_intent ----------------------------------------------------------
export interface IntentCatalogEntry {
  readonly type: string;
  readonly description: string;
  /** JSON shape of the intent's fields, as a short example. */
  readonly example: string;
}

export interface ClassifyIntentInput {
  readonly text: string;
  /** Where the user is in the Field; a hint, not data. */
  readonly area: string;
  /** Entity type in focus, if any. Never the entity itself. */
  readonly focusType: string | null;
  readonly timezone: string | null;
  readonly catalog: readonly IntentCatalogEntry[];
}

/** The intent is an opaque JSON object here; `@vixera/command` validates it against its own union. */
export interface ClassifyIntentOutput {
  readonly intent: Record<string, unknown>;
  readonly confidence: number;
}

const classifyIntent: StructuredTaskSpec<ClassifyIntentInput, ClassifyIntentOutput> = {
  name: "classify_intent",
  system:
    "You map one short command typed into Vixera One to exactly one intent from the catalog. " +
    "Reply with a single JSON object {\"intent\": {...}, \"confidence\": 0..1}. " +
    "Copy the user's words into query fields; never invent names or ids. If nothing fits, use {\"type\":\"unknown\",\"text\":<the command>} with confidence 0.",
  prompt: (input) =>
    [
      "Catalog:",
      ...input.catalog.map((c) => `- ${c.type}: ${c.description} e.g. ${c.example}`),
      "",
      `Area: ${input.area}`,
      `Focus: ${input.focusType ?? "none"}`,
      `Timezone: ${input.timezone ?? "unknown"}`,
      `Command: ${JSON.stringify(clip(input.text, 500))}`,
    ].join("\n"),
  validate: (value) => {
    if (!v.object(value)) return v.fail("not an object");
    const intent = value["intent"];
    if (!v.object(intent) || typeof intent["type"] !== "string") return v.fail("intent.type missing");
    if (!v.unit(value["confidence"])) return v.fail("confidence not in 0..1");
    return v.pass({ intent, confidence: value["confidence"] });
  },
  maxTokens: 200,
};

// --- summarize_context ---------------------------------------------------------
export interface SummarizeContextInput {
  /** What the summary is for, e.g. "before the 15:00 meeting". */
  readonly purpose?: string;
  readonly maxSentences?: number;
}
export interface SummarizeContextOutput {
  readonly summary: string;
  readonly citedRefs: readonly EntityRef[];
}

function summarizeContext(context: ContextSelection): StructuredTaskSpec<SummarizeContextInput, SummarizeContextOutput> {
  return {
    name: "summarize_context",
    system:
      "You summarize a small set of the user's own context items for the user. Use only the items given. " +
      "Reply with a single JSON object {\"summary\": string, \"citedRefs\": [{\"type\":..., \"id\":...}]} citing only refs that appear in the items.",
    prompt: (input, ctx) =>
      [`Purpose: ${clip(input.purpose ?? "orientation")}`, `At most ${input.maxSentences ?? 3} sentences.`, "", "Items:", ctx.serialize()].join("\n"),
    validate: (value) => {
      if (!v.object(value) || !v.string(value["summary"])) return v.fail("summary missing");
      if (!v.array(value["citedRefs"], v.refFrom(context))) return v.fail("citedRefs contains a ref not in the context");
      return v.pass({ summary: value["summary"], citedRefs: value["citedRefs"] });
    },
    maxTokens: 400,
  };
}

// --- extract_facts --------------------------------------------------------------
export interface FactField {
  readonly name: string;
  readonly description: string;
  readonly type: "string" | "number" | "boolean" | "date";
}
export interface ExtractFactsInput {
  readonly fields: readonly FactField[];
}
export interface ExtractedFact {
  readonly name: string;
  readonly value: string | number | boolean | null;
  readonly sourceRef: EntityRef | null;
}
export interface ExtractFactsOutput {
  readonly facts: readonly ExtractedFact[];
}

function extractFacts(context: ContextSelection): StructuredTaskSpec<ExtractFactsInput, ExtractFactsOutput> {
  return {
    name: "extract_facts",
    system:
      "You extract the requested fields from the user's context items. Use only what the items say; null when absent. " +
      "Reply with a single JSON object {\"facts\": [{\"name\", \"value\", \"sourceRef\": {\"type\",\"id\"} | null}]}.",
    prompt: (input, ctx) => ["Fields:", ...input.fields.map((f) => `- ${clip(f.name, 100)} (${f.type}): ${clip(f.description, 300)}`), "", "Items:", ctx.serialize()].join("\n"),
    validate: (value, input) => {
      const isRef = v.refFrom(context);
      const wanted = new Map(input.fields.map((f) => [f.name, f.type]));
      const typeOk = (type: FactField["type"], x: unknown) =>
        x === null || (type === "number" ? typeof x === "number" && Number.isFinite(x) : type === "boolean" ? typeof x === "boolean" : typeof x === "string");
      const isFact = (x: unknown): x is ExtractedFact =>
        v.object(x) &&
        v.string(x["name"], 100) &&
        wanted.has(x["name"]) &&
        typeOk(wanted.get(x["name"]) as FactField["type"], x["value"]) &&
        (x["sourceRef"] === null || isRef(x["sourceRef"]));
      if (!v.object(value) || !v.array(value["facts"], isFact, input.fields.length)) return v.fail("facts malformed, unrequested, mistyped, or cite a ref not in the context");
      return v.pass({ facts: value["facts"] });
    },
    maxTokens: 600,
  };
}

// --- compare_context ------------------------------------------------------------
export interface CompareContextInput {
  readonly leftLabel: string;
  readonly rightLabel: string;
  /** What to compare on, e.g. "travel spending". */
  readonly aspect: string;
}
export interface ContextDifference {
  readonly aspect: string;
  readonly left: string;
  readonly right: string;
  readonly refs: readonly EntityRef[];
}
export interface CompareContextOutput {
  readonly summary: string;
  readonly differences: readonly ContextDifference[];
}

function compareContext(context: ContextSelection): StructuredTaskSpec<CompareContextInput, CompareContextOutput> {
  return {
    name: "compare_context",
    system:
      "You compare two groups of the user's context items on one aspect. Items are labelled with their group. " +
      "Reply with a single JSON object {\"summary\": string, \"differences\": [{\"aspect\",\"left\",\"right\",\"refs\":[...]}]} citing only refs from the items.",
    prompt: (input, ctx) => [`Left: ${clip(input.leftLabel, 200)}`, `Right: ${clip(input.rightLabel, 200)}`, `Aspect: ${clip(input.aspect, 300)}`, "", "Items:", ctx.serialize()].join("\n"),
    validate: (value) => {
      const isRef = v.refFrom(context);
      const isDiff = (x: unknown): x is ContextDifference =>
        v.object(x) && v.string(x["aspect"], 200) && v.string(x["left"]) && v.string(x["right"]) && v.array(x["refs"], isRef);
      if (!v.object(value) || !v.string(value["summary"]) || !v.array(value["differences"], isDiff)) return v.fail("comparison malformed or cites a ref not in the context");
      return v.pass({ summary: value["summary"], differences: value["differences"] });
    },
    maxTokens: 800,
  };
}

// --- derive_suggestions ---------------------------------------------------------
export interface DeriveSuggestionsInput {
  readonly goal?: string;
  readonly max?: number;
}
export interface Suggestion {
  readonly text: string;
  readonly refs: readonly EntityRef[];
  /** "note" is an observation; "consider" proposes something the USER might do. Neither is executed. */
  readonly kind: "note" | "consider";
}
export interface DeriveSuggestionsOutput {
  readonly suggestions: readonly Suggestion[];
}

function deriveSuggestions(context: ContextSelection): StructuredTaskSpec<DeriveSuggestionsInput, DeriveSuggestionsOutput> {
  return {
    name: "derive_suggestions",
    system:
      "You point out what deserves the user's attention in their own context items, as short suggestions. You do not act; you suggest. " +
      "Reply with a single JSON object {\"suggestions\": [{\"text\", \"kind\": \"note\"|\"consider\", \"refs\": [...]}]} citing only refs from the items.",
    prompt: (input, ctx) => [`Goal: ${clip(input.goal ?? "what needs attention")}`, `At most ${input.max ?? 3}.`, "", "Items:", ctx.serialize()].join("\n"),
    validate: (value, input) => {
      const isRef = v.refFrom(context);
      const isSuggestion = (x: unknown): x is Suggestion =>
        v.object(x) && v.string(x["text"], 500) && (x["kind"] === "note" || x["kind"] === "consider") && v.array(x["refs"], isRef);
      const max = Math.min(20, Math.max(1, input.max ?? 3));
      if (!v.object(value) || !v.array(value["suggestions"], isSuggestion, max)) return v.fail(`suggestions malformed, more than ${max}, or cite a ref not in the context`);
      return v.pass({ suggestions: value["suggestions"] });
    },
    maxTokens: 600,
  };
}

// --- answer_question ------------------------------------------------------------
export interface AnswerQuestionInput {
  readonly question: string;
}
export interface AnswerQuestionOutput {
  readonly answer: string;
  readonly citedRefs: readonly EntityRef[];
  readonly confidence: number;
}

function answerQuestion(context: ContextSelection): StructuredTaskSpec<AnswerQuestionInput, AnswerQuestionOutput> {
  return {
    name: "answer_question",
    system:
      "You answer the user's question using only the context items given. If they do not contain the answer, say so and set confidence 0. " +
      "Reply with a single JSON object {\"answer\": string, \"citedRefs\": [...], \"confidence\": 0..1} citing only refs from the items.",
    prompt: (input, ctx) => [`Question: ${clip(input.question)}`, "", "Items:", ctx.serialize()].join("\n"),
    validate: (value) => {
      if (!v.object(value) || !v.string(value["answer"]) || !v.unit(value["confidence"])) return v.fail("answer or confidence missing");
      if (!v.array(value["citedRefs"], v.refFrom(context))) return v.fail("citedRefs contains a ref not in the context");
      return v.pass({ answer: value["answer"], citedRefs: value["citedRefs"], confidence: value["confidence"] });
    },
    maxTokens: 600,
  };
}

// --- facade ---------------------------------------------------------------------
export class Intelligence {
  readonly registry: ModelRegistry;
  readonly runner: TaskRunner;

  constructor(registry: ModelRegistry = new ModelRegistry(), options: TaskRunnerOptions = {}) {
    this.registry = registry;
    this.runner = new TaskRunner(registry, options);
  }

  /** No context: the command text and a catalog are all a classifier gets. */
  classifyIntent(input: ClassifyIntentInput, options?: TaskOptions): Promise<TaskRun<ClassifyIntentOutput>> {
    return this.runner.run(classifyIntent, input, noContext(), options);
  }

  summarizeContext(input: SummarizeContextInput, context: ContextSelection, options?: TaskOptions): Promise<TaskRun<SummarizeContextOutput>> {
    return this.runner.run(summarizeContext(context), input, context, options);
  }

  extractFacts(input: ExtractFactsInput, context: ContextSelection, options?: TaskOptions): Promise<TaskRun<ExtractFactsOutput>> {
    return this.runner.run(extractFacts(context), input, context, options);
  }

  compareContext(input: CompareContextInput, context: ContextSelection, options?: TaskOptions): Promise<TaskRun<CompareContextOutput>> {
    return this.runner.run(compareContext(context), input, context, options);
  }

  deriveSuggestions(input: DeriveSuggestionsInput, context: ContextSelection, options?: TaskOptions): Promise<TaskRun<DeriveSuggestionsOutput>> {
    return this.runner.run(deriveSuggestions(context), input, context, options);
  }

  answerQuestion(input: AnswerQuestionInput, context: ContextSelection, options?: TaskOptions): Promise<TaskRun<AnswerQuestionOutput>> {
    return this.runner.run(answerQuestion(context), input, context, options);
  }
}
