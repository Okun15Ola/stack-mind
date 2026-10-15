import {
  SETTLED_STATUSES,
  listTransactions,
  paystackTestKey,
  verifyTransaction,
} from "@/lib/paystack";
import { supabaseAdmin } from "@/lib/supabase-admin";

// Hard rule: nothing diagnoses or acts on a stall without first passing it
// through reverifyStall(). Diagnosis and action code takes a VerifiedStall,
// which only this module can produce. The database enforces the same rule
// independently (see assert_stall_actionable in 0002_poller.sql): diagnoses
// and action execution are refused unless verified_at is under 10 minutes old.
declare const verifiedBrand: unique symbol;

export type VerifiedStall = {
  readonly [verifiedBrand]: true;
  readonly id: string;
  readonly reference: string;
  readonly paystackStatus: string;
  readonly verifiedAt: Date;
};

export type ReverifyResult =
  | { outcome: "open"; stall: VerifiedStall }
  | { outcome: "resolved"; stallId: string; paidReference: string };

type StallForCheck = {
  id: string;
  paystack_reference: string;
  status: string;
  amount: number | null;
  currency: string | null;
  stalled_at: string;
  resolved_reference: string | null;
};

// Re-checks a stall against Paystack right now. Resolves the stall, and returns
// "resolved", if the customer has paid:
//   - this reference has since succeeded, or
//   - the same customer has a successful payment for the same amount and
//     currency since the stall began (a retry on a fresh checkout gets a new
//     reference, leaving the original abandoned forever).
// Throws on any Paystack or database error. Callers must treat a throw as
// "do not proceed".
export async function reverifyStall(stallId: string): Promise<ReverifyResult> {
  const secretKey = paystackTestKey();
  const db = supabaseAdmin();

  const { data: stall, error } = await db
    .from("stalls")
    .select("id, paystack_reference, status, amount, currency, stalled_at, resolved_reference")
    .eq("id", stallId)
    .single<StallForCheck>();
  if (error) throw new Error(`reverify load ${stallId}: ${error.message}`);

  if (stall.status === "resolved") {
    return { outcome: "resolved", stallId, paidReference: stall.resolved_reference ?? stall.paystack_reference };
  }

  const tx = await verifyTransaction(secretKey, stall.paystack_reference);
  const currentStatus = tx.status ?? "unknown";
  let paidReference: string | null = SETTLED_STATUSES.has(currentStatus) ? stall.paystack_reference : null;

  if (!paidReference) {
    const customerId = tx.customer?.id;
    const amount = stall.amount ?? tx.amount ?? null;
    const currency = stall.currency ?? tx.currency ?? null;
    if (typeof customerId !== "number" || amount === null || !currency) {
      // Cannot rule out a payment on another reference, so refuse.
      throw new Error(`reverify ${stallId}: missing customer id, amount or currency; cannot check for other payments`);
    }

    const successes = await listTransactions(secretKey, {
      from: new Date(stall.stalled_at),
      status: "success",
      customer: customerId,
    });
    const match = successes.find(
      (t) => t.status === "success" && t.amount === amount && t.currency === currency && t.reference,
    );
    paidReference = match?.reference ?? null;
  }

  const verifiedAt = new Date();

  if (paidReference) {
    const { error: updateError } = await db
      .from("stalls")
      .update({
        status: "resolved",
        resolved_at: verifiedAt.toISOString(),
        resolved_reference: paidReference,
        verified_at: verifiedAt.toISOString(),
        verified_status: currentStatus,
      })
      .eq("id", stallId)
      .neq("status", "resolved");
    if (updateError) throw new Error(`reverify resolve ${stallId}: ${updateError.message}`);
    return { outcome: "resolved", stallId, paidReference };
  }

  const { error: updateError } = await db
    .from("stalls")
    .update({ verified_at: verifiedAt.toISOString(), verified_status: currentStatus })
    .eq("id", stallId);
  if (updateError) throw new Error(`reverify record ${stallId}: ${updateError.message}`);

  return {
    outcome: "open",
    stall: {
      id: stall.id,
      reference: stall.paystack_reference,
      paystackStatus: currentStatus,
      verifiedAt,
    } as VerifiedStall,
  };
}
