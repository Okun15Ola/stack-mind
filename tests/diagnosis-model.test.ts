import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  AnthropicDiagnosisModel,
  DEFAULT_DIAGNOSIS_MODEL,
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
  });

  it("throws if the fallback also refuses", async () => {
    const { client } = fakeClient([refusal, refusal]);
    await assert.rejects(new AnthropicDiagnosisModel(undefined, client).classify(input), /refused/);
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

  it("rejects an unknown provider", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "other";
    assert.throws(() => getDiagnosisModel(), /unknown/);
  });
});
