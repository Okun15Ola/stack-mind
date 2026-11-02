import { createHmac, timingSafeEqual } from "node:crypto";

// --- Which key, for which entrypoint -----------------------------------------
//
// A test key (sk_test_) works everywhere. A LIVE key (sk_live_) exists only
// for staging on Okunola's own Paystack account, read-only, and is accepted
// only when ALL of these hold:
//   1. the entrypoint is one of LIVE_KEY_ENTRYPOINTS, the named read-only
//      scripts. Never the webhook handler, never anything that could send;
//   2. PAYSTACK_LIVE_READ_ONLY=true is set explicitly (the key alone is not
//      enough);
//   3. OPADA_DRY_RUN=true is set explicitly. With a live key and dry-run
//      anything but explicitly on, the entrypoint refuses to start.
// Every live-key run logs that it used a live key, with the entrypoint name.
// The endpoint allowlist (paystackRequest) still limits every call to reads.
//
// Each entrypoint asks for the key once, at startup, under its own name, and
// passes the key down. tests/guards.ts checks each file names itself
// correctly. This is the only place the key is read from the environment.

export const LIVE_KEY_ENTRYPOINTS = ["poller", "diagnose-stall", "compare-models", "export-test-set"] as const;
export type PaystackEntrypoint = (typeof LIVE_KEY_ENTRYPOINTS)[number] | "webhook";

export const LIVE_KEY_FLAG = "PAYSTACK_LIVE_READ_ONLY";
export const DRY_RUN_FLAG = "OPADA_DRY_RUN";

// Never carries the key.
export class PaystackKeyRefusedError extends Error {
  constructor(entrypoint: string, why: string) {
    super(`Paystack key refused for ${entrypoint}: ${why}`);
    this.name = "PaystackKeyRefusedError";
  }
}

export function paystackKeyFor(
  entrypoint: PaystackEntrypoint,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = (line) => console.warn(line),
): string {
  const key = env.PAYSTACK_SECRET_KEY?.trim();
  if (!key) throw new PaystackKeyRefusedError(entrypoint, "PAYSTACK_SECRET_KEY is not set");
  if (key.startsWith("sk_test_")) return key;
  if (!key.startsWith("sk_live_")) throw new PaystackKeyRefusedError(entrypoint, "PAYSTACK_SECRET_KEY is neither a test nor a live secret key");

  if (!(LIVE_KEY_ENTRYPOINTS as readonly string[]).includes(entrypoint)) {
    throw new PaystackKeyRefusedError(entrypoint, `a live key is only accepted by the read-only entrypoints (${LIVE_KEY_ENTRYPOINTS.join(", ")})`);
  }
  if (env[LIVE_KEY_FLAG] !== "true") {
    throw new PaystackKeyRefusedError(entrypoint, `a live key needs ${LIVE_KEY_FLAG}=true set explicitly`);
  }
  if (env[DRY_RUN_FLAG] !== "true") {
    throw new PaystackKeyRefusedError(entrypoint, `refusing to start: live key present and ${DRY_RUN_FLAG} is not explicitly true`);
  }
  log(`[paystack] LIVE secret key in use by ${entrypoint} (read-only staging on Okunola's account, dry-run)`);
  return key;
}

