import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseStall, validateClassification, type DiagnosisRow, type DiagnosisStore, type StallForDiagnosis } from "@/lib/diagnose";
import type { DiagnosisModel } from "@/lib/diagnosis-model";
import { classifyGatewayResponse } from "@/lib/gateway-rules";
import { PiiLeakError, assertNoPii, buildModelInput, knownIdentifiers, scrubText } from "@/lib/redact";
import type { ModelInput } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";

const NOW = new Date("2026-10-16T10:00:00Z");

// Mirrors the two real test-mode stalls in the table.
const customer = {
  id: 408932014,
  email: "unstall.test@example.com",
  phone: "+2348012345678",
  first_name: "Adaeze",
  last_name: "Okonkwo",
  customer_code: "CUS_abc123xyz",
};

const realFailed: StallForDiagnosis = {
  id: "stall-failed",
  status: "new",
  gateway_response: "Declined",
  amount: 100000,
  currency: "NGN",
  event_type: "transaction.failed",
  customer_identifier: customer.email,
  payload: { reference: "9v85euqujlld90l", status: "failed", gateway_response: "Declined", customer, ip_address: "102.89.1.20" },
};

const realAbandoned: StallForDiagnosis = {
  id: "stall-abandoned",
  status: "new",
  gateway_response: "Transaction declined. Please use the test card.",
  amount: 100000,
  currency: "NGN",
  event_type: "transaction.abandoned",
  customer_identifier: customer.email,
  payload: {
    reference: "yi8ijvdw7mjns54",
    status: "abandoned",
    gateway_response: "Transaction declined. Please use the test card.",
    customer,
    ip_address: "102.89.1.20",
  },
};

function verified(row: StallForDiagnosis, paystackStatus: string, ageMs = 30_000): VerifiedStall {
  return {
    id: row.id,
    reference: "ref",
    paystackStatus,
    gatewayResponse: row.gateway_response,
    verifiedAt: new Date(NOW.getTime() - ageMs),
  } as VerifiedStall;
}

function memoryStore(rows: StallForDiagnosis[]) {
  const saved: DiagnosisRow[] = [];
  const store: DiagnosisStore = {
    async loadStall(id) {
      const row = rows.find((r) => r.id === id);
      if (!row) throw new Error("not found");
      return row;
    },
    async saveDiagnosis(row) {
      saved.push(row);
    },
  };
  return { store, saved };
}

const modelMustNotBeCalled: DiagnosisModel = {
  async classify() {
    throw new Error("model was called but should not have been");
  },
};

describe("real test cases", () => {
  it("9v85euqujlld90l (failed, 'Declined') is CARD_FAILING", async () => {
    const { store, saved } = memoryStore([realFailed]);
    const r = await diagnoseStall(verified(realFailed, "failed"), { store, model: modelMustNotBeCalled, now: () => NOW });
    assert.equal(r.reason, "CARD_FAILING");
    assert.equal(r.source, "rules");
    assert.equal(saved.length, 1);
    assert.equal(saved[0].reason, "CARD_FAILING");
  });

  it("yi8ijvdw7mjns54 (abandoned by Paystack, decline text) is CARD_FAILING, not FORGOT", async () => {
    const { store, saved } = memoryStore([realAbandoned]);
    const r = await diagnoseStall(verified(realAbandoned, "abandoned"), { store, model: modelMustNotBeCalled, now: () => NOW });
    assert.equal(r.reason, "CARD_FAILING");
    assert.equal(saved[0].reason, "CARD_FAILING");
    assert.ok(r.confidence > 0 && r.confidence <= 1);
    assert.ok(r.rationale.length > 0);
  });
});

describe("gateway_response rules", () => {
  const cases: [string | null, string | null][] = [
    ["Declined", "CARD_FAILING"],
    ["Transaction declined. Please use the test card.", "CARD_FAILING"],
    ["Do Not Honor", "CARD_FAILING"],
    ["Expired Card", "CARD_FAILING"],
    ["Incorrect PIN", "CARD_FAILING"],
    ["Insufficient Funds", "NO_FUNDS_NOW"],
    ["Declined - insufficient funds", "NO_FUNDS_NOW"],
    ["Exceeds withdrawal limit", "NO_FUNDS_NOW"],
    ["Issuer or Switch Inoperative", "PROVIDER_DOWN"],
    ["System malfunction", "PROVIDER_DOWN"],
    ["The transaction was not completed", null],
    ["", null],
    [null, null],
  ];
  for (const [text, expected] of cases) {
    it(`${JSON.stringify(text)} -> ${expected}`, () => {
      assert.equal(classifyGatewayResponse(text)?.reason ?? null, expected);
    });
  }
});

