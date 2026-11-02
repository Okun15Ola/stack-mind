// Negative corpus for the PII gate: legitimate input that must NOT be refused.
// assertNoPii() fails closed, so a false positive leaves a valid stall
// undiagnosed. Every string here is real or published Paystack text, or a
// value that legitimately appears in model input.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoPii, buildModelInput, knownIdentifiers, scrubText, type StallForModel } from "@/lib/redact";

// A stall carrying a full set of customer identifiers, so the gate's
// identifier matching is exercised alongside its patterns.
const thisStall = {
  id: "5b0c6f1e-6a7e-4b55-9f39-0d2f4d1b9a11",
  customer_identifier: "buyer@example.com",
  payload: {
    id: 4099260516,
    reference: "T169809891137085",
    ip_address: "102.89.1.20",
    customer: { id: 408932014, email: "buyer@example.com", phone: "+2348031234567", first_name: "Adaeze", last_name: "Okonkwo", customer_code: "CUS_abc123xyz" },
    authorization: { authorization_code: "AUTH_zzz999", bin: "408408", last4: "4081", card_type: "visa", bank: "TEST BANK", country_code: "NG" },
  },
};
const known = knownIdentifiers(thisStall);

function passes(gatewayResponse: string, extra: Partial<StallForModel> = {}) {
  const row: StallForModel = {
    gateway_response: gatewayResponse,
    amount: 250000,
    currency: "NGN",
    event_type: "transaction.abandoned",
    payload: thisStall.payload,
    ...extra,
  };
  const input = buildModelInput(row, gatewayResponse);
  assert.doesNotThrow(() => assertNoPii(input, known), `gate refused ${JSON.stringify(gatewayResponse)}`);
  // Legitimate text reaches the model as written, not scrubbed.
  assert.equal(input.gateway_response, gatewayResponse);
  assert.equal(scrubText(gatewayResponse), gatewayResponse);
}

describe("PII gate negative corpus: real ingested stalls", () => {
  it("9v85euqujlld90l: 'Declined'", () => passes("Declined"));
  it("yi8ijvdw7mjns54: 'Transaction declined. Please use the test card.'", () =>
    passes("Transaction declined. Please use the test card."));
});

describe("PII gate negative corpus: Paystack customer-side failure reasons", () => {
  const reasons = [
    "Insufficient Funds",
    "Balance not sufficient",
    "Payer has reached their limit",
    "Expired Card",
    "Invalid card number",
    "Incorrect PIN",
    "PIN tries exceeded",
    "Invalid OTP",
    "Token Expired",
    "The transaction was not completed",
  ];
  for (const r of reasons) it(JSON.stringify(r), () => passes(r));
});

describe("PII gate negative corpus: amounts in kobo, 3 to 9 digits", () => {
  const amounts = [100, 5000, 25000, 250000, 1500000, 15000000, 150000000, 999999999];
  for (const amount of amounts) {
    it(`${amount} as amount_minor_units`, () => passes("Insufficient Funds", { amount }));
    it(`${amount} inside checkout text`, () => {
      const input = buildModelInput(
        {
          gateway_response: "Insufficient Funds",
          amount,
          currency: "NGN",
          event_type: "transaction.failed",
          payload: { ...thisStall.payload, log: { time_spent: 40, attempts: 1, errors: 1, mobile: false, history: [{ type: "error", message: `Attempted to pay ${amount}`, time: 38 }] } },
        },
        "Insufficient Funds",
      );
      assert.doesNotThrow(() => assertNoPii(input, known));
      assert.equal(input.checkout?.steps[0].message, `Attempted to pay ${amount}`);
    });
  }
});

describe("PII gate negative corpus: another stall's transaction id", () => {
  // 16 digits, passes Luhn by chance, belongs to a different stall. It is
  // indistinguishable from a card number, so it is redacted to [card] on the
  // way in; what matters here is that the stall is still diagnosable.
  const otherStallId = "4169809891137088";
  const input = buildModelInput(
    {
      gateway_response: "The transaction was not completed",
      amount: 250000,
      currency: "NGN",
      event_type: "transaction.abandoned",
      payload: { ...thisStall.payload, log: { time_spent: 12, attempts: 0, errors: 0, mobile: true, history: [{ type: "action", message: `Retried after transaction ${otherStallId}`, time: 5 }] } },
    },
    "The transaction was not completed",
  );

  it("does not stop diagnosis", () => {
    assert.ok(!known.includes(otherStallId), "the id must not be one of this stall's identifiers");
    assert.doesNotThrow(() => assertNoPii(input, known));
  });

  it("reaches the model redacted, never as raw digits", () => {
    assert.equal(input.checkout?.steps[0].message, "Retried after transaction [card]");
  });
});
