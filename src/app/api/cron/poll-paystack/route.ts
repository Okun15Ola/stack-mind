import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { paystackKeyFor } from "@/lib/paystack";
import { pollPaystack } from "@/lib/poller";
import { retentionStatus, supabaseRetentionCheck } from "@/lib/behaviour/retention";

export const maxDuration = 60;

export async function GET(req: Request) {
  if (!isAuthorizedCron(req.headers.get("authorization"))) {
    return new NextResponse(null, { status: 401 });
  }

  let secretKey: string;
  try {
    secretKey = paystackKeyFor("poller");
  } catch (err) {
    console.error("[poll-paystack] refused to start:", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 500 });
  }

  try {
    const result = await pollPaystack(secretKey);
    // Retention runs in pg_cron, not here; this only checks it is running.
    const retention = await checkRetention();
    console.log("[poll-paystack]", JSON.stringify({ ...result, retention }));
    if (retention.overdue) {
      console.error("[poll-paystack] behaviour-event purge overdue: retention is not being enforced", JSON.stringify(retention));
      return NextResponse.json({ ...result, retention }, { status: 500 });
    }
    return NextResponse.json({ ...result, retention });
  } catch (err) {
    console.error("[poll-paystack] failed", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 500 });
  }
}

// A failure to read the status counts as overdue: retention unknown is
// retention not proven.
async function checkRetention() {
  try {
    return retentionStatus(await supabaseRetentionCheck().lastPurge(), new Date());
  } catch (err) {
    return { lastPurge: null, overdue: true, hoursSince: null, error: err instanceof Error ? err.message : "unknown error" };
  }
}
