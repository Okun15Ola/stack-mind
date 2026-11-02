// A gap in our pipeline must never reach the model as a fact about the buyer.
// Real case: T169809891137085, where a bare `checkout: null` was read as "no
// recorded checkout activity, so the payment was likely never attempted".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SYSTEM_PROMPT } from "@/lib/diagnosis-model";
import { UNAVAILABLE, assertNoPii, buildModelInput, knownIdentifiers, type StallForModel } from "@/lib/redact";

// Shaped like T169809891137085: abandoned, no log, no authorization.
const noTrail: StallForModel & { customer_identifier: string } = {
  gateway_response: "The transaction was not completed",
  amount: 250000,
  currency: "NGN",
  event_type: "transaction.abandoned",
  customer_identifier: "buyer@example.com",
  payload: { reference: "T169809891137085", status: "abandoned", gateway_response: "The transaction was not completed", channel: "card" },
};

const withLog: StallForModel & { customer_identifier: string } = {
  ...noTrail,
  payload: {
    ...(noTrail.payload as object),
    authorization: { card_type: "visa", bank: "TEST BANK", country_code: "NG" },
    log: { time_spent: 40, attempts: 1, errors: 0, mobile: true, history: [{ type: "action", message: "Viewed payment options", time: 5 }] },
  },
};

describe("model input states what is unavailable", () => {
  it("says the behaviour trail is unavailable, and that its absence is not evidence", () => {
    const input = buildModelInput(noTrail, noTrail.gateway_response);
    assert.deepEqual(input.behaviour_trail, { available: false, why: UNAVAILABLE.behaviourTrail });
    assert.match(input.behaviour_trail.why, /no Opada buyer reference/);
    assert.match(input.behaviour_trail.why, /not evidence/);
  });

  it("says the checkout log and card details are unavailable instead of sending null", () => {
    const input = buildModelInput(noTrail, noTrail.gateway_response);
    assert.deepEqual(input.checkout, { available: false, why: UNAVAILABLE.checkout });
    assert.deepEqual(input.card, { available: false, why: UNAVAILABLE.card });
    assert.match(input.checkout.available ? "" : input.checkout.why, /not evidence that the buyer did or did not attempt payment/);
  });

  it("never sends a whole section as a bare null", () => {
    const sent = JSON.stringify(buildModelInput(noTrail, noTrail.gateway_response));
    for (const section of ["checkout", "card", "behaviour_trail"]) {
      assert.ok(!sent.includes(`"${section}":null`), `${section} sent as null`);
    }
  });

  it("marks available data as available, and still says the trail is not connected", () => {
    const input = buildModelInput(withLog, withLog.gateway_response);
    assert.equal(input.checkout.available, true);
    assert.equal(input.card.available, true);
    assert.equal(input.behaviour_trail.available, false);
  });

  it("the explanations pass the PII gate", () => {
    for (const stall of [noTrail, withLog]) {
      assert.doesNotThrow(() => assertNoPii(buildModelInput(stall, stall.gateway_response), knownIdentifiers(stall)));
    }
  });

  it("the system prompt tells the model unavailable data is not evidence", () => {
    assert.match(SYSTEM_PROMPT, /"available": false/);
    assert.match(SYSTEM_PROMPT, /Never treat missing or unavailable data as evidence/);
    assert.match(SYSTEM_PROMPT, /no checkout log does not mean the buyer never attempted payment/);
  });
});
