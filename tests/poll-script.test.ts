// npm run poll -- <ref>: ingest one transaction on demand.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { StallRow } from "@/lib/paystack";
import { ingestOne } from "@/lib/poller";
import { ENTRYPOINT_FILES, entrypointNamingViolations, readTree } from "./guards";

const KEY = "sk_test_pollkey123";
const NOW = new Date("2026-11-02T12:00:00Z");
const REF = "T598207129649126";

const realFetch = globalThis.fetch;
let calls: { url: URL; method: string | undefined }[] = [];
function paystackReturns(data: Record<string, unknown>) {
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: new URL(String(url)), method: init.method });
    return new Response(JSON.stringify({ status: true, data }), { status: 200 });
  }) as typeof fetch;
}
beforeEach(() => (calls = []));
afterEach(() => (globalThis.fetch = realFetch));

const abandoned = {
  reference: REF,
  status: "abandoned",
  amount: 300000,
  currency: "NGN",
  gateway_response: "The transaction was not completed",
  created_at: "2026-11-02T09:30:00Z",
  customer: { id: 1, email: "buyer@example.com" },
  metadata: { opada_buyer_ref: "q3V9mT0b2xYkLw8RfA1sZe" },
};

function memoryStalls() {
  const rows: StallRow[] = [];
  const insert = async (batch: StallRow[]) => {
    let n = 0;
    for (const r of batch) {
      if (rows.some((x) => x.paystack_reference === r.paystack_reference)) continue;
      rows.push(r);
      n++;
    }
    return n;
  };
  return { rows, insert };
}

describe("ingestOne", () => {
  it("ingests an abandoned transaction once, from one allowlisted GET, and is a no-op on repeat", async () => {
    paystackReturns(abandoned);
    const { rows, insert } = memoryStalls();
    const first = await ingestOne(KEY, REF, NOW, insert);
    const again = await ingestOne(KEY, REF, NOW, insert);
    assert.deepEqual(first, { reference: REF, paystackStatus: "abandoned", outcome: "inserted" });
    assert.deepEqual(again, { reference: REF, paystackStatus: "abandoned", outcome: "already_present" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, "poll");
    assert.equal(rows[0].gateway_response, "The transaction was not completed");
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.method, "GET");
      assert.equal(c.url.pathname, `/transaction/verify/${REF}`);
    }
  });

  it("the result carries only reference, status and outcome: no customer data", async () => {
    paystackReturns(abandoned);
    const r = await ingestOne(KEY, REF, NOW, memoryStalls().insert);
    assert.deepEqual(Object.keys(r).sort(), ["outcome", "paystackStatus", "reference"]);
    assert.ok(!JSON.stringify(r).includes("example.com"));
  });

  for (const [why, tx] of [
    ["settled", { ...abandoned, status: "success" }],
    ["too_young", { ...abandoned, created_at: "2026-11-02T11:55:00Z" }],
    ["no_creation_time", { ...abandoned, created_at: undefined }],
    ["reference_mismatch", { ...abandoned, reference: "T000000000000000" }],
  ] as const) {
    it(`${why}: nothing is written`, async () => {
      paystackReturns(tx);
      const { rows, insert } = memoryStalls();
      const r = await ingestOne(KEY, REF, NOW, insert);
      assert.equal(r.outcome, "not_a_stall");
      assert.equal(r.why, why);
      assert.equal(rows.length, 0);
    });
  }
});

describe("scripts/poll.ts is the poller entrypoint", () => {
  it("is registered as the poller entrypoint and asks for the key under that name", () => {
    assert.equal(ENTRYPOINT_FILES["scripts/poll.ts"], "poller");
    assert.deepEqual(entrypointNamingViolations(readTree("src", "scripts")), []);
  });
});
