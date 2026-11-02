// Builds the only view of a stall that may reach a model, and refuses to send
// it if anything identifying slips through. With no gateway in front of the
// model provider, this module is the only thing keeping buyer PII out of
// prompts, so every check here fails closed.
//
// Two layers, both required:
//   1. Allowlist: buildModelInput() copies named, non-identifying fields into a
//      new object. The payload is never spread or serialised wholesale.
//   2. Gate: assertNoPii() walks every key and value of that object and
//      throws on email, phone (Nigerian formats included), card PAN, IP,
//      Paystack codes, any other long number, and the stall's own known
//      identifiers (email, phone, names, codes, reference, ids). It also
//      throws on anything it cannot inspect. Any throw means the model is not
//      called.
// Free text inside allowed fields is scrubbed on the way in as well.
//
// No PII value is ever put into an error message: PiiLeakError carries only
// the kind of leak and the field path, so it is safe to log.

// Separators people put between digits: spaces (incl. NBSP), dots, dashes of
// every width, slashes, underscores, brackets.
const SEP = "[\\s.()\\-\u2010-\u2015\u2212/_]";

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}\b/gi;
// Compressed IPv6 ("2001:db8::1", "fe80::1", "::1").
const IPV6_COMPRESSED = /(?<![0-9a-z:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4})*)?(?![0-9a-z:])/gi;
// Nigerian mobile numbers: 0803..., 803..., +234803..., 234803..., +234 (0) 803...,
// with any separators. Mobile prefixes are 70x, 80x, 81x, 90x, 91x.
const NG_PHONE = new RegExp(
  `(?<!\\d)(?:(?:\\+|00)?234${SEP}*(?:\\(0\\)${SEP}*|0${SEP}*)?|0${SEP}*)?[789][01]\\d(?:${SEP}*\\d){7}(?!\\d)`,
  "g",
);
// Card PANs: 13 to 19 digits with optional separators (checked with Luhn).
const CARD_CANDIDATE = new RegExp(`(?<!\\d)\\d(?:${SEP}?\\d){12,18}(?!\\d)`, "g");
// Phone, card and account numbers: 8+ digits, allowing separators.
const LONG_NUMBER = new RegExp(`\\+?\\d(?:${SEP}*\\d){7,}`, "g");
const PAYSTACK_CODE = /(?<![a-z0-9])(?:CUS|AUTH|PLN|SUB|ACCT|TRF|RCP|SPL)_[a-z0-9]+/gi;

