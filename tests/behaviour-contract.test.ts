import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseBatch, parseEvent } from "@/lib/behaviour/contract";

const NOW = new Date("2026-11-02T10:00:00Z");
const base = {
  event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1A",
  type: "info_viewed",
  occurred_at: "2026-11-02T09:59:00Z",
  buyer_ref: "q3V9mT0b2xYkLw8RfA1sZe",
  properties: { kind: "pricing" },
};
const err = (raw: unknown) => {
  const r = parseEvent(raw, NOW);
  return r.ok ? null : r.error;
};

describe("event contract v1", () => {
  it("accepts a well-formed event", () => {
    const r = parseEvent(base, NOW);
    assert.ok(r.ok);
    assert.equal(r.event.session_ref, null);
  });

  it("every type accepts its own properties", () => {
    for (const [type, properties] of [
      ["checkout_started", { item_count: 2, amount_minor_units: 250000, currency: "NGN" }],
      ["question_asked", { channel: "whatsapp" }],
      ["payment_started", { paystack_reference: "T169809891137085" }],
      ["payment_closed", { stage: "otp_or_pin" }],
      ["checkout_left", { last_step: "payment", reason: "idle" }],
    ] as const) {
      assert.equal(err({ ...base, type, properties }), null, type);
    }
  });

  it("info_viewed.kind is required and typed: pricing and refund_or_returns stay distinct", () => {
    assert.equal(err({ ...base, properties: {} }), "missing_property");
    assert.equal(err({ ...base, properties: { kind: "refund_policy" } }), "invalid_property_value");
    for (const kind of ["pricing", "terms", "refund_or_returns", "delivery", "faq"]) assert.equal(err({ ...base, properties: { kind } }), null);
  });

  it("rejects free text, unknown fields and unknown properties", () => {
    assert.equal(err({ ...base, note: "hi" }), "unknown_field");
    assert.equal(err({ ...base, source: "server" }), "unknown_field");
    assert.equal(err({ ...base, properties: { kind: "pricing", url: "https://shop/x?email=a@b.co" } }), "unknown_property");
    assert.equal(err({ ...base, type: "question_asked", properties: { channel: "chat", message: "where is my order" } }), "unknown_property");
  });

  it("rejects bad envelopes", () => {
    assert.equal(err({ ...base, event_id: "1" }), "invalid_event_id");
    assert.equal(err({ ...base, type: "page_viewed" }), "unknown_type");
    assert.equal(err({ ...base, occurred_at: "yesterday" }), "invalid_occurred_at");
    assert.equal(err({ ...base, occurred_at: "2026-10-20T00:00:00Z" }), "occurred_at_out_of_range");
    assert.equal(err({ ...base, occurred_at: "2026-11-02T10:10:00Z" }), "occurred_at_out_of_range");
    assert.equal(err({ ...base, device: "watch" }), "invalid_device");
    assert.equal(err({ ...base, type: "checkout_started", properties: { item_count: -1 } }), "invalid_property_value");
    assert.equal(err({ ...base, type: "checkout_started", properties: { item_count: 1.5 } }), "invalid_property_value");
    assert.equal(err({ ...base, type: "checkout_started", properties: { currency: "naira" } }), "invalid_property_value");
  });

  it("refs must be random-looking: short, all-digit or email-shaped refs are refused", () => {
    assert.equal(err({ ...base, buyer_ref: "short" }), "invalid_buyer_ref");
    assert.equal(err({ ...base, buyer_ref: "2348031234567234803123" }), "ref_looks_like_pii");
    assert.equal(err({ ...base, buyer_ref: "buyer@example.com" }), "invalid_buyer_ref");
    assert.equal(err({ ...base, session_ref: "abc" }), "invalid_session_ref");
  });

  it("a batch keeps valid events and reports rejected ones without echoing values", () => {
    const body = JSON.stringify({ events: [base, { ...base, event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1B", type: "nope" }] });
    const r = parseBatch(body, NOW);
    assert.ok(r.ok);
    assert.equal(r.accepted.length, 1);
    assert.deepEqual(r.rejected, [{ event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1B", error: "unknown_type" }]);
  });

  it("batch limits", () => {
    assert.deepEqual(parseBatch("not json", NOW), { ok: false, status: 400, error: "invalid_json" });
    assert.deepEqual(parseBatch(JSON.stringify({ events: [] }), NOW), { ok: false, status: 400, error: "events_must_be_a_non_empty_array" });
    assert.deepEqual(parseBatch(JSON.stringify({ events: Array(101).fill(base) }), NOW), { ok: false, status: 400, error: "too_many_events" });
    assert.deepEqual(parseBatch(JSON.stringify({ events: [base], merchant: "x" }), NOW), { ok: false, status: 400, error: "unknown_field" });
  });
});
