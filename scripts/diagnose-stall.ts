// Re-verifies and diagnoses one stall by Paystack reference.
//
//   npm run diagnose -- <paystack_reference>
//
// Writes to Supabase: stalls.verified_at (and resolves the stall if the
// customer has paid), then one diagnoses row. Sends nothing to the customer.
// Reads .env.local; test-mode Paystack key only.

import { diagnoseStall } from "@/lib/diagnose";
import { reverifyStall } from "@/lib/reverify";
import { supabaseAdmin } from "@/lib/supabase-admin";

async function main(): Promise<number> {
  const reference = process.argv[2];
  if (!reference) {
    console.error("usage: npm run diagnose -- <paystack_reference>");
    return 1;
  }

  const { data: stall, error } = await supabaseAdmin()
    .from("stalls")
    .select("id")
    .eq("paystack_reference", reference)
    .maybeSingle<{ id: string }>();
  if (error) throw new Error(error.message);
  if (!stall) {
    console.error(`no stall with reference ${reference}`);
    return 1;
  }

  const check = await reverifyStall(stall.id);
  if (check.outcome === "resolved") {
    console.log(JSON.stringify({ reference, outcome: "resolved", paidReference: check.paidReference }, null, 2));
    return 0;
  }

  const result = await diagnoseStall(check.stall);
  console.log(JSON.stringify({ reference, paystackStatus: check.stall.paystackStatus, ...result }, null, 2));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
