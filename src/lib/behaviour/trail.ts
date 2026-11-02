import { refLooksLikePii, validRef, type BehaviourEvent, type EventSource } from "@/lib/behaviour/contract";

// Joining a stall to its behaviour events (issue #12, section 1), and
// reducing them to facts for model input.

export const JOIN_TAIL_MS = 15 * 60 * 1000;

export type StoredEvent = BehaviourEvent & { source: EventSource };

export type TrailRefs = { buyerRef: string | null; sessionRef: string | null };

// The refs the emitter attached to the Paystack transaction's metadata.
// Paystack metadata may arrive as an object or a JSON string. A ref that
// fails the format or looks like PII is ignored, never used.
export function trailRefsFromTransaction(tx: Record<string, unknown>): TrailRefs {
  let meta: unknown = tx.metadata;
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  const m = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
  const pick = (v: unknown) => (validRef(v) && !refLooksLikePii(v) ? v : null);
  return { buyerRef: pick(m.opada_buyer_ref), sessionRef: pick(m.opada_session_ref) };
}

export type TrailSelection =
  | { kind: "events"; events: StoredEvent[]; joinedOn: "session_ref" | "buyer_ref" }
  | { kind: "no_ref" }
  | { kind: "no_events" };

// 1. session_ref on the stall: that session's events (exact join).
// 2. else buyer_ref: from the buyer's last checkout_started at or before the
//    transaction's creation, through stalled_at + 15 minutes. One checkout,
//    not the buyer's week.
// 3. neither, or nothing matches: no trail.
// `candidates` are the stored events for this stall's refs; ordering doesn't
// matter.
export function selectTrailEvents(refs: TrailRefs, createdAt: Date, candidates: StoredEvent[]): TrailSelection {
  if (!refs.sessionRef && !refs.buyerRef) return { kind: "no_ref" };
  const sorted = [...candidates].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  const end = createdAt.getTime() + JOIN_TAIL_MS;

  if (refs.sessionRef) {
    const events = sorted.filter((e) => e.session_ref === refs.sessionRef && Date.parse(e.occurred_at) <= end);
    if (events.length) return { kind: "events", events, joinedOn: "session_ref" };
  }
  if (refs.buyerRef) {
    const mine = sorted.filter((e) => e.buyer_ref === refs.buyerRef);
    const start = mine.filter((e) => e.type === "checkout_started" && Date.parse(e.occurred_at) <= createdAt.getTime()).at(-1);
    if (start) {
      const from = Date.parse(start.occurred_at);
      const events = mine.filter((e) => {
        const t = Date.parse(e.occurred_at);
        return t >= from && t <= end;
      });
      return { kind: "events", events, joinedOn: "buyer_ref" };
    }
  }
  return { kind: "no_events" };
}

// One event as the model sees it: its type, its facts, when it happened
// relative to the first event, and where it came from. No refs, no ids, no
// Paystack reference.
export type TrailFact = {
  type: BehaviourEvent["type"];
  at_second: number;
  source: EventSource;
  device: BehaviourEvent["device"];
  kind?: string;
  channel?: string;
  stage?: string;
  last_step?: string;
  reason?: string;
  item_count?: number;
  amount_minor_units?: number;
  currency?: string;
};

const FACT_PROPS = ["kind", "channel", "stage", "last_step", "reason", "item_count", "amount_minor_units", "currency"] as const;

export const MAX_TRAIL_FACTS = 50;

export function trailFacts(events: StoredEvent[]): TrailFact[] {
  if (!events.length) return [];
  const t0 = Date.parse(events[0].occurred_at);
  return events.slice(0, MAX_TRAIL_FACTS).map((e) => {
    const fact: TrailFact = {
      type: e.type,
      at_second: Math.round((Date.parse(e.occurred_at) - t0) / 1000),
      source: e.source,
      device: e.device,
    };
    for (const p of FACT_PROPS) if (p in e.properties) (fact as Record<string, unknown>)[p] = e.properties[p];
    return fact;
  });
}

export const CLIENT_EVENTS_NOTE =
  'Events with "source": "client" came from a browser snippet and can be forged by anyone. Treat them as weak evidence: they can support a reason but never establish one on their own. "server" events were signed by the merchant\'s server.';
