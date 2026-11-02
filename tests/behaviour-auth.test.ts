// Emitter authentication: Ed25519 over "<timestamp>.<raw body>", enforced
// ±300 s window, two keys for rotation. Negative fixtures first: each must be
// rejected, and an unauthenticated request must store nothing.
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { describe, it } from "node:test";
import { TIMESTAMP_WINDOW_SECONDS, verifyEmitterRequest, type EmitterKey, type EmitterKeyStore } from "@/lib/behaviour/auth";
import { handleBehaviourEvents, type EventSink, type StoredRow } from "@/lib/behaviour/ingest";

const NOW = new Date("2026-11-02T10:00:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { privateKey, raw: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") };
}
const current = keypair();
const next = keypair();
const stranger = keypair();

const KEY_ID = "oek_test_AbCdEfGhIjKlMnOpQrSt";
const registered: EmitterKey = {
  key_id: KEY_ID,
  merchant_id: "okunola",
  emitter_name: "shopcart",
  environment: "test",
  public_keys: [current.raw],
  revoked: false,
};
function storeWith(...keys: EmitterKey[]): EmitterKeyStore {
  return { lookup: async (id) => keys.find((k) => k.key_id === id) ?? null };
}

const BODY = JSON.stringify({
  events: [
    {
      event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1A",
      type: "info_viewed",
      occurred_at: "2026-11-02T09:59:00Z",
      buyer_ref: "q3V9mT0b2xYkLw8RfA1sZe",
      properties: { kind: "refund_or_returns" },
    },
  ],
});

function signed(body: string, opts: { ts?: number; key?: KeyObject; keyId?: string } = {}) {
  const ts = String(opts.ts ?? NOW_S);
  const sig = sign(null, Buffer.from(`${ts}.${body}`), opts.key ?? current.privateKey).toString("base64url");
  return new Headers({ "opada-key-id": opts.keyId ?? KEY_ID, "opada-timestamp": ts, "opada-signature": `v1=${sig}` });
}
const bytes = (s: string) => new TextEncoder().encode(s);

function memorySink() {
  const stored: StoredRow[] = [];
  const sink: EventSink = {
    async insert(rows) {
      let n = 0;
      for (const r of rows) {
        if (stored.some((s) => s.merchant_id === r.merchant_id && s.event_id === r.event_id)) continue;
        stored.push(r);
        n++;
      }
      return n;
    },
  };
  return { sink, stored };
}

async function rejected(headers: Headers, body: string, error: string, keys = storeWith(registered)) {
  const r = await verifyEmitterRequest(headers, bytes(body), NOW, keys);
  assert.deepEqual(r, { ok: false, error });
  const { sink, stored } = memorySink();
  const res = await handleBehaviourEvents(headers, bytes(body), NOW, { keys, sink });
  assert.equal(res.status, 401);
  assert.deepEqual(res.body, { error });
  assert.equal(stored.length, 0, "an unauthenticated request stored events");
}

