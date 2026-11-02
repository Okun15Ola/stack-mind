import { createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";

// Emitter authentication for POST /api/v1/behaviour-events (issue #12,
// corrected: Ed25519, not HMAC).
//
// Opada must never hold a credential that can forge events. Each emitter
// signs with its own Ed25519 PRIVATE key; Opada stores only PUBLIC keys. A
// leak of Opada's database and environment buys an attacker nothing: a public
// key can verify, never sign.
//
// What is signed: the bytes "<timestamp>.<raw body>", exactly as received.
// Never a re-serialised body. Verification runs before any JSON parsing.
// The timestamp window is enforced, not merely present.

export const TIMESTAMP_WINDOW_SECONDS = 300;
const KEY_ID = /^oek_(test|live)_[A-Za-z0-9]{16,64}$/;
const SIGNATURE = /^v1=([A-Za-z0-9_-]{86}|[A-Za-z0-9+/]{86}==)$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type EmitterKey = {
  key_id: string;
  merchant_id: string;
  emitter_name: string;
  environment: "test" | "live";
  // Base64url, raw 32-byte Ed25519 public keys. Up to two, for rotation.
  public_keys: string[];
  revoked: boolean;
};

export interface EmitterKeyStore {
  lookup(keyId: string): Promise<EmitterKey | null>;
}

export type AuthFailure =
  | "missing_key_id"
  | "malformed_key_id"
  | "unknown_key"
  | "revoked_key"
  | "missing_timestamp"
  | "malformed_timestamp"
  | "timestamp_outside_window"
  | "missing_signature"
  | "malformed_signature"
  | "signature_invalid";

export type AuthResult = { ok: true; key: EmitterKey } | { ok: false; error: AuthFailure };

export function publicKeyFromRaw(raw32: string): KeyObject {
  const bytes = Buffer.from(raw32, "base64url");
  if (bytes.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: "der", type: "spki" });
}

export function signedPayload(timestamp: string, rawBody: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), Buffer.from(rawBody)]);
}

export async function verifyEmitterRequest(
  headers: { get(name: string): string | null },
  rawBody: Uint8Array,
  now: Date,
  store: EmitterKeyStore,
): Promise<AuthResult> {
  const keyId = headers.get("opada-key-id");
  if (!keyId) return { ok: false, error: "missing_key_id" };
  if (!KEY_ID.test(keyId)) return { ok: false, error: "malformed_key_id" };

  const ts = headers.get("opada-timestamp");
  if (!ts) return { ok: false, error: "missing_timestamp" };
  if (!/^\d{1,12}$/.test(ts)) return { ok: false, error: "malformed_timestamp" };
  if (Math.abs(now.getTime() / 1000 - Number(ts)) > TIMESTAMP_WINDOW_SECONDS) {
    return { ok: false, error: "timestamp_outside_window" };
  }

  const sigHeader = headers.get("opada-signature");
  if (!sigHeader) return { ok: false, error: "missing_signature" };
  const m = sigHeader.trim().match(SIGNATURE);
  if (!m) return { ok: false, error: "malformed_signature" };
  const signature = Buffer.from(m[1], m[1].endsWith("==") ? "base64" : "base64url");
  if (signature.length !== 64) return { ok: false, error: "malformed_signature" };

  const key = await store.lookup(keyId);
  if (!key) return { ok: false, error: "unknown_key" };
  if (key.revoked) return { ok: false, error: "revoked_key" };

  const payload = signedPayload(ts, rawBody);
  for (const pk of key.public_keys.slice(0, 2)) {
    let publicKey: KeyObject;
    try {
      publicKey = publicKeyFromRaw(pk);
    } catch {
      continue;
    }
    if (cryptoVerify(null, payload, publicKey, signature)) return { ok: true, key };
  }
  return { ok: false, error: "signature_invalid" };
}
