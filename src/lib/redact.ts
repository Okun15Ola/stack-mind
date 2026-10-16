// Builds the only view of a stall that may reach a model, and refuses to send
// it if anything identifying slips through.
//
// Two layers, both required:
//   1. Allowlist: buildModelInput() copies named, non-identifying fields into a
//      new object. The payload is never spread or serialised wholesale.
//   2. Gate: assertNoPii() scans every string in that object for email, phone,
//      IP, card-like numbers and Paystack customer/authorization codes, and for
//      the stall's own known identifiers (email, phone, names, IP). Any hit
//      throws, and the model is not called.
// Free text inside allowed fields is scrubbed on the way in as well.

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
// Phone, card and account numbers: 8+ digits, allowing separators.
const LONG_NUMBER = /\+?\d[\d\s().-]{6,}\d/g;
const PAYSTACK_CODE = /\b(?:CUS|AUTH|PLN|SUB|ACCT|TRF)_[a-z0-9]+\b/gi;

export function scrubText(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, "[ip]")
    .replace(PAYSTACK_CODE, "[code]")
    .replace(LONG_NUMBER, "[number]");
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? scrubText(v.trim()) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

// Webhook rows store the event envelope ({event, data}); poll rows store the transaction.
export function transactionFromPayload(payload: unknown): Json {
  const p = obj(payload) ?? {};
  return typeof p.event === "string" ? (obj(p.data) ?? {}) : p;
}

const MAX_HISTORY_STEPS = 30;

export type ModelInput = {
  gateway_response: string | null;
  amount_minor_units: number | null;
  currency: string | null;
  payment_channel: string | null;
  is_subscription_renewal: boolean;
  card: {
    type: string | null;
    brand: string | null;
    bank: string | null;
    country_code: string | null;
  } | null;
  checkout: {
    time_spent_seconds: number | null;
    attempts: number | null;
    errors: number | null;
    mobile: boolean | null;
    steps: { type: string | null; message: string | null; at_second: number | null }[];
  } | null;
};

export type StallForModel = {
  gateway_response: string | null;
  amount: number | null;
  currency: string | null;
  event_type: string;
  payload: unknown;
};

// Paystack status, abandoned_by, source and event_type are excluded on purpose:
// classification must rest on gateway_response, and event_type carries the
// status for polled rows ("transaction.abandoned").
export function buildModelInput(stall: StallForModel, gatewayResponse: string | null): ModelInput {
  const tx = transactionFromPayload(stall.payload);
  const auth = obj(tx.authorization);
  const log = obj(tx.log);
  const history = Array.isArray(log?.history) ? log.history : [];

  return {
    gateway_response: str(gatewayResponse ?? stall.gateway_response),
    amount_minor_units: num(stall.amount) ?? num(tx.amount),
    currency: str(stall.currency) ?? str(tx.currency),
    payment_channel: str(tx.channel),
    is_subscription_renewal: stall.event_type === "invoice.payment_failed",
    card: auth
      ? {
          type: str(auth.card_type),
          brand: str(auth.brand),
          bank: str(auth.bank),
          country_code: str(auth.country_code),
        }
      : null,
    checkout: log
      ? {
          time_spent_seconds: num(log.time_spent),
          attempts: num(log.attempts),
          errors: num(log.errors),
          mobile: bool(log.mobile),
          steps: history.slice(0, MAX_HISTORY_STEPS).map((h) => {
            const step = obj(h) ?? {};
            return { type: str(step.type), message: str(step.message), at_second: num(step.time) };
          }),
        }
      : null,
  };
}

// Identifiers the stall is known to carry. Used by the gate to catch leaks
// that no pattern would, such as a customer's name.
export function knownIdentifiers(stall: { customer_identifier: string | null; payload: unknown }): string[] {
  const tx = transactionFromPayload(stall.payload);
  const customer = obj(tx.customer) ?? {};
  const auth = obj(tx.authorization) ?? {};
  const values = [
    stall.customer_identifier,
    customer.email,
    customer.phone,
    customer.first_name,
    customer.last_name,
    customer.customer_code,
    customer.id,
    tx.ip_address,
    auth.authorization_code,
    auth.account_name,
    auth.signature,
  ];
  return values
    .map((v) => (typeof v === "number" ? String(v) : v))
    .filter((v): v is string => typeof v === "string" && v.trim().length >= 3)
    .map((v) => v.trim());
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class PiiLeakError extends Error {}

// Throws if any string in `input` still looks identifying. Never includes the
// offending value in the error, so the error itself can be logged safely.
export function assertNoPii(input: unknown, known: string[]): void {
  const strings = collectStrings(input);
  const patterns: [string, RegExp][] = [
    ["email", EMAIL],
    ["ip", IPV4],
    ["ip", IPV6],
    ["code", PAYSTACK_CODE],
    ["number", LONG_NUMBER],
  ];

  for (const s of strings) {
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(s)) {
        throw new PiiLeakError(`model input contains a ${kind}; refusing to send`);
      }
    }
    for (const value of known) {
      if (new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(value)}(?:$|[^a-z0-9])`, "i").test(s)) {
        throw new PiiLeakError("model input contains a known customer identifier; refusing to send");
      }
    }
  }
}
