// INSUFFICIENT_EVIDENCE: the model's alternative to guessing (issue #10).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseStall, validateClassification, type DiagnosisRow, type DiagnosisStore, type StallForDiagnosis } from "@/lib/diagnose";
import { OUTPUT_SCHEMA, SYSTEM_PROMPT, type DiagnosisModel } from "@/lib/diagnosis-model";
import { describeEvidenceNeeded, evidenceGaps, merchantView } from "@/lib/evidence";
import { classifyGatewayResponse } from "@/lib/gateway-rules";
import { INSUFFICIENT_EVIDENCE, OUTCOMES, REASONS, isReason } from "@/lib/reasons";
import { buildModelInput } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";

const NOW = new Date("2026-11-02T10:00:00Z");

// Shaped like T169809891137085: abandoned, "not completed", no log, no card.
const t1698: StallForDiagnosis = {
  id: "stall-t1698",
  status: "new",
  gateway_response: "The transaction was not completed",
  amount: 250000,
  currency: "NGN",
  event_type: "transaction.abandoned",
  customer_identifier: "buyer@example.com",
  payload: { reference: "T169809891137085", status: "abandoned", gateway_response: "The transaction was not completed", channel: "card" },
};

const declines: StallForDiagnosis[] = [
  { ...t1698, id: "stall-9v85", gateway_response: "Declined", event_type: "transaction.failed", payload: { reference: "9v85euqujlld90l", status: "failed", gateway_response: "Declined" } },
  {
    ...t1698,
    id: "stall-yi8i",
    gateway_response: "Transaction declined. Please use the test card.",
    payload: { reference: "yi8ijvdw7mjns54", status: "abandoned", gateway_response: "Transaction declined. Please use the test card." },
  },
];

const verified = (row: StallForDiagnosis) =>
  ({ id: row.id, reference: "ref", paystackStatus: "abandoned", gatewayResponse: row.gateway_response, verifiedAt: new Date(NOW.getTime() - 30_000) }) as VerifiedStall;

function memoryStore(rows: StallForDiagnosis[]) {
  const saved: DiagnosisRow[] = [];
  const store: DiagnosisStore = {
    loadBehaviourEvents: async () => [],
    countMerchants: async () => 1,
    loadStall: async (id) => rows.find((r) => r.id === id)!,
    saveDiagnosis: async (row) => void saved.push(row),
    flagBlocked: async () => {},
  };
  return { store, saved };
}

const modelSays = (output: object): DiagnosisModel => ({ classify: async () => ({ output, model: "fake:m", refusals: [] }) });
const modelMustNotBeCalled: DiagnosisModel = { classify: async () => assert.fail("model called") };

