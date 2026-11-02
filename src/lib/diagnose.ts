import { ModelRefusedError, ModelUnparseableError, getDiagnosisModel, type DiagnosisModel, type ModelRefusal } from "@/lib/diagnosis-model";
import { RULES_MODEL_ID, classifyGatewayResponse } from "@/lib/gateway-rules";
import { JOIN_TAIL_MS, selectTrailEvents, trailRefsFromTransaction, type StoredEvent, type TrailRefs, type TrailSelection } from "@/lib/behaviour/trail";
import { evidenceGaps, type EvidenceGap } from "@/lib/evidence";
import { isOutcome, type Classification } from "@/lib/reasons";
import { PiiLeakError, assertNoPii, buildModelInput, knownIdentifiers, scrubText, transactionFromPayload, type StallForModel } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";
import { supabaseAdmin } from "@/lib/supabase-admin";

// The database refuses a diagnosis once verification is 10 minutes old.
// Stop a minute short so a slow model call fails here, with a clear message.
const MAX_VERIFICATION_AGE_MS = 9 * 60_000;
const MAX_RATIONALE_CHARS = 1000;

export type DiagnosisResult = Classification & {
  // See DiagnosisRow.evidence_gaps.
  evidenceGaps: EvidenceGap[];
  stallId: string;
  // The model that actually produced the diagnosis; after a refusal fallback,
  // the fallback model.
  model: string;
  source: "rules" | "model";
  // Models that refused before `model` answered. Each one is also logged.
  refusals: ModelRefusal[];
};

// Log lines carry the stall id, model ids and refusal category only: no input,
// no output, no customer data.
function logRefusals(log: (line: string) => void, stallId: string, refusals: ModelRefusal[], answeredBy: string | null) {
  for (const r of refusals) {
    log(
      `[diagnose] stall ${stallId}: ${r.model} refused (${r.category ?? "no category"}); ` +
        (answeredBy ? `answered by ${answeredBy}` : "no model answered, stall left undiagnosed"),
    );
  }
}

export type StallForDiagnosis = StallForModel & {
  id: string;
  status: string;
  customer_identifier: string | null;
  // When the transaction was created. Needed to join the behaviour trail.
  stalled_at?: string | null;
};

export type DiagnosisRow = {
  stall_id: string;
  reason: string;
  confidence: number;
  rationale: string;
  model: string;
  // Sections of the model input that were unavailable, computed by code.
  // Empty for rule diagnoses (no model input is built). For an
  // INSUFFICIENT_EVIDENCE diagnosis, this is what would have been needed.
  evidence_gaps: EvidenceGap[];
};

export interface DiagnosisStore {
  loadStall(id: string): Promise<StallForDiagnosis>;
  // Also clears any earlier block flag on the stall.
  saveDiagnosis(row: DiagnosisRow): Promise<void>;
  // Stored behaviour events for these refs, at or before `until`. The join
  // itself (selectTrailEvents) is pure and runs on what this returns.
  loadBehaviourEvents(refs: TrailRefs, until: Date): Promise<StoredEvent[]>;
  // Marks the stall as blocked from diagnosis. Never changes its status: the
  // stall stays undiagnosed and is never marked resolved. `reason` carries the
  // kind of block and model ids or field paths only, never customer data.
  flagBlocked(stallId: string, reason: string): Promise<void>;
}

export class StaleVerificationError extends Error {}

