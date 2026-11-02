import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { diagnoseStall, type DiagnosisRow, type DiagnosisStore, type StallForDiagnosis } from "@/lib/diagnose";
import { DEFAULT_GROQ_MODEL, GroqDiagnosisModel, ModelRefusedError, ModelUnparseableError, OUTPUT_SCHEMA, getDiagnosisModel } from "@/lib/diagnosis-model";
import { PiiLeakError, UNAVAILABLE, type ModelInput } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";

const input: ModelInput = {
  gateway_response: "The transaction was not completed",
  amount_minor_units: 250000,
  currency: "NGN",
  payment_channel: "card",
  is_subscription_renewal: false,
  card: { available: false, why: UNAVAILABLE.card },
  checkout: { available: false, why: UNAVAILABLE.checkout },
  behaviour_trail: { available: false, why: UNAVAILABLE.behaviourTrail },
};

type Call = Record<string, unknown>;
const ANSWER = { reason: "FORGOT", confidence: 0.3, rationale: "No attempt recorded." };

function fakeGroq(reply: (params: Call, n: number) => object, served: string[] = [DEFAULT_GROQ_MODEL]) {
  const calls: Call[] = [];
  let listCalls = 0;
  const client = {
    models: { list: async () => (listCalls++, { data: served.map((id) => ({ id })) }) },
    chat: { completions: { create: async (params: Call) => (calls.push(params), reply(params, calls.length)) } },
  };
  return { client: client as unknown as ConstructorParameters<typeof GroqDiagnosisModel>[1], calls, listCalls: () => listCalls };
}

const answer = (content: unknown) => (p: Call) => ({
  model: p.model,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) } }],
});

describe("GroqDiagnosisModel", () => {
  it("sends strict structured output, the shared system prompt and only the redacted input", async () => {
    const { client, calls } = fakeGroq(answer(ANSWER));
    const r = await new GroqDiagnosisModel(undefined, client).classify(input);
    assert.equal(calls[0].model, DEFAULT_GROQ_MODEL);
    assert.deepEqual(calls[0].response_format, { type: "json_schema", json_schema: { name: "diagnosis", strict: true, schema: OUTPUT_SCHEMA } });
    const messages = calls[0].messages as { role: string; content: string }[];
    assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
    assert.ok(messages[1].content.endsWith(JSON.stringify(input, null, 2)));
    assert.deepEqual(r, { output: ANSWER, model: `groq:${DEFAULT_GROQ_MODEL}`, refusals: [] });
  });

  it("records the model the response names, not the one requested", async () => {
    const { client } = fakeGroq(() => ({ ...answer(ANSWER)({ model: "x" }), model: "openai/gpt-oss-120b-2026" }));
    const r = await new GroqDiagnosisModel(undefined, client).classify(input);
    assert.equal(r.model, "groq:openai/gpt-oss-120b-2026");
  });

  it("throws rather than guess when the response names no model", async () => {
    const { client } = fakeGroq(() => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(ANSWER) } }] }));
    await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), /does not name the model/);
  });

  it("refuses to call a model Groq no longer serves, and says what to do", async () => {
    const { client, calls } = fakeGroq(answer(ANSWER), ["llama-3.3-70b-versatile"]);
    await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), /does not currently serve "openai\/gpt-oss-120b"; set DIAGNOSIS_MODEL/);
    assert.equal(calls.length, 0);
  });

  it("checks the model list once per instance", async () => {
    const { client, listCalls } = fakeGroq(answer(ANSWER));
    const m = new GroqDiagnosisModel(undefined, client);
    await m.classify(input);
    await m.classify(input);
    assert.equal(listCalls(), 1);
  });

  for (const [label, content] of [["prose", "I can't help with that."], ["empty", ""], ["a JSON array", "[]"]] as const) {
    it(`a ${label} reply twice is unparseable, never a refusal`, async () => {
      const { client, calls } = fakeGroq(answer(content));
      await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), (e: unknown) => {
        assert.ok(e instanceof ModelUnparseableError, "must not be reported as anything else");
        assert.ok(!(e instanceof ModelRefusedError));
        assert.equal(e.model, DEFAULT_GROQ_MODEL);
        assert.equal(e.attempts, 2);
        assert.ok(!e.message.includes("help with that"), "error quotes the reply");
        return true;
      });
      assert.equal(calls.length, 2, "retried exactly once");
    });
  }

  it("a reply with no choices is unparseable too", async () => {
    const { client, calls } = fakeGroq((p) => ({ model: p.model, choices: [] }));
    await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), ModelUnparseableError);
    assert.equal(calls.length, 2);
  });

  it("one unparseable reply then an answer: retried once, and the answer is used", async () => {
    const { client, calls } = fakeGroq((p, n) => (n === 1 ? answer("not json")(p) : answer(ANSWER)(p)));
    const r = await new GroqDiagnosisModel(undefined, client).classify(input);
    assert.equal(calls.length, 2);
    assert.deepEqual(r.output, ANSWER);
    assert.deepEqual(r.refusals, []);
  });

  it("an explicit refusal field is a reported refusal, and is not retried", async () => {
    const { client, calls } = fakeGroq((p) => ({ model: p.model, choices: [{ finish_reason: "stop", message: { content: null, refusal: "No." } }] }));
    await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), (e: unknown) => {
      assert.ok(e instanceof ModelRefusedError);
      assert.deepEqual(e.refusals, [{ model: DEFAULT_GROQ_MODEL, category: "refusal" }]);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it("a truncated reply is an error, not a refusal", async () => {
    const { client } = fakeGroq((p) => ({ model: p.model, choices: [{ finish_reason: "length", message: { content: "{\"rea" } }] }));
    await assert.rejects(new GroqDiagnosisModel(undefined, client).classify(input), (e: unknown) => !(e instanceof ModelRefusedError) && /truncated/.test((e as Error).message));
  });
});

