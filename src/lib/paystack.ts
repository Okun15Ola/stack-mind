import { createHmac, timingSafeEqual } from "node:crypto";

const PAYSTACK_API = "https://api.paystack.co";

// Returns the Paystack secret key, refusing anything that is not a test key.
// Live mode stays off until explicitly approved.
export function paystackTestKey(): string {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) throw new Error("PAYSTACK_SECRET_KEY is not set");
  if (!key.startsWith("sk_test_")) throw new Error("PAYSTACK_SECRET_KEY is not a test key; refusing");
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

async function paystackGet<T>(secretKey: string, path: string, params: Record<string, string> = {}): Promise<T> {
  const url = new URL(path, PAYSTACK_API);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${secretKey}` },
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: T } | null;
  if (!res.ok || body?.status !== true || body.data === undefined) {
    throw new Error(`Paystack GET ${url.pathname}: HTTP ${res.status} ${body?.message ?? "unexpected response"}`);
  }
  return body.data;
}

const PER_PAGE = 100;
const MAX_PAGES = 50;

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
    const data = await paystackGet<PaystackTransaction[]>(secretKey, "/transaction", { ...params, page: String(page) });
    if (!Array.isArray(data)) throw new Error("Paystack list transactions: data is not an array");
    all.push(...data);
    if (data.length < PER_PAGE) return all;
  }
  throw new Error(`Paystack list transactions: more than ${MAX_PAGES * PER_PAGE} results`);
}

export type VerifiedTransaction = PaystackTransaction & { customer?: PaystackCustomer & { id?: number | null } };

// Current state of one transaction. Throws on any error, including an unknown reference.
export function verifyTransaction(secretKey: string, reference: string): Promise<VerifiedTransaction> {
  return paystackGet<VerifiedTransaction>(secretKey, `/transaction/verify/${encodeURIComponent(reference)}`);
}
