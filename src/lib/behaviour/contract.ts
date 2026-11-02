// The behaviour-trail ingest contract, v1 (issue #12, approved).
//
// Public from day one: the same body schema serves ShopCart and PassMate now
// and a third-party snippet later. No free-text fields anywhere: every
// property is an integer, an ISO code or an enum, and unknown properties or
// enum values are rejected, never ignored. Errors name the rule broken and
// never echo the value.

export const MAX_EVENTS_PER_BATCH = 100;
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_PAST_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

const REF = /^[A-Za-z0-9_-]{22,64}$/;
const EVENT_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CURRENCY = /^[A-Z]{3}$/;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const PAYSTACK_REFERENCE = /^[A-Za-z0-9._=-]{1,100}$/;

export const DEVICES = ["mobile", "tablet", "desktop"] as const;

// Every event type and its allowed properties. `required` lists properties
// that must be present.
type PropSpec = { kind: "int" } | { kind: "currency" } | { kind: "paystack_reference" } | { kind: "enum"; values: readonly string[] };

export const EVENT_TYPES = {
  checkout_started: {
    required: [],
    props: { item_count: { kind: "int" }, amount_minor_units: { kind: "int" }, currency: { kind: "currency" } },
  },
  info_viewed: {
    required: ["kind"],
    props: {
      kind: { kind: "enum", values: ["pricing", "terms", "refund_or_returns", "delivery", "faq", "payment_methods", "contact", "other"] },
    },
  },
  question_asked: {
    required: ["channel"],
    props: { channel: { kind: "enum", values: ["chat", "whatsapp", "email", "phone", "form", "other"] } },
  },
  payment_started: {
    required: [],
    props: { paystack_reference: { kind: "paystack_reference" } },
  },
  payment_closed: {
    required: [],
    props: { stage: { kind: "enum", values: ["before_method", "card_entry", "otp_or_pin", "bank_transfer", "unknown"] } },
  },
  checkout_left: {
    required: [],
    props: {
      last_step: { kind: "enum", values: ["cart", "details", "delivery", "payment", "other"] },
      reason: { kind: "enum", values: ["navigated", "closed", "idle"] },
    },
  },
} as const satisfies Record<string, { required: readonly string[]; props: Record<string, PropSpec> }>;

export type EventType = keyof typeof EVENT_TYPES;
export type Device = (typeof DEVICES)[number];
export type EventSource = "server" | "client";

export type BehaviourEvent = {
  event_id: string;
  type: EventType;
  occurred_at: string;
  buyer_ref: string;
  session_ref: string | null;
  device: Device | null;
  properties: Record<string, string | number>;
};

export type RejectionCode =
  | "not_an_object"
  | "unknown_field"
  | "invalid_event_id"
  | "unknown_type"
  | "invalid_occurred_at"
  | "occurred_at_out_of_range"
  | "invalid_buyer_ref"
  | "invalid_session_ref"
  | "ref_looks_like_pii"
  | "invalid_device"
  | "properties_not_an_object"
  | "unknown_property"
  | "missing_property"
  | "invalid_property_value";

export type ParseResult = { ok: true; event: BehaviourEvent } | { ok: false; event_id: string | null; error: RejectionCode };

const ENVELOPE_FIELDS = new Set(["event_id", "type", "occurred_at", "buyer_ref", "session_ref", "device", "properties"]);

// A ref that passes the format but looks like a phone number or card number
// (all digits) is refused: refs must be random, never derived from PII.
export function refLooksLikePii(ref: string): boolean {
  return /^\d+$/.test(ref.replace(/[_-]/g, "")) || /@/.test(ref);
}

export function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && REF.test(ref);
}

