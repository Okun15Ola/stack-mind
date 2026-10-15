import { NextResponse } from "next/server";
import {
  STALL_EVENTS,
  paystackTestKey,
  stallFromEvent,
  verifyPaystackSignature,
  type PaystackEvent,
} from "@/lib/paystack";
import { supabaseAdmin } from "@/lib/supabase-admin";

export async function POST(req: Request) {
  let secretKey: string;
  try {
    secretKey = paystackTestKey();
  } catch (err) {
    console.error("[paystack-webhook]", err instanceof Error ? err.message : err);
    return new NextResponse(null, { status: 500 });
  }

  // Signature check comes first, against the exact raw bytes received.
  const rawBody = await req.text();
  const signature = req.headers.get("x-paystack-signature");
  if (!verifyPaystackSignature(rawBody, signature, secretKey)) {
    return new NextResponse(null, { status: 401 });
  }

  let evt: PaystackEvent;
  try {
    evt = JSON.parse(rawBody);
  } catch {
    return new NextResponse(null, { status: 400 });
  }

  if (!STALL_EVENTS.has(evt.event)) {
    return new NextResponse(null, { status: 200 });
  }

  const row = stallFromEvent(evt);
  if (!row) {
    console.warn(`[paystack-webhook] ${evt.event} without a reference, dropped`);
    return new NextResponse(null, { status: 200 });
  }

  // Idempotent on paystack_reference: a replay, or a stall the poller already
  // caught, hits the unique constraint and is ignored.
  const { error } = await supabaseAdmin()
    .from("stalls")
    .upsert(row, { onConflict: "paystack_reference", ignoreDuplicates: true });

  if (error) {
    // Non-2xx so Paystack retries rather than the stall being lost.
    console.error("[paystack-webhook] insert failed", error.message);
    return new NextResponse(null, { status: 500 });
  }

  return new NextResponse(null, { status: 200 });
}
