// Runs the Paystack poller locally, without the dev server, the HTTP route or
// the cron secret.
//
//   npm run poll              one sweep, exactly as the cron does (same
//                             cursor and lease lock, so it can't overlap a
//                             cron run)
//   npm run poll -- <ref>     ingest one transaction by Paystack reference
//
// Registers as the "poller" entrypoint for the Paystack key policy: a live
// key needs PAYSTACK_LIVE_READ_ONLY=true and OPADA_DRY_RUN=true. Only the
// allowlisted GET endpoints are reachable. It sends nothing to anyone and
// writes only to our own stalls table; repeat runs never duplicate a stall.
// Output carries references and statuses only, never customer data.

import { paystackKeyFor } from "@/lib/paystack";
import { ingestOne, pollPaystack } from "@/lib/poller";

async function main(): Promise<number> {
  // Refuses to start on a disallowed key setup, before anything else runs.
  const secretKey = paystackKeyFor("poller");
  const args = process.argv.slice(2);
  if (args.length > 1) {
    console.error("usage: npm run poll [-- <paystack_reference>]");
    return 1;
  }

  if (args.length === 0) {
    const result = await pollPaystack(secretKey);
    console.log(JSON.stringify({ mode: "sweep", ...result }, null, 2));
    return 0;
  }

  const reference = args[0];
  if (!/^[A-Za-z0-9._=-]{1,100}$/.test(reference)) {
    console.error("poll: that doesn't look like a Paystack reference");
    return 1;
  }
  const result = await ingestOne(secretKey, reference);
  console.log(JSON.stringify({ mode: "reference", ...result }, null, 2));
  return result.outcome === "not_a_stall" ? 2 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
