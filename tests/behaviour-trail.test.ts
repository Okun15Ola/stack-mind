// The join (issue #12 section 1) and the trail in model input.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SOURCE_NOTES, selectTrailEvents, trailSources, trailRefsFromTransaction, type StoredEvent } from "@/lib/behaviour/trail";
import { diagnoseStall, type DiagnosisRow, type DiagnosisStore, type StallForDiagnosis } from "@/lib/diagnose";
import type { DiagnosisModel } from "@/lib/diagnosis-model";
import { evidenceGaps } from "@/lib/evidence";
import { MultipleMerchantsError, assertSingleMerchant } from "@/lib/behaviour/merchants";
import { merchantGateViolations, readTree } from "./guards";
import { UNAVAILABLE, assertNoPii, buildModelInput, knownIdentifiers, type ModelInput } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";

const BUYER = "q3V9mT0b2xYkLw8RfA1sZe";
const SESSION = "7Hn2Kc0pQe4Wb9Xs1LmZtA";
const OTHER_SESSION = "9Zz2Kc0pQe4Wb9Xs1LmZtB";
const CREATED = new Date("2026-11-02T10:05:00Z");

let n = 0;
function ev(type: StoredEvent["type"], at: string, extra: Partial<StoredEvent> = {}): StoredEvent {
  n++;
  return {
    event_id: `01JBX7Q8M2ZK5D3W0V9T4R6Y${String(n).padStart(2, "0")}`,
    type,
    occurred_at: at,
    buyer_ref: BUYER,
    session_ref: null,
    device: "mobile",
    properties: {},
    source: "server_observed",
    ...extra,
  };
}

describe("refs from the Paystack transaction", () => {
  it("reads opada_buyer_ref and opada_session_ref from object or JSON-string metadata", () => {
    assert.deepEqual(trailRefsFromTransaction({ metadata: { opada_buyer_ref: BUYER, opada_session_ref: SESSION, cart_id: 9 } }), { buyerRef: BUYER, sessionRef: SESSION });
    assert.deepEqual(trailRefsFromTransaction({ metadata: JSON.stringify({ opada_buyer_ref: BUYER }) }), { buyerRef: BUYER, sessionRef: null });
  });

  it("ignores missing, malformed or PII-shaped refs", () => {
    assert.deepEqual(trailRefsFromTransaction({}), { buyerRef: null, sessionRef: null });
    assert.deepEqual(trailRefsFromTransaction({ metadata: "not json" }), { buyerRef: null, sessionRef: null });
    assert.deepEqual(trailRefsFromTransaction({ metadata: { opada_buyer_ref: "buyer@example.com" } }), { buyerRef: null, sessionRef: null });
    assert.deepEqual(trailRefsFromTransaction({ metadata: { opada_buyer_ref: "08031234567080312345670" } }), { buyerRef: null, sessionRef: null });
  });
});

describe("join rules", () => {
  it("no ref on the transaction: no trail (forward-only)", () => {
    assert.deepEqual(selectTrailEvents({ buyerRef: null, sessionRef: null }, CREATED, [ev("checkout_started", "2026-11-02T10:00:00Z")]), { kind: "no_ref" });
  });

  it("session_ref: exactly that session's events, up to created + 15 minutes", () => {
    const events = [
      ev("checkout_started", "2026-11-02T10:00:00Z", { session_ref: SESSION }),
      ev("info_viewed", "2026-11-02T10:01:00Z", { session_ref: SESSION, properties: { kind: "pricing" } }),
      ev("checkout_started", "2026-11-01T09:00:00Z", { session_ref: OTHER_SESSION }),
      ev("checkout_left", "2026-11-02T10:30:00Z", { session_ref: SESSION }),
    ];
    const r = selectTrailEvents({ buyerRef: BUYER, sessionRef: SESSION }, CREATED, events);
    assert.equal(r.kind, "events");
    assert.ok(r.kind === "events" && r.joinedOn === "session_ref");
    assert.deepEqual(r.kind === "events" ? r.events.map((e) => e.type) : [], ["checkout_started", "info_viewed"]);
  });

  it("buyer_ref fallback: only the last checkout before the transaction, not the buyer's week", () => {
    const events = [
      ev("checkout_started", "2026-10-30T12:00:00Z"),
      ev("payment_closed", "2026-10-30T12:03:00Z", { properties: { stage: "card_entry" } }),
      ev("checkout_started", "2026-11-01T08:00:00Z"),
      ev("checkout_started", "2026-11-02T10:00:00Z"),
      ev("info_viewed", "2026-11-02T10:02:00Z", { properties: { kind: "refund_or_returns" } }),
      ev("checkout_left", "2026-11-02T10:06:00Z", { properties: { last_step: "payment" } }),
    ];
    const r = selectTrailEvents({ buyerRef: BUYER, sessionRef: null }, CREATED, events);
    assert.ok(r.kind === "events" && r.joinedOn === "buyer_ref");
    assert.deepEqual(r.kind === "events" ? r.events.map((e) => e.occurred_at) : [], ["2026-11-02T10:00:00Z", "2026-11-02T10:02:00Z", "2026-11-02T10:06:00Z"]);
  });

  it("a ref with no matching checkout: no events", () => {
    assert.deepEqual(selectTrailEvents({ buyerRef: BUYER, sessionRef: null }, CREATED, [ev("info_viewed", "2026-11-02T10:01:00Z")]), { kind: "no_events" });
    assert.deepEqual(selectTrailEvents({ buyerRef: BUYER, sessionRef: SESSION }, CREATED, []), { kind: "no_events" });
  });
});

