// One-off export of failed and abandoned Paystack transactions as an
// anonymised local JSON test set for the diagnosis layer.
//
//   npm run export:test-set -- [--from 2025-01-01] [--out exports/test-set.json]
//
// Reads PAYSTACK_SECRET_KEY from .env.local (test keys only). Writes one local
// file under exports/ (gitignored). Touches no database.
//
// Each record keeps only: status, amount, currency, gateway_response,
// initiated_at, a pseudonymous customer_key, and customer_paid_before. Names,
// emails, phone numbers, references, metadata, IPs and card details are never
// copied. customer_key is an HMAC under a random per-run salt that is never
// saved: records from the same customer share a key within this file, but the
// key cannot be traced back to the customer.

import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

type Tx = {
  status?: string | null;
  amount?: number | null;
  currency?: string | null;
  gateway_response?: string | null;
  created_at?: string | null;
  createdAt?: string | null;
  customer?: { id?: number | null; customer_code?: string | null } | null;
};

const KEEP_STATUSES = new Set(["failed", "abandoned"]);
const PER_PAGE = 100;
const PAGE_DELAY_MS = 250;
const MAX_RETRIES = 5;

const { values: args } = parseArgs({
  options: {
    from: { type: "string" },
    out: { type: "string" },
  },
});

const key = process.env.PAYSTACK_SECRET_KEY;
if (!key) fail("PAYSTACK_SECRET_KEY is not set (expected in .env.local)");
if (!key.startsWith("sk_test_")) fail("PAYSTACK_SECRET_KEY is not a test key; refusing");

const from = args.from ? new Date(args.from) : null;
if (from && Number.isNaN(from.getTime())) fail(`--from is not a valid date: ${args.from}`);

const today = new Date().toISOString().slice(0, 10);
const outPath = resolve(args.out ?? `exports/paystack-test-set-${today}.json`);

function fail(message: string): never {
  console.error(`export-test-set: ${message}`);
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(page: number): Promise<Tx[]> {
  const url = new URL("https://api.paystack.co/transaction");
  url.searchParams.set("perPage", String(PER_PAGE));
  url.searchParams.set("page", String(page));
  if (from) url.searchParams.set("from", from.toISOString());

  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(30_000),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const body = (await res.json().catch(() => null)) as { status?: boolean; message?: string; data?: Tx[] } | null;
    if (!res.ok || body?.status !== true || !Array.isArray(body.data)) {
      fail(`page ${page}: HTTP ${res.status} ${body?.message ?? "unexpected response"}`);
    }
    return body.data;
  }
}

const initiatedAt = (t: Tx) => {
  const d = new Date(t.created_at ?? t.createdAt ?? "");
  return Number.isNaN(d.getTime()) ? null : d;
};

const customerId = (t: Tx) =>
  t.customer?.id != null ? `id:${t.customer.id}` : t.customer?.customer_code ? `code:${t.customer.customer_code}` : null;

// Defensive: gateway responses are processor text, but scrub anything that
// looks like an email address or phone number before it leaves this machine.
function scrub(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "[redacted-email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, "[redacted-number]");
}

const all: Tx[] = [];
for (let page = 1; ; page++) {
  const data = await fetchPage(page);
  all.push(...data);
  process.stdout.write(`\rfetched ${all.length} transactions`);
  if (data.length < PER_PAGE) break;
  await sleep(PAGE_DELAY_MS);
}
process.stdout.write("\n");

// Earliest successful payment per customer, to answer "had they paid before?".
const firstSuccess = new Map<string, number>();
for (const t of all) {
  const c = customerId(t);
  const at = initiatedAt(t);
  if (t.status !== "success" || !c || !at) continue;
  const prev = firstSuccess.get(c);
  if (prev === undefined || at.getTime() < prev) firstSuccess.set(c, at.getTime());
}

const salt = randomBytes(32);
const pseudonym = (c: string) => createHmac("sha256", salt).update(c).digest("hex").slice(0, 16);

const records = all
  .filter((t) => t.status && KEEP_STATUSES.has(t.status))
  .map((t) => {
    const c = customerId(t);
    const at = initiatedAt(t);
    const first = c ? firstSuccess.get(c) : undefined;
    return {
      status: t.status,
      amount: typeof t.amount === "number" ? t.amount : null,
      currency: t.currency ?? null,
      gateway_response: scrub(t.gateway_response),
      initiated_at: at?.toISOString() ?? null,
      customer_key: c ? pseudonym(c) : null,
      customer_paid_before: first !== undefined && at !== null && first < at.getTime(),
    };
  })
  .sort((a, b) => (a.initiated_at ?? "").localeCompare(b.initiated_at ?? ""));

const output = {
  generated_at: new Date().toISOString(),
  paystack_mode: "test",
  history_from: from?.toISOString() ?? "all",
  notes: [
    "amount is in currency subunits (kobo, pesewas, cents).",
    "customer_paid_before considers only the history fetched in this export.",
    "customer_key is stable within this file only.",
  ],
  counts: {
    transactions_scanned: all.length,
    failed: records.filter((r) => r.status === "failed").length,
    abandoned: records.filter((r) => r.status === "abandoned").length,
  },
  records,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.log(`wrote ${records.length} records to ${outPath}`);