describe("Groq through diagnoseStall", () => {
  const NOW = new Date("2026-11-02T10:00:00Z");
  const stall: StallForDiagnosis = {
    id: "stall-groq",
    status: "new",
    gateway_response: "The transaction was not completed",
    amount: 250000,
    currency: "NGN",
    event_type: "transaction.abandoned",
    customer_identifier: "buyer@example.com",
    payload: { status: "abandoned", customer: { email: "buyer@example.com", first_name: "Adaeze" } },
  };
  const verified = (row: StallForDiagnosis) =>
    ({ id: row.id, reference: "ref", paystackStatus: "abandoned", gatewayResponse: row.gateway_response, verifiedAt: new Date(NOW.getTime() - 30_000) }) as VerifiedStall;
  function store() {
    const saved: DiagnosisRow[] = [];
    const flags: { stallId: string; reason: string }[] = [];
    const s: DiagnosisStore = {
      loadStall: async (id) => ({ ...stall, id }),
      saveDiagnosis: async (row) => void saved.push(row),
      flagBlocked: async (stallId, reason) => void flags.push({ stallId, reason }),
    };
    return { s, saved, flags };
  }

  it("the diagnoses row names the Groq model that answered", async () => {
    const { client } = fakeGroq(answer(ANSWER));
    const { s, saved } = store();
    await diagnoseStall(verified(stall), { store: s, model: new GroqDiagnosisModel(undefined, client), now: () => NOW, log: () => {} });
    assert.equal(saved[0].model, `groq:${DEFAULT_GROQ_MODEL}`);
  });

  it("two unparseable Groq replies flag the stall as unparseable, not refused, and save nothing", async () => {
    const { client, calls } = fakeGroq(answer("Sorry, I cannot do that."));
    const { s, saved, flags } = store();
    const lines: string[] = [];
    await assert.rejects(
      diagnoseStall(verified(stall), { store: s, model: new GroqDiagnosisModel(undefined, client), now: () => NOW, log: (l) => lines.push(l) }),
      ModelUnparseableError,
    );
    assert.equal(calls.length, 2);
    assert.equal(saved.length, 0);
    assert.deepEqual(flags, [{ stallId: "stall-groq", reason: `model_unparseable: ${DEFAULT_GROQ_MODEL} (2 attempts)` }]);
    assert.ok(!flags[0].reason.includes("refused"));
    assert.ok(!lines.some((l) => l.includes("refused")), "logged as a refusal");
    assert.ok(lines.some((l) => l.includes("diagnosis blocked (model_unparseable")));
  });

  it("a reported Groq refusal flags the stall as refused", async () => {
    const { client } = fakeGroq((p) => ({ model: p.model, choices: [{ finish_reason: "stop", message: { content: null, refusal: "No." } }] }));
    const { s, flags } = store();
    await assert.rejects(
      diagnoseStall(verified(stall), { store: s, model: new GroqDiagnosisModel(undefined, client), now: () => NOW, log: () => {} }),
      ModelRefusedError,
    );
    assert.deepEqual(flags, [{ stallId: "stall-groq", reason: `model_refused: ${DEFAULT_GROQ_MODEL} (refusal)` }]);
  });

  it("an unparseable reply followed by an answer is saved, with no flag", async () => {
    const { client } = fakeGroq((p, n) => (n === 1 ? answer("oops")(p) : answer(ANSWER)(p)));
    const { s, saved, flags } = store();
    await diagnoseStall(verified(stall), { store: s, model: new GroqDiagnosisModel(undefined, client), now: () => NOW, log: () => {} });
    assert.equal(saved.length, 1);
    assert.deepEqual(flags, []);
  });

  it("the PII gate runs before Groq is called: a leak means zero Groq calls and a flag", async () => {
    const { client, calls, listCalls } = fakeGroq(answer(ANSWER));
    const leaky = { ...stall, id: "stall-leaky", gateway_response: "Adaeze cancelled" };
    const { s, flags } = store();
    s.loadStall = async () => leaky;
    await assert.rejects(
      diagnoseStall(verified(leaky), { store: s, model: new GroqDiagnosisModel(undefined, client), now: () => NOW, log: () => {} }),
      PiiLeakError,
    );
    assert.equal(calls.length, 0);
    assert.equal(listCalls(), 0);
    assert.deepEqual(flags, [{ stallId: "stall-leaky", reason: "pii_gate: identifier at input.gateway_response" }]);
  });
});

