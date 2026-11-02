import { NextResponse } from "next/server";
import { handleBehaviourEvents, supabaseEmitterKeyStore, supabaseEventSink } from "@/lib/behaviour/ingest";
import { MAX_BODY_BYTES } from "@/lib/behaviour/contract";

// Behaviour-trail ingest, v1. Public contract: issue #12 (Ed25519-signed).
export async function POST(req: Request) {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return NextResponse.json({ error: "body_too_large" }, { status: 413 });

  try {
    const raw = new Uint8Array(await req.arrayBuffer());
    const res = await handleBehaviourEvents(req.headers, raw, new Date(), {
      keys: supabaseEmitterKeyStore(),
      sink: supabaseEventSink(),
    });
    return NextResponse.json(res.body, { status: res.status });
  } catch (err) {
    // Store errors only; never echoes the request.
    console.error("[behaviour-events] failed", err instanceof Error ? err.message : "unknown error");
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
