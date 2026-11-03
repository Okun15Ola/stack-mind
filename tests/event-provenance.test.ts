// Event provenance and the first-hand gate (issue #12, decisions of
// 3 November 2026).
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { parseEvent, type BehaviourEvent } from "@/lib/behaviour/contract";
import { handleBehaviourEvents, sourceFor, type StoredRow } from "@/lib/behaviour/ingest";
import type { StoredEvent } from "@/lib/behaviour/trail";
import { diagnoseStall, type DiagnosisRow, type DiagnosisStore, type StallForDiagnosis } from "@/lib/diagnose";
import type { DiagnosisModel } from "@/lib/diagnosis-model";
import { FIRST_HAND_FOR_REASON, FIRST_HAND_TYPES, askOnceAllowed, firstHandEvidence } from "@/lib/first-hand";
import { OUTCOMES } from "@/lib/reasons";
import { buildModelInput } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";
import { firstHandTableViolations } from "./guards";

const NOW = new Date("2026-11-03T10:00:00Z");
const base = { event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1A", occurred_at: "2026-11-03T09:59:00Z", buyer_ref: "q3V9mT0b2xYkLw8RfA1sZe" };
const parse = (raw: object) => parseEvent({ ...base, ...raw }, NOW);

describe("observed: can only lower trust", () => {
  it("missing means browser", () => {
    const r = parse({ type: "payment_started", properties: {} });
    assert.ok(r.ok && r.event.observed === "browser");
  });

  it("a server may claim payment_started, checkout_started, and a form question", () => {
    for (const raw of [
      { type: "payment_started", properties: {} },
      { type: "checkout_started", properties: {} },
      { type: "question_asked", properties: { channel: "form" } },
    ]) {
      const r = parse({ ...raw, observed: "server" });
      assert.ok(r.ok && r.event.observed === "server", raw.type);
    }
  });

  it("a server may never claim info_viewed, checkout_left, payment_closed, or a non-form question: rejected, not downgraded", () => {
    for (const raw of [
      { type: "info_viewed", properties: { kind: "pricing" } },
      { type: "checkout_left", properties: { reason: "idle" } },
      { type: "payment_closed", properties: { stage: "otp_or_pin" } },
      { type: "question_asked", properties: { channel: "whatsapp" } },
    ]) {
      const r = parse({ ...raw, observed: "server" });
      assert.deepEqual(r.ok ? null : r.error, "server_observation_not_possible", raw.type);
    }
  });

  it("the same browser events are accepted when declared as browser", () => {
    assert.ok(parse({ type: "checkout_left", properties: { reason: "idle" }, observed: "browser" }).ok);
  });

  it("an unknown observed value, or a body naming its source, is rejected", () => {
    assert.equal((parse({ type: "payment_started", observed: "paystack" }) as { error: string }).error, "invalid_observed");
    assert.equal((parse({ type: "payment_started", source: "server_observed" }) as { error: string }).error, "unknown_field");
  });

  it("a signed request yields server_observed only for a declared server observation, else server_relayed", () => {
    const ev = (observed: "server" | "browser") => ({ observed }) as BehaviourEvent;
    assert.equal(sourceFor(ev("server")), "server_observed");
    assert.equal(sourceFor(ev("browser")), "server_relayed");
  });

  it("end to end: a signed server-observed payment_started is stored as server_observed; a server-claimed checkout_left stores nothing", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    const keys = { lookup: async () => ({ key_id: "oek_test_AbCdEfGhIjKlMnOpQrSt", merchant_id: "okunola", emitter_name: "passmate", environment: "test" as const, public_keys: [raw], revoked: false }) };
    const stored: StoredRow[] = [];
    const sink = { insert: async (rows: StoredRow[]) => (stored.push(...rows), rows.length) };
    const retention = { lastPurge: async () => new Date(NOW.getTime() - 3_600_000) };
    const body = JSON.stringify({
      events: [
        { ...base, type: "payment_started", properties: {}, observed: "server" },
        { ...base, event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1B", type: "checkout_left", properties: {}, observed: "server" },
      ],
    });
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const headers = new Headers({
      "opada-key-id": "oek_test_AbCdEfGhIjKlMnOpQrSt",
      "opada-timestamp": ts,
      "opada-signature": `v1=${sign(null, Buffer.from(`${ts}.${body}`), privateKey).toString("base64url")}`,
    });
    const res = await handleBehaviourEvents(headers, new TextEncoder().encode(body), NOW, { keys, sink, retention });
    assert.equal(res.status, 202);
    assert.deepEqual((res.body as { rejected: unknown[] }).rejected, [{ event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1B", error: "server_observation_not_possible" }]);
    assert.equal(stored.length, 1);
    assert.equal(stored[0].source, "server_observed");
    assert.ok(!("observed" in stored[0]), "observed is folded into source, not stored");
  });
});

const ev = (type: StoredEvent["type"], source: StoredEvent["source"], properties: Record<string, string> = {}) => ({ type, source, properties });

describe("first-hand evidence, per reason", () => {
  it("the real table passes its guard", () => {
    assert.deepEqual(firstHandTableViolations(FIRST_HAND_TYPES, FIRST_HAND_FOR_REASON), []);
  });

  it("covers every outcome", () => {
    assert.deepEqual(Object.keys(FIRST_HAND_FOR_REASON).sort(), [...OUTCOMES].sort());
  });

  it("a gateway-derived reason counts Paystack's gateway_response, fetched by Opada", () => {
    const fh = firstHandEvidence("CARD_FAILING", { gatewayResponse: "Declined", trailEvents: [] });
    assert.deepEqual(fh, ["paystack:gateway_response"]);
    assert.equal(askOnceAllowed({ reason: "CARD_FAILING", first_hand_evidence: fh }), true);
  });

  it("FOR THE REASON: a server_observed payment_started does not make NO_TRUST first-hand", () => {
    const facts = { gatewayResponse: "The transaction was not completed", trailEvents: [ev("payment_started", "server_observed")] };
    const fh = firstHandEvidence("NO_TRUST", facts);
    assert.deepEqual(fh, []);
    assert.equal(askOnceAllowed({ reason: "NO_TRUST", first_hand_evidence: fh }), false);
  });

  it("evidence listed for another reason never opens the gate", () => {
    assert.equal(askOnceAllowed({ reason: "NO_TRUST", first_hand_evidence: ["paystack:gateway_response"] }), false);
    assert.equal(askOnceAllowed({ reason: "FORGOT", first_hand_evidence: ["server_observed:question_asked"] }), false);
  });

  it("UNANSWERED_QUESTION: a server-observed form question counts; relayed or client questions don't", () => {
    assert.deepEqual(firstHandEvidence("UNANSWERED_QUESTION", { gatewayResponse: null, trailEvents: [ev("question_asked", "server_observed", { channel: "form" })] }), ["server_observed:question_asked"]);
    for (const source of ["server_relayed", "client"] as const) {
      assert.deepEqual(firstHandEvidence("UNANSWERED_QUESTION", { gatewayResponse: null, trailEvents: [ev("question_asked", source, { channel: "form" }), ev("info_viewed", source, { kind: "refund_or_returns" })] }), []);
    }
  });

  it("browser-originated evidence never qualifies alone, for any reason", () => {
    const browserOnly = { gatewayResponse: null, trailEvents: (["server_relayed", "client"] as const).flatMap((s) => [ev("info_viewed", s, { kind: "pricing" }), ev("question_asked", s, { channel: "form" }), ev("payment_closed", s), ev("checkout_left", s)]) };
    for (const reason of OUTCOMES) assert.deepEqual(firstHandEvidence(reason, browserOnly), [], reason);
  });

  it("INSUFFICIENT_EVIDENCE never passes the gate", () => {
    assert.equal(askOnceAllowed({ reason: "INSUFFICIENT_EVIDENCE", first_hand_evidence: ["paystack:gateway_response"] }), false);
  });
});

describe("Paystack's checkout log is labelled provider-relayed", () => {
  const stall = { gateway_response: "x", amount: 1, currency: "NGN", event_type: "transaction.abandoned" };
  it("carries provenance when available", () => {
    const input = buildModelInput({ ...stall, payload: { log: { time_spent: 30, attempts: 1, errors: 0, mobile: true, history: [] } } }, "x");
    assert.equal((input.checkout as { provenance?: string }).provenance, "provider_relayed");
  });
  it("the label never makes an empty log available", () => {
    assert.equal(buildModelInput({ ...stall, payload: { log: {} } }, "x").checkout.available, false);
  });
});

describe("each diagnosis stores what it rested on, computed by code", () => {
  const NOW2 = new Date("2026-11-03T10:10:00Z");
  const BUYER = "q3V9mT0b2xYkLw8RfA1sZe";
  const verified = (row: StallForDiagnosis) =>
    ({ id: row.id, reference: "r", paystackStatus: "abandoned", gatewayResponse: row.gateway_response, verifiedAt: new Date(NOW2.getTime() - 30_000) }) as VerifiedStall;
  const store = (row: StallForDiagnosis, events: StoredEvent[], saved: DiagnosisRow[]): DiagnosisStore => ({
    loadStall: async () => row,
    saveDiagnosis: async (r) => void saved.push(r),
    flagBlocked: async () => {},
    loadBehaviourEvents: async () => events,
    countMerchants: async () => 1,
  });
  const stored = (type: StoredEvent["type"], at: string, source: StoredEvent["source"], properties: Record<string, string> = {}): StoredEvent => ({
    event_id: `01JBX7Q8M2ZK5D3W0V9T4R${String(Math.random()).slice(2, 6)}`,
    type,
    occurred_at: at,
    buyer_ref: BUYER,
    session_ref: null,
    device: "mobile",
    properties,
    source,
  });

  it("a rules diagnosis: Paystack's gateway_response is its first-hand evidence, and no trail was joined", async () => {
    const row: StallForDiagnosis = { id: "s1", status: "new", gateway_response: "Declined", amount: 1, currency: "NGN", event_type: "transaction.failed", customer_identifier: null, payload: {} };
    const saved: DiagnosisRow[] = [];
    await diagnoseStall(verified(row), { store: store(row, [], saved), model: null, now: () => NOW2 });
    assert.deepEqual(saved[0].first_hand_evidence, ["paystack:gateway_response"]);
    assert.deepEqual(saved[0].trail_sources, { server_observed: 0, server_relayed: 0, client: 0 });
  });

  it("a behavioural diagnosis on relayed evidence: counts stored, no first-hand evidence, so Standing only", async () => {
    const row: StallForDiagnosis = {
      id: "s2",
      status: "new",
      gateway_response: "The transaction was not completed",
      amount: 1,
      currency: "NGN",
      event_type: "transaction.abandoned",
      customer_identifier: null,
      stalled_at: "2026-11-03T10:05:00Z",
      payload: { metadata: { opada_buyer_ref: BUYER } },
    };
    const events = [
      stored("checkout_started", "2026-11-03T10:00:00Z", "server_relayed"),
      stored("payment_started", "2026-11-03T10:01:00Z", "server_observed"),
      stored("info_viewed", "2026-11-03T10:02:00Z", "server_relayed", { kind: "refund_or_returns" }),
    ];
    const model: DiagnosisModel = { classify: async () => ({ output: { reason: "UNANSWERED_QUESTION", confidence: 0.6, rationale: "Read the refund policy." }, model: "fake:m", refusals: [] }) };
    const saved: DiagnosisRow[] = [];
    await diagnoseStall(verified(row), { store: store(row, events, saved), model, now: () => NOW2, log: () => {} });
    assert.deepEqual(saved[0].trail_sources, { server_observed: 1, server_relayed: 2, client: 0 });
    assert.deepEqual(saved[0].first_hand_evidence, []);
    assert.equal(askOnceAllowed({ reason: "UNANSWERED_QUESTION", first_hand_evidence: saved[0].first_hand_evidence }), false);
  });

  it("whatever the model writes about its evidence is ignored", async () => {
    const row: StallForDiagnosis = { id: "s3", status: "new", gateway_response: "The transaction was not completed", amount: 1, currency: "NGN", event_type: "transaction.abandoned", customer_identifier: null, payload: {} };
    const model: DiagnosisModel = {
      classify: async () => ({ output: { reason: "NO_TRUST", confidence: 0.9, rationale: "x", first_hand_evidence: ["paystack:gateway_response"], trail_sources: { server_observed: 9 } }, model: "fake:m", refusals: [] }),
    };
    const saved: DiagnosisRow[] = [];
    await diagnoseStall(verified(row), { store: store(row, [], saved), model, now: () => NOW2, log: () => {} });
    assert.deepEqual(saved[0].first_hand_evidence, []);
    assert.deepEqual(saved[0].trail_sources, { server_observed: 0, server_relayed: 0, client: 0 });
  });
});