describe("getDiagnosisModel with groq", () => {
  const saved = { provider: process.env.DIAGNOSIS_MODEL_PROVIDER, model: process.env.DIAGNOSIS_MODEL, key: process.env.GROQ_API_KEY };
  afterEach(() => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = saved.provider ?? "";
    process.env.DIAGNOSIS_MODEL = saved.model ?? "";
    if (saved.key === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved.key;
  });

  it("groq with MODEL unset uses the default Groq model", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "groq";
    process.env.DIAGNOSIS_MODEL = "";
    process.env.GROQ_API_KEY = "test";
    const m = getDiagnosisModel();
    assert.ok(m instanceof GroqDiagnosisModel);
    assert.equal((m as unknown as { model: string }).model, DEFAULT_GROQ_MODEL);
  });

  it("groq with MODEL set uses that model", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "groq";
    process.env.DIAGNOSIS_MODEL = "llama-3.3-70b-versatile";
    process.env.GROQ_API_KEY = "test";
    assert.equal((getDiagnosisModel() as unknown as { model: string }).model, "llama-3.3-70b-versatile");
  });

  it("groq rejects a Claude model id", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "groq";
    process.env.DIAGNOSIS_MODEL = "claude-haiku-5-5";
    assert.throws(() => getDiagnosisModel(), /not a Groq model id/);
  });

  it("none with MODEL set is still rules only", () => {
    process.env.DIAGNOSIS_MODEL_PROVIDER = "none";
    process.env.DIAGNOSIS_MODEL = "openai/gpt-oss-120b";
    const original = console.warn;
    console.warn = () => {};
    try {
      assert.equal(getDiagnosisModel(), null);
    } finally {
      console.warn = original;
    }
  });
});