// Paystack signs each webhook with HMAC-SHA512 of the raw request body, keyed
// with the account secret key, hex-encoded in the `x-paystack-signature` header.
// https://paystack.com/docs/payments/webhooks/
export function verifyPaystackSignature(
  rawBody: string,
  signature: string | null,
  secretKey: string,
): boolean {
  if (!signature) return false;

  const expected = createHmac("sha512", secretKey).update(rawBody, "utf8").digest();
  const received = Buffer.from(signature, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(expected, received);
}

// Webhook events that represent a stalled payment. Everything else is acknowledged and dropped.
//
// - charge.failed: not in Paystack's published event list, but is sent for
//   declined charges (e.g. test decline cards).
// - invoice.payment_failed: a subscription renewal charge that failed.
//
// Paystack sends no webhook for abandoned transactions; the poller catches those.
export const STALL_EVENTS = new Set(["charge.failed", "invoice.payment_failed"]);

type PaystackCustomer = { email?: string | null; customer_code?: string | null };

export type PaystackTransaction = {
  reference?: string | null;
  amount?: number | null;
  currency?: string | null;
  status?: string | null;
  gateway_response?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  transaction_date?: string | null;
  customer?: PaystackCustomer | null;
  transaction?: { reference?: string | null } | null;
  [key: string]: unknown;
};

export type PaystackEvent = { event: string; data?: PaystackTransaction };

export type StallSource = "webhook" | "poll";
export type AbandonedBy = "paystack" | "unstall" | null;

export type StallRow = {
  paystack_reference: string;
  event_type: string;
  source: StallSource;
  paystack_status: string | null;
  abandoned_by: AbandonedBy;
  amount: number | null;
  currency: string | null;
  customer_identifier: string | null;
  gateway_response: string | null;
  error_code: string | null;
  stalled_at: string;
  payload: unknown;
};

function initiatedAt(tx: PaystackTransaction): Date | null {
  const raw = tx.created_at ?? tx.createdAt ?? tx.transaction_date ?? null;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function baseRow(tx: PaystackTransaction) {
  const errorCode = tx.error_code ?? tx.code ?? null;
  return {
    paystack_status: tx.status ?? null,
    amount: typeof tx.amount === "number" ? tx.amount : null,
    currency: tx.currency ?? null,
    customer_identifier: tx.customer?.email ?? tx.customer?.customer_code ?? null,
    gateway_response: tx.gateway_response ?? null,
    error_code: errorCode == null ? null : String(errorCode),
  };
}

// Maps a webhook event to a stalls row. Returns null if there is no reference
// to key on, since idempotency depends on it.
export function stallFromEvent(evt: PaystackEvent): StallRow | null {
  const d = evt.data ?? {};
  const reference = d.reference ?? d.transaction?.reference ?? null;
  if (!reference) return null;

  return {
    ...baseRow(d),
    paystack_reference: reference,
    event_type: evt.event,
    source: "webhook",
    abandoned_by: d.status === "abandoned" ? "paystack" : null,
    stalled_at: (initiatedAt(d) ?? new Date()).toISOString(),
    payload: evt,
  };
}

// Statuses that mean the money moved; never a stall. `reversed` was paid and
// later refunded or charged back, which is not a stalled payment.
export const SETTLED_STATUSES = new Set(["success", "reversed"]);

// Maps a polled transaction to a stalls row, or null if it is not a stall:
// settled, missing a reference, or initiated after `cutoff` (too young to call).
export function stallFromTransaction(tx: PaystackTransaction, cutoff: Date): StallRow | null {
  const status = tx.status ?? null;
  const started = initiatedAt(tx);
  if (!tx.reference || !status || !started) return null;
  if (SETTLED_STATUSES.has(status)) return null;
  if (started > cutoff) return null;

  // failed: an explicit failure. abandoned: Paystack's call. Anything else
  // (ongoing, pending, processing, queued, ...) is still open past the
  // threshold, so we are the ones calling it abandoned.
  const abandonedBy: AbandonedBy =
    status === "failed" ? null : status === "abandoned" ? "paystack" : "unstall";

  return {
    ...baseRow(tx),
    paystack_reference: tx.reference,
    event_type: `transaction.${status}`,
    source: "poll",
    abandoned_by: abandonedBy,
    stalled_at: started.toISOString(),
    payload: tx,
  };
}

// paystack-http:begin
// Every Paystack API call goes through paystackRequest(), and only to an
// endpoint on this allowlist.
//
// Why: a Paystack secret key is not read-only. The same key that verifies a
// transaction can issue refunds and initiate transfers. "We don't call write
// endpoints" is not a control, so this is: anything not listed is refused
// before a request is sent. Opada only ever reads.
//
// Add an entry only for a read endpoint Opada actually needs, with a test.
// tests/paystack-allowlist.test.ts fails if anything calls Paystack without
// going through here.
const PAYSTACK_HOST = "api.paystack.co";

export const PAYSTACK_ALLOWLIST: readonly { method: "GET"; path: RegExp; name: string }[] = [
  { method: "GET", path: /^\/transaction$/, name: "list transactions" },
  { method: "GET", path: /^\/transaction\/verify\/[^/]+$/, name: "verify transaction" },
];

// Thrown before any request is sent. Names the method and the shape of the
// path only: dynamic segments become ":param", and the query string, the key
// and any customer data never appear.
export class PaystackEndpointBlockedError extends Error {
  constructor(
    readonly method: string,
    readonly endpoint: string,
  ) {
    super(`Paystack call blocked: ${method} ${endpoint} is not on the endpoint allowlist (src/lib/paystack.ts)`);
    this.name = "PaystackEndpointBlockedError";
  }
}

export class PaystackHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PaystackHttpError";
  }
}