describe("model path", () => {
  const noSignal: StallForDiagnosis = {
    id: "stall-quiet",
    status: "new",
    gateway_response: "The transaction was not completed",
    amount: 250000,
    currency: "NGN",
    event_type: "transaction.abandoned",
    customer_identifier: customer.email,
    payload: {
      event: "charge.failed",
      data: {
        status: "abandoned",
        channel: "card",
        customer,
        ip_address: "102.89.1.20",
        metadata: { full_name: "Adaeze Okonkwo", note: "call me on 08012345678" },
        authorization: { authorization_code: "AUTH_zzz999", card_type: "visa", bank: "TEST BANK", last4: "4081", bin: "408408", account_name: "ADAEZE OKONKWO" },
        log: {
          time_spent: 240,
          attempts: 0,
          errors: 0,
          mobile: true,
          history: [
            { type: "action", message: "Opened checkout for unstall.test@example.com", time: 1 },
            { type: "action", message: "Viewed payment options", time: 30 },
          ],
        },
      },
    },
  };

  it("sends only allowlisted, redacted fields and records the model id", async () => {
    let seen: ModelInput | null = null;
    const model: DiagnosisModel = {
      async classify(input) {
        seen = input;
        return { output: { reason: "UNANSWERED_QUESTION", confidence: 0.41, rationale: "Long dwell, no attempt." }, model: "fake:model-1" };
      },
    };
    const { store, saved } = memoryStore([noSignal]);
    const r = await diagnoseStall(verified(noSignal, "abandoned"), { store, model, now: () => NOW });

    assert.equal(r.source, "model");
    assert.equal(saved[0].model, "fake:model-1");
    const sent = JSON.stringify(seen);
    for (const leak of ["example.com", "Adaeze", "Okonkwo", "08012345678", "2348012345678", "102.89", "CUS_", "AUTH_", "4081", "408408", "408932014"]) {
      assert.ok(!sent.includes(leak), `model input leaked ${leak}`);
    }
    for (const field of ["status", "abandoned_by", "event_type", "source", "metadata", "reference"]) {
      assert.ok(!sent.includes(`"${field}"`), `model input includes field ${field}`);
    }
    assert.ok(sent.includes("The transaction was not completed"));
    assert.ok(sent.includes("[email]"), "email inside free text is scrubbed, not dropped silently");
  });

  it("throws instead of guessing when no model is configured", async () => {
    const { store, saved } = memoryStore([noSignal]);
    await assert.rejects(diagnoseStall(verified(noSignal, "abandoned"), { store, model: null, now: () => NOW }), /no DIAGNOSIS_MODEL_PROVIDER/);
    assert.equal(saved.length, 0);
  });

  it("rejects malformed model output without saving", async () => {
    const model: DiagnosisModel = { async classify() { return { output: { reason: "MAYBE", confidence: 2, rationale: "" }, model: "fake" }; } };
    const { store, saved } = memoryStore([noSignal]);
    await assert.rejects(diagnoseStall(verified(noSignal, "abandoned"), { store, model, now: () => NOW }));
    assert.equal(saved.length, 0);
  });
});

describe("PII gate", () => {
  it("refuses a pattern leak", () => {
    assert.throws(() => assertNoPii({ note: "reach me at a@b.co" }, []), PiiLeakError);
    assert.throws(() => assertNoPii({ note: "ip 10.0.0.1" }, []), PiiLeakError);
    assert.throws(() => assertNoPii({ note: "+234 801 234 5678" }, []), PiiLeakError);
  });

  it("refuses a known identifier no pattern would catch", () => {
    assert.throws(() => assertNoPii({ steps: [{ message: "Adaeze typed card" }] }, ["Adaeze"]), PiiLeakError);
  });

  it("error never contains the leaked value", () => {
    try {
      assertNoPii({ note: "secret@person.com" }, []);
      assert.fail("expected throw");
    } catch (e) {
      assert.ok(!(e as Error).message.includes("secret@person.com"));
    }
  });

  it("built input for the real rows passes the gate", () => {
    for (const row of [realFailed, realAbandoned]) {
      assert.doesNotThrow(() => assertNoPii(buildModelInput(row, row.gateway_response), knownIdentifiers(row)));
    }
  });

  it("scrubText redacts each kind", () => {
    assert.equal(scrubText("a@b.co 10.0.0.1 CUS_x1 +2348012345678"), "[email] [ip] [code] [number]");
  });
});

describe("guards", () => {
  it("refuses a stale verification before touching the store", async () => {
    const { store, saved } = memoryStore([realFailed]);
    await assert.rejects(
      diagnoseStall(verified(realFailed, "failed", 10 * 60_000), { store, model: modelMustNotBeCalled, now: () => NOW }),
      /re-verify/,
    );
    assert.equal(saved.length, 0);
  });

  it("refuses a resolved stall", async () => {
    const { store } = memoryStore([{ ...realFailed, status: "resolved" }]);
    await assert.rejects(diagnoseStall(verified(realFailed, "failed"), { store, model: modelMustNotBeCalled, now: () => NOW }), /resolved/);
  });

  it("surfaces the database guard's refusal", async () => {
    const store: DiagnosisStore = {
      loadStall: async () => realFailed,
      saveDiagnosis: async () => {
        throw new Error("stall x not re-verified with Paystack in the last 10 minutes; refusing");
      },
    };
    await assert.rejects(diagnoseStall(verified(realFailed, "failed"), { store, model: modelMustNotBeCalled, now: () => NOW }), /refusing/);
  });

  it("validateClassification rounds confidence and scrubs the rationale", () => {
    const c = validateClassification({ reason: "FORGOT", confidence: 0.123456, rationale: "Customer x@y.io never attempted." });
    assert.equal(c.confidence, 0.123);
    assert.ok(!c.rationale.includes("x@y.io"));
  });
});
