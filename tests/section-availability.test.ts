// "Available" has twice meant "the key exists" instead of "there is something
// in it" (PR 9: checkout, PR 13: card). The rule now lives in one helper,
// section() in src/lib/redact.ts. These tests fail if anything decides
// availability anywhere else, or if a section skips the helper.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildModelInput, section, type StallForModel } from "@/lib/redact";
import { availabilityGuardViolations, readTree, sectionsMissingAvailability } from "./guards";

describe("section availability is decided in one place", () => {
  it("no source file outside section() writes `available: true` or `available: false`", () => {
    assert.deepEqual(availabilityGuardViolations(readTree("src", "scripts")), []);
  });

  it("every section of the model input carries `available`, so none can skip the helper", () => {
    const input = buildModelInput(
      { gateway_response: "x", amount: 1, currency: "NGN", event_type: "transaction.abandoned", payload: {} },
      "x",
    ) as Record<string, unknown>;
    assert.ok(Object.values(input).filter((v) => v !== null && typeof v === "object").length >= 3);
    assert.deepEqual(sectionsMissingAvailability(input), []);
  });
});

describe("section() rules", () => {
  const WHY = "gap";
  for (const [label, fields] of [
    ["null", null],
    ["undefined", undefined],
    ["an empty object", {}],
    ["all-null fields", { a: null, b: null }],
    ["only an empty array", { steps: [] }],
    ["nulls and an empty array", { a: null, steps: [] }],
  ] as const) {
    it(`${label} is unavailable, with the reason`, () => {
      assert.deepEqual(section(fields as object | null | undefined, WHY), { available: false, why: WHY });
    });
  }

  for (const [label, fields] of [
    ["a string", { a: "visa" }],
    ["a zero", { attempts: 0 }],
    ["a false", { mobile: false }],
    ["a non-empty array", { steps: [{}] }],
  ] as const) {
    it(`${label} makes the section available`, () => {
      assert.equal(section(fields, WHY).available, true);
    });
  }
});

describe("every Paystack-backed section, sent empty, is a gap", () => {
  const base: StallForModel = { gateway_response: "The transaction was not completed", amount: 1, currency: "NGN", event_type: "transaction.abandoned", payload: {} };
  for (const [key, payload] of [
    ["card", { authorization: {} }],
    ["card", { authorization: { card_type: null, brand: null, bank: null, country_code: null } }],
    ["checkout", { log: {} }],
    ["checkout", { log: { time_spent: null, attempts: null, errors: null, mobile: null, history: [] } }],
  ] as const) {
    it(`${key} with ${JSON.stringify(payload)}`, () => {
      const input = buildModelInput({ ...base, payload }, base.gateway_response);
      assert.equal(input[key].available, false);
    });
  }
});
