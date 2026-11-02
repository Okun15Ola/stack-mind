// A live Paystack key exists only for read-only staging on Okunola's own
// account. These pin every condition it is accepted under.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DRY_RUN_FLAG, LIVE_KEY_ENTRYPOINTS, LIVE_KEY_FLAG, PaystackKeyRefusedError, paystackKeyFor, type PaystackEntrypoint } from "@/lib/paystack";
import { entrypointNamingViolations, liveEntrypointViolations, readTree } from "./guards";

const TEST = "sk_test_abc123secret";
const LIVE = "sk_live_xyz789secret";
const ok = { PAYSTACK_SECRET_KEY: LIVE, [LIVE_KEY_FLAG]: "true", [DRY_RUN_FLAG]: "true" };

function refused(entrypoint: PaystackEntrypoint, env: Record<string, string | undefined>, why: RegExp) {
  const lines: string[] = [];
  assert.throws(() => paystackKeyFor(entrypoint, env, (l) => lines.push(l)), (e: unknown) => {
    assert.ok(e instanceof PaystackKeyRefusedError, String(e));
    assert.match(e.message, why);
    const key = env.PAYSTACK_SECRET_KEY;
    if (key) assert.ok(!e.message.includes(key), "error carries the key");
    return true;
  });
  assert.deepEqual(lines, [], "a refused run must not log a live-key use");
}

describe("test keys", () => {
  it("work for every entrypoint, including the webhook, with no live-key log", () => {
    for (const ep of [...LIVE_KEY_ENTRYPOINTS, "webhook"] as PaystackEntrypoint[]) {
      const lines: string[] = [];
      assert.equal(paystackKeyFor(ep, { PAYSTACK_SECRET_KEY: TEST }, (l) => lines.push(l)), TEST);
      assert.deepEqual(lines, []);
    }
  });
});

describe("live keys", () => {
  it("are accepted by each named read-only entrypoint with both flags, and each run logs it with the name", () => {
    for (const ep of LIVE_KEY_ENTRYPOINTS) {
      const lines: string[] = [];
      assert.equal(paystackKeyFor(ep, ok, (l) => lines.push(l)), LIVE);
      assert.equal(lines.length, 1);
      assert.match(lines[0], new RegExp(`LIVE secret key in use by ${ep}`));
      assert.ok(!lines[0].includes(LIVE), "log carries the key");
    }
  });

  it("are never accepted by the webhook handler, even with both flags", () => {
    refused("webhook", ok, /only accepted by the read-only entrypoints/);
  });

  it("need the explicit live flag, not just the key", () => {
    for (const v of [undefined, "", "1", "yes", "TRUE", "false"]) {
      refused("poller", { ...ok, [LIVE_KEY_FLAG]: v }, new RegExp(`${LIVE_KEY_FLAG}=true`));
    }
  });

  it("refuse to start when dry-run is not explicitly on", () => {
    for (const v of [undefined, "", "false", "0", "no", "TRUE"]) {
      refused("diagnose-stall", { ...ok, [DRY_RUN_FLAG]: v }, /refusing to start: live key present/);
    }
  });

  it("refuse anything that is neither a test nor a live secret key", () => {
    for (const key of ["pk_live_abc", "pk_test_abc", "rk_live_abc", "sk_abc", "notakey9271"]) {
      refused("poller", { ...ok, PAYSTACK_SECRET_KEY: key }, /neither a test nor a live secret key/);
    }
    refused("poller", { [LIVE_KEY_FLAG]: "true", [DRY_RUN_FLAG]: "true" }, /not set/);
  });
});

describe("guards on the real tree", () => {
  it("the live-key entrypoint list is exactly the read-only scripts, never the webhook", () => {
    assert.deepEqual(liveEntrypointViolations(LIVE_KEY_ENTRYPOINTS), []);
  });

  it("every entrypoint asks for the key under its own name, and nothing else asks", () => {
    assert.deepEqual(entrypointNamingViolations(readTree("src", "scripts")), []);
  });
});