export function parseEvent(raw: unknown, now: Date): ParseResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, event_id: null, error: "not_an_object" };
  const o = raw as Record<string, unknown>;
  const eventId = typeof o.event_id === "string" && EVENT_ID.test(o.event_id) ? o.event_id : null;
  const fail = (error: RejectionCode): ParseResult => ({ ok: false, event_id: eventId, error });

  for (const k of Object.keys(o)) if (!ENVELOPE_FIELDS.has(k)) return fail("unknown_field");
  if (!eventId) return fail("invalid_event_id");
  if (typeof o.type !== "string" || !Object.hasOwn(EVENT_TYPES, o.type)) return fail("unknown_type");
  const type = o.type as EventType;

  if (typeof o.occurred_at !== "string" || !RFC3339_UTC.test(o.occurred_at) || Number.isNaN(Date.parse(o.occurred_at))) {
    return fail("invalid_occurred_at");
  }
  const at = Date.parse(o.occurred_at);
  if (at < now.getTime() - MAX_PAST_MS || at > now.getTime() + MAX_FUTURE_MS) return fail("occurred_at_out_of_range");

  if (!validRef(o.buyer_ref)) return fail("invalid_buyer_ref");
  if (o.session_ref !== undefined && o.session_ref !== null && !validRef(o.session_ref)) return fail("invalid_session_ref");
  const sessionRef = (o.session_ref as string | null | undefined) ?? null;
  if (refLooksLikePii(o.buyer_ref) || (sessionRef && refLooksLikePii(sessionRef))) return fail("ref_looks_like_pii");

  if (o.device !== undefined && o.device !== null && !(DEVICES as readonly unknown[]).includes(o.device)) return fail("invalid_device");

  const spec = EVENT_TYPES[type];
  const props = o.properties === undefined ? {} : o.properties;
  if (!props || typeof props !== "object" || Array.isArray(props)) return fail("properties_not_an_object");
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(props as Record<string, unknown>)) {
    const p = (spec.props as Record<string, PropSpec>)[name];
    if (!p) return fail("unknown_property");
    const valid =
      p.kind === "int"
        ? Number.isSafeInteger(value) && (value as number) >= 0
        : p.kind === "currency"
          ? typeof value === "string" && CURRENCY.test(value)
          : p.kind === "paystack_reference"
            ? typeof value === "string" && PAYSTACK_REFERENCE.test(value)
            : typeof value === "string" && p.values.includes(value);
    if (!valid) return fail("invalid_property_value");
    out[name] = value as string | number;
  }
  for (const r of spec.required as readonly string[]) if (!(r in out)) return fail("missing_property");

  return {
    ok: true,
    event: {
      event_id: eventId,
      type,
      occurred_at: new Date(at).toISOString(),
      buyer_ref: o.buyer_ref,
      session_ref: sessionRef,
      device: (o.device as Device | null | undefined) ?? null,
      properties: out,
    },
  };
}

export type BatchResult =
  | { ok: false; status: 400 | 413; error: string }
  | { ok: true; accepted: BehaviourEvent[]; rejected: { event_id: string | null; error: RejectionCode }[] };

// Parses a raw request body. Valid events in a batch are kept even when
// others are rejected.
export function parseBatch(rawBody: string, now: Date): BatchResult {
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) return { ok: false, status: 413, error: "body_too_large" };
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, error: "invalid_json" };
  }
  const events = body && typeof body === "object" && !Array.isArray(body) ? (body as { events?: unknown }).events : undefined;
  if (!Array.isArray(events) || events.length === 0) return { ok: false, status: 400, error: "events_must_be_a_non_empty_array" };
  if (Object.keys(body as object).some((k) => k !== "events")) return { ok: false, status: 400, error: "unknown_field" };
  if (events.length > MAX_EVENTS_PER_BATCH) return { ok: false, status: 400, error: "too_many_events" };

  const accepted: BehaviourEvent[] = [];
  const rejected: { event_id: string | null; error: RejectionCode }[] = [];
  for (const raw of events) {
    const r = parseEvent(raw, now);
    if (r.ok) accepted.push(r.event);
    else rejected.push({ event_id: r.event_id, error: r.error });
  }
  return { ok: true, accepted, rejected };
}