export function supabaseDiagnosisStore(): DiagnosisStore {
  return {
    async loadStall(id) {
      const { data, error } = await supabaseAdmin()
        .from("stalls")
        .select("id, status, gateway_response, amount, currency, event_type, customer_identifier, stalled_at, payload")
        .eq("id", id)
        .single<StallForDiagnosis>();
      if (error) throw new Error(`diagnose load ${id}: ${error.message}`);
      return data;
    },

    async saveDiagnosis(row) {
      const db = supabaseAdmin();
      // The insert is where the database enforces the re-verify rule; its
      // refusal surfaces here as an error, never as a silent skip.
      const { error } = await db.from("diagnoses").insert(row);
      if (error) {
        if (error.code === "23505") throw new Error(`stall ${row.stall_id} already has a diagnosis`);
        throw new Error(`diagnose save ${row.stall_id}: ${error.message}`);
      }
      const { error: statusError } = await db
        .from("stalls")
        .update({ status: "diagnosed", diagnosis_blocked: null, diagnosis_blocked_at: null })
        .eq("id", row.stall_id)
        .in("status", ["new", "diagnosing"]);
      if (statusError) throw new Error(`diagnose status ${row.stall_id}: ${statusError.message}`);
    },

    async loadBehaviourEvents(refs, until) {
      const db = supabaseAdmin();
      const results: StoredEvent[] = [];
      for (const [column, value] of [
        ["session_ref", refs.sessionRef],
        ["buyer_ref", refs.buyerRef],
      ] as const) {
        if (!value) continue;
        const { data, error } = await db
          .from("behaviour_events")
          .select("event_id, type, occurred_at, buyer_ref, session_ref, device, properties, source")
          .eq(column, value)
          .lte("occurred_at", until.toISOString())
          .order("occurred_at", { ascending: true })
          .limit(500);
        if (error) throw new Error(`behaviour events load: ${error.message}`);
        results.push(...((data ?? []) as StoredEvent[]));
      }
      const seen = new Set<string>();
      return results.filter((e) => (seen.has(e.event_id) ? false : (seen.add(e.event_id), true)));
    },

    async flagBlocked(stallId, reason) {
      const { error } = await supabaseAdmin()
        .from("stalls")
        .update({ diagnosis_blocked: reason.slice(0, MAX_BLOCK_REASON_CHARS), diagnosis_blocked_at: new Date().toISOString() })
        .eq("id", stallId);
      if (error) throw new Error(`diagnose flag ${stallId}: ${error.message}`);
    },
  };
}

const MAX_BLOCK_REASON_CHARS = 500;

// Why diagnosis was blocked, for the stall's flag. Model ids, categories,
// leak kind and field path only.
function blockReason(err: unknown): string | null {
  if (err instanceof ModelRefusedError) {
    return `model_refused: ${err.refusals.map((r) => `${r.model} (${r.category ?? "no category"})`).join("; ")}`;
  }
  if (err instanceof ModelUnparseableError) return `model_unparseable: ${err.model} (${err.attempts} attempts)`;
  if (err instanceof PiiLeakError) return `pii_gate: ${err.kind} at ${err.path}`;
  return null;
}

// The behaviour trail for a stall: refs from the transaction's metadata, then
// the join rules in selectTrailEvents. A stall created before the trail, or
// with no recorded creation time, has no trail.
async function loadTrail(store: DiagnosisStore, row: StallForDiagnosis): Promise<TrailSelection> {
  const refs = trailRefsFromTransaction(transactionFromPayload(row.payload));
  if (!refs.buyerRef && !refs.sessionRef) return { kind: "no_ref" };
  const createdAt = row.stalled_at ? new Date(row.stalled_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) return { kind: "no_events" };
  const candidates = await store.loadBehaviourEvents(refs, new Date(createdAt.getTime() + JOIN_TAIL_MS));
  return selectTrailEvents(refs, createdAt, candidates);
}

// Checks a provider's raw output. Anything off-schema throws rather than being
// coerced into a plausible-looking diagnosis.
export function validateClassification(output: unknown): Classification {
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  if (!o) throw new Error("model output is not an object");
  if (!isOutcome(o.reason)) throw new Error("model output has an invalid reason");
  const confidence = o.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("model output confidence is not a number between 0 and 1");
  }
  const rationale = typeof o.rationale === "string" ? scrubText(o.rationale.trim()) : "";
  if (!rationale) throw new Error("model output has no rationale");
  return {
    reason: o.reason,
    confidence: Math.round(confidence * 1000) / 1000,
    rationale: rationale.slice(0, MAX_RATIONALE_CHARS),
  };
}

