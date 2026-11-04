import { verifyEmitterRequest, type EmitterKey, type EmitterKeyStore } from "@/lib/behaviour/auth";
import { retentionStatus, type RetentionCheck } from "@/lib/behaviour/retention";
import { MAX_BODY_BYTES, parseBatch, type BehaviourEvent, type EventSource, type RejectionCode } from "@/lib/behaviour/contract";
import { supabaseAdmin } from "@/lib/supabase-admin";

// POST /api/v1/behaviour-events, independent of Next so it can be tested.
// Order: size, authentication (on the raw bytes), the retention check, then
// parsing. Nothing is stored unless the request is authenticated and the
// 30-day purge is running.

// `observed` is not stored: it's folded into `source`.
export type StoredRow = Omit<BehaviourEvent, "observed"> & { merchant_id: string; emitter_id: string; source: EventSource };

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
  deps: { keys: EmitterKeyStore; sink: EventSink; retention: RetentionCheck },
): Promise<IngestResponse> {
  if (rawBody.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: "body_too_large" } };

  const auth = await verifyEmitterRequest(headers, rawBody, now, deps.keys);
  if (!auth.ok) return { status: 401, body: { error: auth.error } };

  // Don't collect what we can't delete: while the 30-day purge is overdue (or
  // its status can't be read), refuse new events.
  let overdue = true;
  try {
    overdue = retentionStatus(await deps.retention.lastPurge(), now).overdue;
  } catch {
    overdue = true;
  }
  if (overdue) return { status: 503, body: { error: "retention_overdue" } };

  const batch = parseBatch(Buffer.from(rawBody).toString("utf8"), now);
  if (!batch.ok) return { status: batch.status, body: { error: batch.error } };

  const rows = batch.accepted.map((e) => toRow(e, auth.key));
  const stored = rows.length ? await deps.sink.insert(rows) : 0;
  const rejected: { event_id: string | null; error: RejectionCode }[] = batch.rejected;
  return { status: 202, body: { accepted: stored, duplicates: rows.length - stored, rejected } };
}

// `source` is set here, from the credential plus the emitter's declaration,
// never named by the request body. A signed (oek_) request can only yield
// server_observed (declared "server", already checked as possible for the
// type) or server_relayed (declared "browser", or not declared). Publishable
// keys (opk_, not built yet) will always yield "client".
export function sourceFor(e: BehaviourEvent): EventSource {
  return e.observed === "server" ? "server_observed" : "server_relayed";
}

function toRow(e: BehaviourEvent, key: EmitterKey): StoredRow {
  const { observed: _observed, ...rest } = e;
  void _observed;
  return { ...rest, merchant_id: key.merchant_id, emitter_id: key.key_id, source: sourceFor(e) };
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
