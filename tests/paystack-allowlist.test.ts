// A Paystack secret key is not read-only: the key that verifies a transaction
// can also refund and transfer. Every Paystack call must go through
// paystackRequest() and its endpoint allowlist. These tests fail if anything
// calls Paystack another way, or if the allowlist grows a write endpoint.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
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
    assert.deepEqual(
      PAYSTACK_ALLOWLIST.map((e) => `${e.method} ${e.name}`),
      ["GET list transactions", "GET verify transaction"],
    );
    for (const e of PAYSTACK_ALLOWLIST) assert.equal(e.method, "GET");
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
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|mts|js|mjs)$/.test(name) ? [path] : [];
    });
  }
  const files = [...sourceFiles("src"), ...sourceFiles("scripts")];
  const PAYSTACK_FILE = join("src", "lib", "paystack.ts");
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  function outsideHttpBlock(path: string): string {
    const text = stripComments(readFileSync(path, "utf8"));
    if (path !== PAYSTACK_FILE) return text;
    const raw = readFileSync(path, "utf8");
    const begin = raw.indexOf("// paystack-http:begin");
    const end = raw.indexOf("// paystack-http:end");
    assert.ok(begin >= 0 && end > begin, "paystack.ts must keep the paystack-http:begin/end markers");
    return stripComments(raw.slice(0, begin) + raw.slice(end));
  }

  it("the Paystack API host appears only inside paystackRequest()", () => {
    const offenders = files.filter((f) => /paystack\.co\b/.test(outsideHttpBlock(f)));
    assert.deepEqual(offenders, [], `Paystack called directly from: ${offenders.join(", ")}`);
  });

  it("paystack.ts calls fetch exactly once, inside paystackRequest()", () => {
    const raw = stripComments(readFileSync(PAYSTACK_FILE, "utf8"));
    assert.equal((raw.match(/\bfetch\s*\(/g) ?? []).length, 1);
    assert.ok(!/\bfetch\s*\(/.test(outsideHttpBlock(PAYSTACK_FILE)));
  });

  it("only paystack.ts reads PAYSTACK_SECRET_KEY from the environment", () => {
    const offenders = files.filter((f) => f !== PAYSTACK_FILE && /process\.env(\.PAYSTACK_SECRET_KEY|\[\s*["']PAYSTACK_SECRET_KEY)/.test(stripComments(readFileSync(f, "utf8"))));
    assert.deepEqual(offenders, [], `PAYSTACK_SECRET_KEY read outside paystack.ts: ${offenders.join(", ")}`);
  });
});