// "/customer/a@b.co" -> "/customer/:param". Only plain lowercase words survive.
export function endpointShape(path: string): string {
  return (
    path
      .split("?")[0]
      .split("/")
      .map((seg, i) => (i === 0 || /^[a-z_]+$/.test(seg) ? seg : ":param"))
      .join("/") || "/"
  );
}

function allowed(method: string, path: string): boolean {
  return PAYSTACK_ALLOWLIST.some((e) => e.method === method && e.path.test(path));
}

export async function paystackRequest<T>(
  secretKey: string,
  method: string,
  path: string,
  params: Record<string, string> = {},
): Promise<T> {
  const verb = method.toUpperCase();
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("..") || path.includes("?") || path.includes("#")) {
    throw new PaystackEndpointBlockedError(verb, endpointShape(String(path)));
  }
  if (!allowed(verb, path)) throw new PaystackEndpointBlockedError(verb, endpointShape(path));

  const url = new URL(path, `https://${PAYSTACK_HOST}`);
  if (url.host !== PAYSTACK_HOST || url.protocol !== "https:") {
    throw new PaystackEndpointBlockedError(verb, endpointShape(path));
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    method: verb,
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
    // A redirect could land on an endpoint that isn't on the allowlist.
    redirect: "error",
  });
  const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || body?.status !== true || body.data === undefined) {
    throw new PaystackHttpError(res.status, `Paystack ${verb} ${endpointShape(path)}: HTTP ${res.status} ${body?.message ?? "unexpected response"}`);
  }
  return body.data;
}
// paystack-http:end

const PER_PAGE = 100;
const MAX_PAGES = 50;

// One page of GET /transaction. params are Paystack's query parameters.
export async function listTransactionsPage(secretKey: string, params: Record<string, string>): Promise<PaystackTransaction[]> {
  const data = await paystackRequest<PaystackTransaction[]>(secretKey, "GET", "/transaction", params);
  if (!Array.isArray(data)) throw new Error("Paystack list transactions: data is not an array");
  return data;
}

export type ListFilter = { from: Date; to?: Date; status?: string; customer?: number };

// Lists every matching transaction. Throws rather than returning a partial
// list, so callers never act on, or advance a cursor past, data they did not see.
export async function listTransactions(secretKey: string, filter: ListFilter): Promise<PaystackTransaction[]> {
  const params: Record<string, string> = { from: filter.from.toISOString(), perPage: String(PER_PAGE) };
  if (filter.to) params.to = filter.to.toISOString();
  if (filter.status) params.status = filter.status;
  if (filter.customer !== undefined) params.customer = String(filter.customer);

  const all: PaystackTransaction[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await listTransactionsPage(secretKey, { ...params, page: String(page) });
    all.push(...data);
    if (data.length < PER_PAGE) return all;
  }
  throw new Error(`Paystack list transactions: more than ${MAX_PAGES * PER_PAGE} results`);
}

export type VerifiedTransaction = PaystackTransaction & { customer?: PaystackCustomer & { id?: number | null } };

// Current state of one transaction. Throws on any error, including an unknown reference.
export function verifyTransaction(secretKey: string, reference: string): Promise<VerifiedTransaction> {
  return paystackRequest<VerifiedTransaction>(secretKey, "GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}
