import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  AnthropicDiagnosisModel,
  DEFAULT_DIAGNOSIS_MODEL,
  ModelRefusedError,
  REFUSAL_FALLBACK_MODEL,
  getDiagnosisModel,
} from "@/lib/diagnosis-model";
import type { ModelInput } from "@/lib/redact";

const input: ModelInput = {
  gateway_response: "The transaction was not completed",
  amount_minor_units: 250000,
  currency: "NGN",
  payment_channel: "card",
  is_subscription_renewal: false,
  card: null,
  checkout: null,
};

type Call = Record<string, unknown>;

function fakeClient(replies: ((params: Call) => object)[]) {
  const calls: Call[] = [];
  const client = {
    beta: {
      messages: {
        create: async (params: Call) => {
          calls.push(params);
          const reply = replies[calls.length - 1];
          if (!reply) throw new Error("unexpected extra call");
          return reply(params);
        },
      },
    },
  };
  return { client: client as unknown as ConstructorParameters<typeof AnthropicDiagnosisModel>[1], calls };
}

const answer = (params: Call) => ({
  model: params.model,
  stop_reason: "end_turn",
  content: [
    { type: "thinking", thinking: "", signature: "x" },
    { type: "text", text: JSON.stringify({ reason: "FORGOT", confidence: 0.4, rationale: "No attempt." }) },
  ],
});
const refusal = (params: Call) => ({ model: params.model, stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] });

describe("AnthropicDiagnosisModel", () => {
  it("defaults to the cheap model, low effort, no server fallback params", async () => {
    const { client, calls } = fakeClient([answer]);
    const r = await new AnthropicDiagnosisModel(undefined, client).classify(input);
    assert.equal(DEFAULT_DIAGNOSIS_MODEL, "claude-haiku-5-5");
    assert.equal(calls[0].model, "claude-haiku-5-5");
    assert.equal((calls[0].output_config as { effort: string }).effort, "low");
    assert.equal(calls[0].fallbacks, undefined);
    assert.equal(calls[0].betas, undefined);
    assert.equal(r.model, "anthropic:claude-haiku-5-5");
    assert.deepEqual(r.output, { reason: "FORGOT", confidence: 0.4, rationale: "No attempt." });
  });

  it("retries a Haiku refusal once on the fallback model, with server fallback on", async () => {
    const { client, calls } = fakeClient([refusal, answer]);
    const r = await new AnthropicDiagnosisModel(undefined, client).classify(input);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].model, REFUSAL_FALLBACK_MODEL);
    assert.equal(calls[1].fallbacks, "default");
    assert.deepEqual(calls[1].betas, ["server-side-fallback-2026-07-01"]);
    assert.equal(r.model, `anthropic:${REFUSAL_FALLBACK_MODEL}`);
    assert.deepEqual(r.refusals, [{ model: "claude-haiku-5-5", category: "general_harms" }]);
  });

  it("first answer has no refusals", async () => {
    const { client } = fakeClient([answer]);
    const r = await new AnthropicDiagnosisModel(undefined, client).classify(input);
    assert.deepEqual(r.refusals, []);
  });

  it("server-side fallback: records the model that answered and the one that refused", async () => {
    const servedByFallback = () => ({
      model: "claude-opus-5",
      stop_reason: "end_turn",
      content: [
        { type: "fallback", from: { model: "claude-opus-5-5" }, to: { model: "claude-opus-5" }, trigger: { type: "refusal", category: "bio" } },
        { type: "text", text: JSON.stringify({ reason: "FORGOT", confidence: 0.3, rationale: "No attempt." }) },
      ],
    });
    const { client } = fakeClient([servedByFallback]);
    const r = await new AnthropicDiagnosisModel("claude-opus-5-5", client).classify(input);
    assert.equal(r.model, "anthropic:claude-opus-5");
    assert.deepEqual(r.refusals, [{ model: "claude-opus-5-5", category: "bio" }]);
  });

  it("refuses to name a model when the response does not say which one answered", async () => {
    const noModel = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ reason: "FORGOT", confidence: 0.3, rationale: "x" }) }] });
    const { client } = fakeClient([noModel]);
    await assert.rejects(new AnthropicDiagnosisModel(undefined, client).classify(input), /does not name the model/);
  });

  it("throws if the fallback also refuses, carrying both refusals", async () => {
    const { client } = fakeClient([refusal, refusal]);
    await assert.rejects(new AnthropicDiagnosisModel(undefined, client).classify(input), (e: unknown) => {
      assert.ok(e instanceof ModelRefusedError);
      assert.deepEqual(e.refusals, [
        { model: "claude-haiku-5-5", category: "general_harms" },
        { model: REFUSAL_FALLBACK_MODEL, category: "general_harms" },
      ]);
      return true;
    });
  });

  it("frontier option uses server-side fallback and does not retry client-side", async () => {
    const { client, calls } = fakeClient([refusal]);
    await assert.rejects(new AnthropicDiagnosisModel("claude-opus-5-5", client).classify(input), /refused/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fallbacks, "default");
    assert.equal((calls[0].output_config as { effort: string }).effort, "medium");
  });

  it("sends the redacted input as the only user content", async () => {
    const { client, calls } = fakeClient([answer]);
    await new AnthropicDiagnosisModel(undefined, client).classify(input);
    const messages = calls[0].messages as { role: string; content: string }[];
    assert.equal(messages.length, 1);
    assert.ok(messages[0].content.includes(JSON.stringify(input, null, 2)));
  });
});

describe("getDiagnosisModel", () => {
  const saved = { provider: process.env.DIAGNOSIS_MODEL_PROVIDER, model: process.env.DIAGNOSIS_MODEL };
  afterEach(() => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = saved.provider ?? "";
    process.env.DIAGNOSIS_MODEL = saved.model ?? "";
  });

  it("returns null when no provider is set", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "";
    assert.equal(getDiagnosisModel(), null);
  });

  it("PROVIDER unset or none with MODEL set: still rules only, with a warning", () => {
    for (const provider of ["", "none"]) {
      process.env.DIAGNOSIS_MODEL_PROVIDER = provider;
      process.env.DIAGNOSIS_MODEL = "claude-opus-5-5";
      const warnings: unknown[] = [];
      const original = console.warn;
      console.warn = (...args: unknown[]) => void warnings.push(args);
      try {
        assert.equal(getDiagnosisModel(), null);
      } finally {
        console.warn = original;
      }
      assert.equal(warnings.length, 1);
    }
  });

  it("PROVIDER anthropic with MODEL unset uses the default model", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "anthropic";
    process.env.DIAGNOSIS_MODEL = "";
    const m = getDiagnosisModel();
    assert.ok(m instanceof AnthropicDiagnosisModel);
    assert.equal((m as unknown as { model: string }).model, DEFAULT_DIAGNOSIS_MODEL);
  });

  it("PROVIDER anthropic with MODEL set uses that model", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "anthropic";
    process.env.DIAGNOSIS_MODEL = "claude-opus-5-5";
    assert.equal((getDiagnosisModel() as unknown as { model: string }).model, "claude-opus-5-5");
  });

  it("PROVIDER anthropic rejects a MODEL that is not a claude id", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "anthropic";
    process.env.DIAGNOSIS_MODEL = "gemini-2.5-flash-lite";
    assert.throws(() => getDiagnosisModel(), /not an Anthropic model id/);
  });

  it("rejects an unknown provider", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "other";
    assert.throws(() => getDiagnosisModel(), /unknown/);
  });
});