const stall: StallForDiagnosis = {
  id: "stall-trail",
  status: "new",
  gateway_response: "The transaction was not completed",
  amount: 250000,
  currency: "NGN",
  event_type: "transaction.abandoned",
  customer_identifier: "buyer@example.com",
  stalled_at: CREATED.toISOString(),
  payload: { status: "abandoned", authorization: {}, customer: { email: "buyer@example.com" }, metadata: { opada_buyer_ref: BUYER, opada_session_ref: SESSION } },
};

describe("the trail in model input", () => {
  const events = [
    ev("checkout_started", "2026-11-02T10:00:00Z", { session_ref: SESSION }),
    ev("info_viewed", "2026-11-02T10:00:40Z", { session_ref: SESSION, properties: { kind: "refund_or_returns" } }),
    ev("payment_closed", "2026-11-02T10:02:10Z", { session_ref: SESSION, source: "client", properties: { stage: "otp_or_pin" } }),
  ];

  it("lists each event with its source and timing, and no refs or ids", () => {
    const sel = selectTrailEvents({ buyerRef: BUYER, sessionRef: SESSION }, CREATED, events);
    const input = buildModelInput(stall, stall.gateway_response, sel);
    assert.ok(input.behaviour_trail.available);
    const trail = input.behaviour_trail as Extract<ModelInput["behaviour_trail"], { available: true }>;
    assert.deepEqual(
      trail.events.map((e) => [e.type, e.at_second, e.provenance, e.kind ?? e.stage ?? null]),
      [
        ["checkout_started", 0, "server_observed", null],
        ["info_viewed", 40, "server_observed", "refund_or_returns"],
        ["payment_closed", 130, "client", "otp_or_pin"],
      ],
    );
    const sent = JSON.stringify(input);
    for (const leak of [BUYER, SESSION, "01JBX7Q8M2ZK5D3W0V9T4R6Y"]) assert.ok(!sent.includes(leak), `model input contains ${leak}`);
    assert.doesNotThrow(() => assertNoPii(input, knownIdentifiers(stall)));
  });

  it("states plainly what each non-first-hand source means, only when present, with no numeric weight", () => {
    const relayedOnly = buildModelInput(stall, stall.gateway_response, {
      kind: "events",
      joinedOn: "session_ref",
      events: [events[0], { ...events[1], source: "server_relayed" }],
    });
    const note1 = (relayedOnly.behaviour_trail as { note: string | null }).note!;
    assert.ok(note1.includes(SOURCE_NOTES.common) && note1.includes(SOURCE_NOTES.server_relayed));
    assert.ok(!note1.includes(SOURCE_NOTES.client), "the client note appears without client events");

    const withClient = buildModelInput(stall, stall.gateway_response, { kind: "events", joinedOn: "session_ref", events });
    const note2 = (withClient.behaviour_trail as { note: string | null }).note!;
    assert.ok(note2.includes(SOURCE_NOTES.client));
    assert.ok(!note2.includes(SOURCE_NOTES.server_relayed), "the relayed note appears without relayed events");

    const observedOnly = buildModelInput(stall, stall.gateway_response, { kind: "events", joinedOn: "session_ref", events: events.slice(0, 2) });
    assert.equal((observedOnly.behaviour_trail as { note: string | null }).note, null);

    // No weights, scores or confidences on events: provenance is a label, not a number.
    const sent = JSON.stringify(withClient.behaviour_trail);
    assert.ok(!/"(weight|trust|score|confidence)"/.test(sent));
    assert.notEqual(SOURCE_NOTES.server_relayed, SOURCE_NOTES.client, "relayed and client must stay distinguishable");
  });

  it("counts joined events per source", () => {
    assert.deepEqual(trailSources(events), { server_observed: 2, server_relayed: 0, client: 1 });
    assert.deepEqual(trailSources([]), { server_observed: 0, server_relayed: 0, client: 0 });
  });


  it("no ref and no events are different gaps, each stated, and still listed as a behaviour_trail gap", () => {
    const noRef = buildModelInput(stall, stall.gateway_response, { kind: "no_ref" });
    const noEvents = buildModelInput(stall, stall.gateway_response, { kind: "no_events" });
    assert.deepEqual(noRef.behaviour_trail, { available: false, why: UNAVAILABLE.behaviourTrail });
    assert.deepEqual(noEvents.behaviour_trail, { available: false, why: UNAVAILABLE.behaviourTrailNoEvents });
    assert.ok(evidenceGaps(noEvents).includes("behaviour_trail"));
  });

  it("through diagnoseStall: the store's events reach the model and the gap disappears", async () => {
    let seen: ModelInput | null = null;
    const model: DiagnosisModel = {
      async classify(input) {
        seen = input;
        return { output: { reason: "UNANSWERED_QUESTION", confidence: 0.55, rationale: "Read the refund policy, then closed at OTP." }, model: "fake:m", refusals: [] };
      },
    };
    const saved: DiagnosisRow[] = [];
    let asked: unknown = null;
    const store: DiagnosisStore = {
      loadStall: async () => stall,
      saveDiagnosis: async (r) => void saved.push(r),
      flagBlocked: async () => {},
      loadBehaviourEvents: async (refs, until) => ((asked = { refs, until: until.toISOString() }), events),
      countMerchants: async () => 1,
    };
    const NOW = new Date("2026-11-02T10:10:00Z");
    const verified = { id: stall.id, reference: "r", paystackStatus: "abandoned", gatewayResponse: stall.gateway_response, verifiedAt: new Date(NOW.getTime() - 30_000) } as VerifiedStall;
    await diagnoseStall(verified, { store, model, now: () => NOW, log: () => {} });
    assert.deepEqual(asked, { refs: { buyerRef: BUYER, sessionRef: SESSION }, until: "2026-11-02T10:20:00.000Z" });
    assert.equal(seen!.behaviour_trail.available, true);
    assert.ok(!saved[0].evidence_gaps.includes("behaviour_trail"));
  });
});

