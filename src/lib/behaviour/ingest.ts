import { verifyEmitterRequest, type EmitterKey, type EmitterKeyStore } from "@/lib/behaviour/auth";
import { MAX_BODY_BYTES, parseBatch, type BehaviourEvent, type RejectionCode } from "@/lib/behaviour/contract";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/v1/behaviour-events, independent of Next so it can be tested.
// Order: size, authentication (on the raw bytes), then parsing. Nothing is
// stored unless the request is authenticated.

export type StoredRow = BehaviourEvent & { merchant_id: string; emitter_id: string; source: "server" };

export interface EventSink {
  // Inserts rows, ignoring any (merchant_id, event_id) already stored.
  // Returns how many were newly stored.
  insert(rows: StoredRow[]): Promise<number>;
}

export type IngestResponse = { status: number; body: Record<string, unknown> };

export async function handleBehaviourEvents(
  headers: { get(name: string): string | null },
  rawBody: Uint8Array,
  now: Date,
  deps: { keys: EmitterKeyStore; sink: EventSink },
): Promise<IngestResponse> {
  if (rawBody.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: "body_too_large" } };

  const auth = await verifyEmitterRequest(headers, rawBody, now, deps.keys);
  if (!auth.ok) return { status: 401, body: { error: auth.error } };

  const batch = parseBatch(Buffer.from(rawBody).toString("utf8"), now);
  if (!batch.ok) return { status: batch.status, body: { error: batch.error } };

  const rows = batch.accepted.map((e) => toRow(e, auth.key));
  const stored = rows.length ? await deps.sink.insert(rows) : 0;
  const rejected: { event_id: string | null; error: RejectionCode }[] = batch.rejected;
  return { status: 202, body: { accepted: stored, duplicates: rows.length - stored, rejected } };
}

// `source` is set here, from the credential, never from the request body.
function toRow(e: BehaviourEvent, key: EmitterKey): StoredRow {
  return { ...e, merchant_id: key.merchant_id, emitter_id: key.key_id, source: "server" };
}

export function supabaseEmitterKeyStore(): EmitterKeyStore {
  return {
    async lookup(keyId) {
      const { data, error } = await supabaseAdmin()
        .from("emitter_keys")
        .select("key_id, merchant_id, emitter_name, environment, public_key_1, public_key_2, revoked_at")
        .eq("key_id", keyId)
        .maybeSingle<{
          key_id: string;
          merchant_id: string;
          emitter_name: string;
          environment: "test" | "live";
          public_key_1: string;
          public_key_2: string | null;
          revoked_at: string | null;
        }>();
      if (error) throw new Error(`emitter key lookup: ${error.message}`);
      if (!data) return null;
      return {
        key_id: data.key_id,
        merchant_id: data.merchant_id,
        emitter_name: data.emitter_name,
        environment: data.environment,
        public_keys: [data.public_key_1, data.public_key_2].filter((k): k is string => !!k),
        revoked: data.revoked_at !== null,
      };
    },
  };
}

export function supabaseEventSink(): EventSink {
  return {
    async insert(rows) {
      const { data, error } = await supabaseAdmin()
        .from("behaviour_events")
        .upsert(rows, { onConflict: "merchant_id,event_id", ignoreDuplicates: true })
        .select("event_id");
      if (error) throw new Error(`behaviour events insert: ${error.message}`);
      return data?.length ?? 0;
    },
  };
}
