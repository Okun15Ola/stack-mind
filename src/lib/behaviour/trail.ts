import { refLooksLikePii, validRef, type BehaviourEvent, type EventSource } from "@/lib/behaviour/contract";

// Joining a stall to its behaviour events (issue #12, section 1), and
// reducing them to facts for model input.

export const JOIN_TAIL_MS = 15 * 60 * 1000;

// As stored: `observed` is folded into `source` at ingest.
export type StoredEvent = Omit<BehaviourEvent, "observed"> & { source: EventSource };

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
  // Who observed the event. Named "provenance" in model input, never
  // "source": "source" is reserved for the stall's own webhook/poll origin,
  // which must never reach a prompt.
  provenance: EventSource;
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
      provenance: e.source,
      device: e.device,
    };
    for (const p of FACT_PROPS) if (p in e.properties) (fact as Record<string, unknown>)[p] = e.properties[p];
    return fact;
  });
}

// What each non-first-hand source means, stated plainly in the model input
// whenever such events are present. No numeric weights: server_relayed and
// client are the same class (browser assertions) but not equally forgeable,
// and flattening them into one number would hide that.
export const SOURCE_NOTES = {
  common:
    'Events with "provenance": "server_observed" were seen by the merchant\'s own server during its own work. Events with any other provenance are browser assertions: they can support a reason but never establish one on their own.',
  server_relayed:
    '"server_relayed" events were reported by the buyer\'s browser and passed on by the merchant\'s server, which vouches that it sent them, not that they happened. Anyone able to call the merchant\'s own endpoint could have faked one.',
  client:
    '"client" events were sent straight from a browser with a public key. Anyone could have faked one, and no merchant vouches for them.',
} as const;

export function sourcesNote(facts: TrailFact[]): string | null {
  const relayed = facts.some((f) => f.provenance === "server_relayed");
  const client = facts.some((f) => f.provenance === "client");
  if (!relayed && !client) return null;
  return [SOURCE_NOTES.common, relayed ? SOURCE_NOTES.server_relayed : null, client ? SOURCE_NOTES.client : null]
    .filter(Boolean)
    .join(" ");
}

// How many joined events came from each source. Computed by code at
// diagnosis time and stored on the diagnosis, so the owner can see what a
// decision rested on. Never read from the model.
export type TrailSources = Record<EventSource, number>;

export function trailSources(events: { source: EventSource }[]): TrailSources {
  const counts: TrailSources = { server_observed: 0, server_relayed: 0, client: 0 };
  for (const e of events) counts[e.source]++;
  return counts;
}
