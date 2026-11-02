import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { paystackKeyFor } from "@/lib/paystack";
import { pollPaystack } from "@/lib/poller";
import { supabaseAdmin } from "@/lib/supabase-admin";

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
    const purge = await purgeBehaviourEvents();
    console.log("[poll-paystack]", JSON.stringify({ ...result, purge }));
    return NextResponse.json({ ...result, purge });
  } catch (err) {
    console.error("[poll-paystack] failed", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 500 });
  }
}

// Behaviour events are kept 30 days (issue #12). Runs with every poll. A
// failure is reported in the response and the log, never swallowed, and
// doesn't undo the poll.
async function purgeBehaviourEvents(): Promise<{ deleted: number } | { error: string }> {
  const { data, error } = await supabaseAdmin().rpc("purge_behaviour_events");
  if (error) {
    console.error("[poll-paystack] behaviour-event purge failed", error.message);
    return { error: error.message };
  }
  return { deleted: typeof data === "number" ? data : 0 };
}