function assertFresh(stall: VerifiedStall, now: Date): void {
  const age = now.getTime() - stall.verifiedAt.getTime();
  if (age > MAX_VERIFICATION_AGE_MS) {
    throw new StaleVerificationError(
      `stall ${stall.id} was verified ${Math.round(age / 1000)}s ago; re-verify before diagnosing`,
    );
  }
}

// Diagnoses one stall and records it. Takes a VerifiedStall, so the caller has
// already re-checked Paystack and the customer has not paid.
//
// Classification rests on gateway_response: known Paystack strings are
// classified by rule with no external call; anything else goes to the
// configured model as an allowlisted, redacted view of the stall. With no
// model configured, an unrecognised stall throws and stays undiagnosed.
export async function diagnoseStall(
  stall: VerifiedStall,
  deps: {
    store?: DiagnosisStore;
    model?: DiagnosisModel | null;
    now?: () => Date;
    log?: (line: string) => void;
  } = {},
): Promise<DiagnosisResult> {
  const store = deps.store ?? supabaseDiagnosisStore();
  const log = deps.log ?? ((line: string) => console.warn(line));
  const now = deps.now ?? (() => new Date());
  assertFresh(stall, now());

  const row = await store.loadStall(stall.id);
  if (row.status === "resolved") throw new Error(`stall ${stall.id} is resolved; refusing to diagnose`);

  const gatewayResponse = stall.gatewayResponse ?? row.gateway_response;
  let result: DiagnosisResult;

  const ruled = classifyGatewayResponse(gatewayResponse);
  if (ruled) {
    result = { ...ruled, stallId: stall.id, model: RULES_MODEL_ID, source: "rules", refusals: [], evidenceGaps: [] };
  } else {
    const model = deps.model === undefined ? getDiagnosisModel() : deps.model;
    if (!model) {
      throw new Error(
        `stall ${stall.id}: gateway_response not recognised by rules and no DIAGNOSIS_MODEL_PROVIDER is set`,
      );
    }
    const trail = await loadTrail(store, row);
    let classified;
    let gaps: EvidenceGap[] = [];
    try {
      const input = buildModelInput(row, gatewayResponse, trail);
      gaps = evidenceGaps(input);
      assertNoPii(input, knownIdentifiers(row));
      classified = await model.classify(input);
    } catch (err) {
      if (err instanceof ModelRefusedError) logRefusals(log, stall.id, err.refusals, null);
      const reason = blockReason(err);
      if (reason) {
        // Flag the stall so the block is visible in the table, then rethrow:
        // the caller still sees the original error and nothing is saved.
        try {
          await store.flagBlocked(stall.id, reason);
          log(`[diagnose] stall ${stall.id}: diagnosis blocked (${reason}); flagged, left undiagnosed`);
        } catch (flagErr) {
          log(
            `[diagnose] stall ${stall.id}: diagnosis blocked (${reason}); FAILED to flag the stall: ` +
              (flagErr instanceof Error ? flagErr.message : "unknown error"),
          );
        }
      }
      throw err;
    }
    const { output, model: modelId, refusals } = classified;
    if (typeof modelId !== "string" || !modelId.trim()) throw new Error(`stall ${stall.id}: provider did not name the model that answered`);
    if (!Array.isArray(refusals)) throw new Error(`stall ${stall.id}: provider did not report refusals`);
    logRefusals(log, stall.id, refusals, modelId);
    result = { ...validateClassification(output), stallId: stall.id, model: modelId, source: "model", refusals, evidenceGaps: gaps };
    assertFresh(stall, now());
  }

  await store.saveDiagnosis({
    stall_id: result.stallId,
    reason: result.reason,
    confidence: result.confidence,
    rationale: result.rationale,
    model: result.model,
    evidence_gaps: result.evidenceGaps,
  });
  return result;
}
