import { getDiagnosisModel, type DiagnosisModel } from "@/lib/diagnosis-model";
import { RULES_MODEL_ID, classifyGatewayResponse } from "@/lib/gateway-rules";
import { isReason, type Classification } from "@/lib/reasons";
import { assertNoPii, buildModelInput, knownIdentifiers, scrubText, type StallForModel } from "@/lib/redact";
import type { VerifiedStall } from "@/lib/reverify";
import { supabaseAdmin } from "@/lib/supabase-admin";

// The database refuses a diagnosis once verification is 10 minutes old.
// Stop a minute short so a slow model call fails here, with a clear message.
const MAX_VERIFICATION_AGE_MS = 9 * 60_000;
const MAX_RATIONALE_CHARS = 1000;

export type DiagnosisResult = Classification & {
  stallId: string;
  model: string;
  source: "rules" | "model";
};

export type StallForDiagnosis = StallForModel & {
  id: string;
  status: string;
  customer_identifier: string | null;
};

export type DiagnosisRow = {
  stall_id: string;
  reason: string;
  confidence: number;
  rationale: string;
  model: string;
};

export interface DiagnosisStore {
  loadStall(id: string): Promise<StallForDiagnosis>;
  saveDiagnosis(row: DiagnosisRow): Promise<void>;
}

export class StaleVerificationError extends Error {}

export function supabaseDiagnosisStore(): DiagnosisStore {
  return {
    async loadStall(id) {
      const { data, error } = await supabaseAdmin()
        .from("stalls")
        .select("id, status, gateway_response, amount, currency, event_type, customer_identifier, payload")
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
        .update({ status: "diagnosed" })
        .eq("id", row.stall_id)
        .in("status", ["new", "diagnosing"]);
      if (statusError) throw new Error(`diagnose status ${row.stall_id}: ${statusError.message}`);
    },
  };
}

// Checks a provider's raw output. Anything off-schema throws rather than being
// coerced into a plausible-looking diagnosis.
export function validateClassification(output: unknown): Classification {
  const o = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  if (!o) throw new Error("model output is not an object");
  if (!isReason(o.reason)) throw new Error("model output has an invalid reason");
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
  deps: { store?: DiagnosisStore; model?: DiagnosisModel | null; now?: () => Date } = {},
): Promise<DiagnosisResult> {
  const store = deps.store ?? supabaseDiagnosisStore();
  const now = deps.now ?? (() => new Date());
  assertFresh(stall, now());

  const row = await store.loadStall(stall.id);
  if (row.status === "resolved") throw new Error(`stall ${stall.id} is resolved; refusing to diagnose`);

  const gatewayResponse = stall.gatewayResponse ?? row.gateway_response;
  let result: DiagnosisResult;

  const ruled = classifyGatewayResponse(gatewayResponse);
  if (ruled) {
    result = { ...ruled, stallId: stall.id, model: RULES_MODEL_ID, source: "rules" };
  } else {
    const model = deps.model === undefined ? getDiagnosisModel() : deps.model;
    if (!model) {
      throw new Error(
        `stall ${stall.id}: gateway_response not recognised by rules and no DIAGNOSIS_MODEL_PROVIDER is set`,
      );
    }
    const input = buildModelInput(row, gatewayResponse);
    assertNoPii(input, knownIdentifiers(row));

    const { output, model: modelId } = await model.classify(input);
    result = { ...validateClassification(output), stallId: stall.id, model: modelId, source: "model" };
    assertFresh(stall, now());
  }

  await store.saveDiagnosis({
    stall_id: result.stallId,
    reason: result.reason,
    confidence: result.confidence,
    rationale: result.rationale,
    model: result.model,
  });
  return result;
}