describe("INSUFFICIENT_EVIDENCE", () => {
  it("is an outcome but not a reason, so it can never map to a remedy", () => {
    assert.ok((OUTCOMES as readonly string[]).includes(INSUFFICIENT_EVIDENCE));
    assert.ok(!(REASONS as readonly string[]).includes(INSUFFICIENT_EVIDENCE));
    assert.equal(isReason(INSUFFICIENT_EVIDENCE), false);
  });

  it("the model can return it: it is in the output schema and the prompt says when", () => {
    assert.ok((OUTPUT_SCHEMA.properties.reason.enum as string[]).includes(INSUFFICIENT_EVIDENCE));
    assert.match(SYSTEM_PROMPT, /return INSUFFICIENT_EVIDENCE instead of guessing/);
    assert.match(SYSTEM_PROMPT, /Never return INSUFFICIENT_EVIDENCE when gateway_response describes a decline/);
    assert.match(SYSTEM_PROMPT, /Do not list what evidence is missing/);
    assert.equal(validateClassification({ reason: INSUFFICIENT_EVIDENCE, confidence: 0.8, rationale: "Cannot separate." }).reason, INSUFFICIENT_EVIDENCE);
  });

  it("T169809891137085: stored as INSUFFICIENT_EVIDENCE with every gap listed by code", async () => {
    const { store, saved } = memoryStore([t1698]);
    const r = await diagnoseStall(verified(t1698), {
      store,
      model: modelSays({ reason: INSUFFICIENT_EVIDENCE, confidence: 0.8, rationale: "The facts cannot separate NO_TRUST, UNANSWERED_QUESTION and FORGOT." }),
      now: () => NOW,
      log: () => {},
    });
    assert.equal(r.reason, INSUFFICIENT_EVIDENCE);
    assert.equal(saved[0].reason, INSUFFICIENT_EVIDENCE);
    assert.deepEqual(saved[0].evidence_gaps, ["behaviour_trail", "checkout_log", "card_details"]);

    const shown = describeEvidenceNeeded(saved[0].evidence_gaps);
    assert.equal(shown.summary, "Could not determine why this payment stalled.");
    assert.ok(shown.needed.some((n) => n.includes("no behaviour trail was received")));
    assert.ok(shown.needed.some((n) => n.includes("no checkout log")));
  });

  it("the evidence list is never written by the model: anything it sends is ignored", async () => {
    const { store, saved } = memoryStore([t1698]);
    await diagnoseStall(verified(t1698), {
      store,
      model: modelSays({ reason: INSUFFICIENT_EVIDENCE, confidence: 0.7, rationale: "x", evidence_gaps: ["card_details"], needed: ["the buyer's phone number"] }),
      now: () => NOW,
      log: () => {},
    });
    assert.deepEqual(saved[0].evidence_gaps, ["behaviour_trail", "checkout_log", "card_details"]);
    assert.ok(!JSON.stringify(saved[0]).includes("phone number"));
  });

  it("the gaps reflect the input: an available checkout log is not listed", () => {
    const withLog = { ...t1698, payload: { ...(t1698.payload as object), log: { time_spent: 30, attempts: 1, errors: 0, mobile: true, history: [] } } };
    assert.deepEqual(evidenceGaps(buildModelInput(withLog, withLog.gateway_response)), ["behaviour_trail", "card_details"]);
  });

  it("the two real declines still come back CARD_FAILING, from the rules, without the model", async () => {
    for (const row of declines) {
      const { store, saved } = memoryStore([row]);
      const r = await diagnoseStall(verified(row), { store, model: modelMustNotBeCalled, now: () => NOW });
      assert.equal(r.reason, "CARD_FAILING");
      assert.equal(r.source, "rules");
      assert.deepEqual(saved[0].evidence_gaps, []);
    }
  });

  it("the rules never return INSUFFICIENT_EVIDENCE, whatever the text", () => {
    const texts = [
      "Declined",
      "Insufficient Funds",
      "insufficient evidence",
      "INSUFFICIENT_EVIDENCE",
      "Could not determine",
      "The transaction was not completed",
      "Issuer or Switch Inoperative",
      "",
    ];
    for (const t of texts) {
      const r = classifyGatewayResponse(t);
      assert.ok(r === null || isReason(r.reason), `rules returned ${r?.reason} for ${JSON.stringify(t)}`);
    }
    assert.equal(classifyGatewayResponse("Insufficient Funds")?.reason, "NO_FUNDS_NOW");
  });

  it("describeEvidenceNeeded is deterministic and has a fallback for no gaps", () => {
    assert.deepEqual(describeEvidenceNeeded(["checkout_log"]), describeEvidenceNeeded(["checkout_log"]));
    assert.equal(describeEvidenceNeeded([]).needed.length, 1);
  });

  it("an empty Paystack authorization is a card_details gap, not available-with-nulls", () => {
    for (const authorization of [{}, { card_type: null, bank: null, brand: null, country_code: null }]) {
      const row = { ...t1698, payload: { ...(t1698.payload as object), authorization } };
      const input = buildModelInput(row, row.gateway_response);
      assert.deepEqual(input.card.available, false);
      assert.deepEqual(evidenceGaps(input), ["behaviour_trail", "checkout_log", "card_details"]);
    }
  });

  it("an empty Paystack log is a checkout_log gap", () => {
    const row = { ...t1698, payload: { ...(t1698.payload as object), log: {} } };
    assert.ok(evidenceGaps(buildModelInput(row, row.gateway_response)).includes("checkout_log"));
  });

  it("real card details are still available, and not listed as a gap", () => {
    const row = { ...t1698, payload: { ...(t1698.payload as object), authorization: { card_type: "visa", bank: "TEST BANK" } } };
    const input = buildModelInput(row, row.gateway_response);
    assert.equal(input.card.available, true);
    assert.ok(!evidenceGaps(input).includes("card_details"));
  });

  it("the merchant never sees a confidence figure on INSUFFICIENT_EVIDENCE", () => {
    const view = merchantView({ reason: INSUFFICIENT_EVIDENCE, confidence: 0.85, evidenceGaps: ["behaviour_trail", "checkout_log"] });
    assert.equal(view.kind, "undetermined");
    assert.ok(!("confidence" in view));
    const text = JSON.stringify(view);
    assert.ok(!/0\.85|85|%/.test(text), `merchant view shows a number: ${text}`);
    assert.equal((view as { summary: string }).summary, "Could not determine why this payment stalled.");
  });

  it("a real reason is shown with its confidence", () => {
    assert.deepEqual(merchantView({ reason: "CARD_FAILING", confidence: 0.95, evidenceGaps: [] }), { kind: "diagnosed", reason: "CARD_FAILING", confidence: 0.95 });
  });
});