describe("negative fixtures: each must be rejected", () => {
  it("a valid signature on a modified body", async () => {
    const headers = signed(BODY);
    await rejected(headers, BODY.replace("refund_or_returns", "pricing"), "signature_invalid");
  });

  it("a valid signature on a re-serialised body (same JSON, different bytes)", async () => {
    const headers = signed(BODY);
    await rejected(headers, JSON.stringify(JSON.parse(BODY), null, 2), "signature_invalid");
  });

  it("a replayed request outside the window", async () => {
    const old = NOW_S - TIMESTAMP_WINDOW_SECONDS - 1;
    await rejected(signed(BODY, { ts: old }), BODY, "timestamp_outside_window");
  });

  it("a request timestamped too far in the future", async () => {
    await rejected(signed(BODY, { ts: NOW_S + TIMESTAMP_WINDOW_SECONDS + 1 }), BODY, "timestamp_outside_window");
  });

  it("a signature from an unregistered key", async () => {
    await rejected(signed(BODY, { key: stranger.privateKey, keyId: "oek_test_ZzZzZzZzZzZzZzZzZzZz" }), BODY, "unknown_key");
  });

  it("a registered key id signed with someone else's private key", async () => {
    await rejected(signed(BODY, { key: stranger.privateKey }), BODY, "signature_invalid");
  });

  it("a request with no signature", async () => {
    const h = signed(BODY);
    h.delete("opada-signature");
    await rejected(h, BODY, "missing_signature");
  });

  it("no key id, no timestamp, malformed values, a revoked key", async () => {
    const noId = signed(BODY);
    noId.delete("opada-key-id");
    await rejected(noId, BODY, "missing_key_id");
    const noTs = signed(BODY);
    noTs.delete("opada-timestamp");
    await rejected(noTs, BODY, "missing_timestamp");
    const badTs = signed(BODY);
    badTs.set("opada-timestamp", "soon");
    await rejected(badTs, BODY, "malformed_timestamp");
    const badSig = signed(BODY);
    badSig.set("opada-signature", "sha256=abc");
    await rejected(badSig, BODY, "malformed_signature");
    await rejected(signed(BODY, { keyId: "oek_prod_x" }), BODY, "malformed_key_id");
    await rejected(signed(BODY), BODY, "revoked_key", storeWith({ ...registered, revoked: true }));
  });
});

describe("accepted requests", () => {
  it("a correctly signed request inside the window is stored, with source and merchant set by Opada", async () => {
    const { sink, stored } = memorySink();
    const res = await handleBehaviourEvents(signed(BODY), bytes(BODY), NOW, { keys: storeWith(registered), sink });
    assert.equal(res.status, 202);
    assert.deepEqual(res.body, { accepted: 1, duplicates: 0, rejected: [] });
    assert.equal(stored[0].source, "server");
    assert.equal(stored[0].merchant_id, "okunola");
    assert.equal(stored[0].emitter_id, KEY_ID);
  });

  it("the edges of the window are accepted", async () => {
    for (const ts of [NOW_S - TIMESTAMP_WINDOW_SECONDS, NOW_S + TIMESTAMP_WINDOW_SECONDS]) {
      assert.equal((await verifyEmitterRequest(signed(BODY, { ts }), bytes(BODY), NOW, storeWith(registered))).ok, true);
    }
  });

  it("rotation: a signature from either of the two registered keys verifies", async () => {
    const keys = storeWith({ ...registered, public_keys: [current.raw, next.raw] });
    for (const k of [current.privateKey, next.privateKey]) {
      assert.equal((await verifyEmitterRequest(signed(BODY, { key: k }), bytes(BODY), NOW, keys)).ok, true);
    }
  });

  it("a replay inside the window is deduplicated by event_id: stored once", async () => {
    const { sink, stored } = memorySink();
    const deps = { keys: storeWith(registered), sink };
    const headers = signed(BODY);
    const first = await handleBehaviourEvents(headers, bytes(BODY), NOW, deps);
    const replay = await handleBehaviourEvents(headers, bytes(BODY), NOW, deps);
    assert.deepEqual(first.body, { accepted: 1, duplicates: 0, rejected: [] });
    assert.deepEqual(replay.body, { accepted: 0, duplicates: 1, rejected: [] });
    assert.equal(stored.length, 1);
  });

  it("a body field named `source` is rejected, so a client can never claim to be a server", async () => {
    const body = BODY.replace('"type":"info_viewed"', '"type":"info_viewed","source":"server"');
    const { sink, stored } = memorySink();
    const res = await handleBehaviourEvents(signed(body), bytes(body), NOW, { keys: storeWith(registered), sink });
    assert.equal(res.status, 202);
    assert.deepEqual((res.body as { rejected: unknown[] }).rejected, [{ event_id: "01JBX7Q8M2ZK5D3W0V9T4R6Y1A", error: "unknown_field" }]);
    assert.equal(stored.length, 0);
  });

  it("an oversized body is refused before authentication", async () => {
    const big = "x".repeat(64 * 1024 + 1);
    const res = await handleBehaviourEvents(signed(big), bytes(big), NOW, { keys: storeWith(registered), sink: memorySink().sink });
    assert.equal(res.status, 413);
  });
});
