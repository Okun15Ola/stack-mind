import { NextResponse } from "next/server";
import { isAuthorizedCron } from "@/lib/cron-auth";
import { paystackKeyFor } from "@/lib/paystack";
import { pollPaystack } from "@/lib/poller";

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
    console.log("[poll-paystack]", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (err) {
    console.error("[poll-paystack] failed", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 500 });
  }
}