describe("hard gate: one merchant until stalls carry a merchant id", () => {
  const NOW = new Date("2026-11-02T10:10:00Z");
  const verified = { id: stall.id, reference: "r", paystackStatus: "abandoned", gatewayResponse: stall.gateway_response, verifiedAt: new Date(NOW.getTime() - 30_000) } as VerifiedStall;
  const neverCalled: DiagnosisModel = { classify: async () => assert.fail("model called") };

  it("with two merchants, the join refuses: no events loaded, no model call, nothing saved", async () => {
    let loaded = false;
    const saved: DiagnosisRow[] = [];
    const store: DiagnosisStore = {
      loadStall: async () => stall,
      saveDiagnosis: async (r) => void saved.push(r),
      flagBlocked: async () => {},
      loadBehaviourEvents: async () => ((loaded = true), []),
      countMerchants: async () => 2,
    };
    await assert.rejects(diagnoseStall(verified, { store, model: neverCalled, now: () => NOW, log: () => {} }), MultipleMerchantsError);
    assert.equal(loaded, false);
    assert.equal(saved.length, 0);
  });

  it("a stall with no trail refs never needs the merchant count", async () => {
    const noRefs = { ...stall, payload: { status: "abandoned" } };
    const store: DiagnosisStore = {
      loadStall: async () => noRefs,
      saveDiagnosis: async () => {},
      flagBlocked: async () => {},
      loadBehaviourEvents: async () => [],
      countMerchants: async () => assert.fail("merchant count read for a stall with no refs"),
    };
    const model: DiagnosisModel = { classify: async () => ({ output: { reason: "INSUFFICIENT_EVIDENCE", confidence: 0.8, rationale: "x" }, model: "fake:m", refusals: [] }) };
    await diagnoseStall(verified, { store, model, now: () => NOW, log: () => {} });
  });

  it("assertSingleMerchant allows 0 and 1, refuses more, and refuses nonsense", () => {
    assert.doesNotThrow(() => assertSingleMerchant(0));
    assert.doesNotThrow(() => assertSingleMerchant(1));
    assert.throws(() => assertSingleMerchant(2), MultipleMerchantsError);
    assert.throws(() => assertSingleMerchant(Number.NaN));
  });

  it("the real tree: the join checks the merchant count before loading events", () => {
    assert.deepEqual(merchantGateViolations(readTree("src")), []);
  });
});
