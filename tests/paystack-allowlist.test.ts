// A Paystack secret key is not read-only: the key that verifies a transaction
// can also refund and transfer. Every Paystack call must go through
// paystackRequest() and its endpoint allowlist. These tests fail if anything
// calls Paystack another way, or if the allowlist grows a write endpoint.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  PAYSTACK_ALLOWLIST,
  PaystackEndpointBlockedError,
  PaystackHttpError,
  endpointShape,
  listTransactions,
  paystackRequest,
  verifyTransaction,
} from "@/lib/paystack";
import { allowlistViolations, paystackGuardViolations, readTree } from "./guards";

const KEY = "sk_test_secretvalue1234567890";

type Call = { url: URL; init: RequestInit };
let calls: Call[] = [];
const realFetch = globalThis.fetch;
function respond(status: number, body: unknown) {
  globalThis.fetch = (async (url: URL, init: RequestInit) => {
    calls.push({ url: new URL(String(url)), init });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
beforeEach(() => {
  calls = [];
  respond(200, { status: true, data: [] });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("the allowlist", () => {
  it("holds exactly the read endpoints Opada uses, and only GET", () => {
    assert.deepEqual(allowlistViolations(PAYSTACK_ALLOWLIST), []);
  });

  it("lets the two real calls through, as GET to api.paystack.co, refusing redirects", async () => {
    respond(200, { status: true, data: [] });
    await listTransactions(KEY, { from: new Date("2026-11-01T00:00:00Z") });
    respond(200, { status: true, data: { status: "abandoned" } });
    await verifyTransaction(KEY, "T169809891137085");
    assert.equal(calls.length, 2);
    for (const c of calls) {
      assert.equal(c.url.host, "api.paystack.co");
      assert.equal(c.init.method, "GET");
      assert.equal(c.init.redirect, "error");
      assert.equal(c.init.body, undefined);
    }
    assert.equal(calls[0].url.pathname, "/transaction");
    assert.equal(calls[1].url.pathname, "/transaction/verify/T169809891137085");
  });
});

describe("anything else is refused before a request is sent", () => {
  const blocked: [string, string][] = [
    ["POST", "/refund"],
    ["POST", "/transfer"],
    ["POST", "/transfer/bulk"],
    ["POST", "/transferrecipient"],
    ["POST", "/charge"],
    ["POST", "/transaction/charge_authorization"],
    ["POST", "/transaction/initialize"],
    ["GET", "/balance"],
    ["GET", "/customer"],
    ["GET", "/customer/buyer@example.com"],
    ["DELETE", "/transaction/verify/abc"],
    ["POST", "/transaction"],
    ["POST", "/transaction/verify/abc"],
    ["GET", "/transaction/verify/abc/extra"],
    ["GET", "/transaction/verify/../../refund"],
    ["GET", "/transaction?perPage=1"],
    ["GET", "transaction"],
    ["GET", "https://evil.example/transaction"],
    ["GET", "//evil.example/transaction"],
  ];
  for (const [method, path] of blocked) {
    it(`${method} ${path}`, async () => {
      await assert.rejects(paystackRequest(KEY, method, path), (e: unknown) => {
        assert.ok(e instanceof PaystackEndpointBlockedError, `expected a block, got ${String(e)}`);
        assert.match(e.message, /not on the endpoint allowlist/);
        assert.ok(e.message.includes(method.toUpperCase()), "names the method");
        assert.ok(!e.message.includes(KEY) && !e.message.includes("secretvalue"), "error contains the key");
        assert.ok(!e.message.includes("buyer@example.com"), "error contains customer data");
        assert.ok(!e.message.includes("perPage"), "error contains the query string");
        return true;
      });
      assert.equal(calls.length, 0, "a request was sent");
    });
  }

  it("names the endpoint's shape, with dynamic segments hidden", () => {
    assert.equal(endpointShape("/refund"), "/refund");
    assert.equal(endpointShape("/customer/buyer@example.com"), "/customer/:param");
    assert.equal(endpointShape("/transaction/verify/T169809891137085?x=1"), "/transaction/verify/:param");
  });

  it("an HTTP error from Paystack never carries the key", async () => {
    respond(401, { status: false, message: "Invalid key" });
    await assert.rejects(verifyTransaction(KEY, "ref1"), (e: unknown) => {
      assert.ok(e instanceof PaystackHttpError);
      assert.equal(e.status, 401);
      assert.ok(!e.message.includes(KEY));
      return true;
    });
  });
});

describe("nothing calls Paystack except through paystackRequest()", () => {
  it("the real tree has no bypass: host, fetch and key stay inside paystack.ts's client", () => {
    assert.deepEqual(paystackGuardViolations(readTree("src", "scripts")), []);
  });
});