// Folds look-alike characters (full-width digits, full-width @) to ASCII and
// drops invisible format characters, so "0803\u200b123..." can't slip past.
function normalise(text: string): string {
  return text.normalize("NFKC").replace(/\p{Cf}/gu, "");
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function scrubText(text: string): string {
  return normalise(text)
    .replace(EMAIL, "[email]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, "[ip]")
    .replace(IPV6_COMPRESSED, (m) => (/[0-9a-f]/i.test(m) ? "[ip]" : m))
    .replace(PAYSTACK_CODE, "[code]")
    .replace(NG_PHONE, "[phone]")
    .replace(CARD_CANDIDATE, (m) => (luhn(m.replace(/\D/g, "")) ? "[card]" : m))
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
// that no pattern would, such as a customer's name, plus the stall's own
// identifiers (its id, Paystack reference and transaction id).
export function knownIdentifiers(stall: {
  id?: string | null;
  customer_identifier: string | null;
  payload: unknown;
}): string[] {
  const tx = transactionFromPayload(stall.payload);
  const customer = obj(tx.customer) ?? {};
  const auth = obj(tx.authorization) ?? {};
  const metadata = obj(tx.metadata) ?? {};
  const first = typeof customer.first_name === "string" ? customer.first_name.trim() : "";
  const last = typeof customer.last_name === "string" ? customer.last_name.trim() : "";
  const values = [
    stall.id,
    stall.customer_identifier,
    tx.id,
    tx.reference,
    customer.email,
    customer.phone,
    customer.first_name,
    customer.last_name,
    first && last ? `${first} ${last}` : null,
    customer.customer_code,
    customer.id,
    tx.ip_address,
    auth.authorization_code,
    auth.account_name,
    auth.signature,
    auth.bin,
    auth.last4,
    metadata.full_name,
    metadata.name,
    metadata.email,
    metadata.phone,
  ];
  return [
    ...new Set(
      values
        .map((v) => (typeof v === "number" ? String(v) : v))
        .filter((v): v is string => typeof v === "string" && v.trim().length >= 3)
        .map((v) => v.trim()),
    ),
  ];
}

export type PiiKind = "email" | "phone" | "card" | "ip" | "code" | "number" | "identifier" | "uninspectable";

// Safe to log: carries the kind of leak and where it was found, never the value.
export class PiiLeakError extends Error {
  readonly kind: PiiKind;
  readonly path: string;
  constructor(kind: PiiKind, path: string) {
    super(
      kind === "uninspectable"
        ? `model input has a value at ${path} the PII gate cannot inspect; refusing to send`
        : `model input contains ${kind === "identifier" ? "a known customer identifier" : `a ${kind}`} at ${path}; refusing to send`,
    );
    this.name = "PiiLeakError";
    this.kind = kind;
    this.path = path;
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const digitsOnly = (s: string) => s.replace(/\D/g, "");

type Matcher = { kind: PiiKind; test: (text: string) => boolean };

const once = (re: RegExp) => new RegExp(re.source, re.flags.replace("g", ""));
const anyMatch = (re: RegExp, accept: (m: string) => boolean = () => true) => (text: string) => {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of text.matchAll(g)) if (accept(m[0])) return true;
  return false;
};

const PATTERN_MATCHERS: Matcher[] = [
  { kind: "email", test: (t) => once(EMAIL).test(t) },
  { kind: "ip", test: (t) => once(IPV4).test(t) || once(IPV6).test(t) },
  { kind: "ip", test: anyMatch(IPV6_COMPRESSED, (m) => /[0-9a-f]/i.test(m)) },
  { kind: "code", test: (t) => once(PAYSTACK_CODE).test(t) },
  { kind: "phone", test: (t) => once(NG_PHONE).test(t) },
  { kind: "card", test: anyMatch(CARD_CANDIDATE, (m) => luhn(digitsOnly(m))) },
  { kind: "number", test: (t) => once(LONG_NUMBER).test(t) },
];

function identifierMatchers(known: string[]): Matcher[] {
  return known.map((raw) => {
    const value = normalise(raw).trim();
    const literal = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}])`, "iu");
    const digits = digitsOnly(value);
    // Mostly-numeric identifiers (ids, phones) are also matched with
    // separators stripped, and phones by their last ten digits, so
    // "+2348012345678" is still caught when written as "0801-234-5678".
    const numeric = digits.length >= 6 && digits.length >= value.replace(/[\s+()-]/g, "").length - 1;
    const tail = numeric && digits.length >= 10 ? digits.slice(-10) : digits;
    return {
      kind: "identifier" as const,
      test: (text: string) => {
        if (literal.test(text)) return true;
        if (!numeric) return false;
        return text
          .split(/[^\d\s.()\-\u2010-\u2015\u2212/_+]+/)
          .map(digitsOnly)
          .some((run) => run.includes(tail));
      },
    };
  });
}

// Throws PiiLeakError if anything in `input` still looks identifying, or if
// the gate cannot inspect it. Fails closed: keys are checked as well as
// values, numbers are checked against known identifiers, and any value type
// other than string, number, boolean, null, array or plain object is refused.
// Never includes the offending value in the error, so the error is safe to log.
export function assertNoPii(input: unknown, known: string[]): void {
  if (!Array.isArray(known) || known.some((k) => typeof k !== "string")) {
    throw new PiiLeakError("uninspectable", "known identifiers");
  }
  // Known identifiers first: the most specific explanation is the most useful.
  const matchers = [...identifierMatchers(known.filter((k) => k.trim().length >= 3)), ...PATTERN_MATCHERS];
  const identifiers = matchers.filter((m) => m.kind === "identifier");
  const seen = new Set<object>();

  const checkText = (text: string, path: string, which: Matcher[]) => {
    const t = normalise(text);
    for (const m of which) if (m.test(t)) throw new PiiLeakError(m.kind, path);
  };

  const walk = (value: unknown, path: string): void => {
    if (value === null || value === undefined || typeof value === "boolean") return;
    if (typeof value === "string") return checkText(value, path, matchers);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new PiiLeakError("uninspectable", path);
      // Amounts and durations are legitimately long numbers, so numbers are
      // only matched against this stall's identifiers (e.g. a customer id).
      return checkText(String(value), path, identifiers);
    }
    if (typeof value !== "object") throw new PiiLeakError("uninspectable", path);
    if (seen.has(value)) throw new PiiLeakError("uninspectable", path);
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new PiiLeakError("uninspectable", path);
    if (Object.getOwnPropertySymbols(value).length) throw new PiiLeakError("uninspectable", path);
    for (const [key, v] of Object.entries(value)) {
      // A leak in a key is reported at the parent, so the path stays safe.
      checkText(key, `a key of ${path}`, matchers);
      walk(v, `${path}.${key}`);
    }
  };

  walk(input, "input");
}
