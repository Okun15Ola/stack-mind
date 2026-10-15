import { randomUUID } from "node:crypto";
import { listTransactions, paystackTestKey, stallFromTransaction, type StallRow } from "@/lib/paystack";
import { supabaseAdmin } from "@/lib/supabase-admin";

const POLLER_ID = "paystack_transactions";
const OVERLAP_MS = 5 * 60_000;
const INITIAL_LOOKBACK_MS = 24 * 60 * 60_000;
// Longer than the function can run, shorter than the 5-minute schedule.
const LEASE_MS = 2 * 60_000;
const UPSERT_CHUNK = 500;

export type PollResult =
  | { skipped: "locked" }
  | { from: string; to: string; fetched: number; stalls: number; inserted: number };

function abandonAfterMs(): number {
  const raw = process.env.ABANDON_AFTER_MINUTES;
  if (raw === undefined || raw === "") return 15 * 60_000;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes <= 0) {
    throw new Error(`ABANDON_AFTER_MINUTES must be a positive integer, got "${raw}"`);
  }
  return minutes * 60_000;
}

// One poll: list transactions initiated in [cursor - overlap, now - abandonAfter],
// upsert the stalls, then advance the cursor to the window's upper bound. Each
// transaction is therefore judged once it is old enough, and the overlap plus
// idempotent upserts cover clock skew and late indexing on Paystack's side.
export async function pollPaystack(now = new Date()): Promise<PollResult> {
  const secretKey = paystackTestKey();
  const abandonAfter = abandonAfterMs();
  const db = supabaseAdmin();
  const runId = randomUUID();

  // Lease lock: only one run at a time, and a crashed run frees it on expiry.
  const { data: lock, error: lockError } = await db
    .from("poller_state")
    .update({
      locked_until: new Date(now.getTime() + LEASE_MS).toISOString(),
      lock_holder: runId,
      last_run_at: now.toISOString(),
    })
    .eq("id", POLLER_ID)
    .or(`locked_until.is.null,locked_until.lt.${now.toISOString()}`)
    .select("cursor")
    .maybeSingle();
  if (lockError) throw new Error(`poller lock: ${lockError.message}`);
  if (!lock) return { skipped: "locked" };

  const release = (fields: Record<string, unknown>) =>
    db
      .from("poller_state")
      .update({ ...fields, locked_until: null, lock_holder: null })
      .eq("id", POLLER_ID)
      .eq("lock_holder", runId);

  try {
    const to = new Date(now.getTime() - abandonAfter);
    const from = lock.cursor
      ? new Date(new Date(lock.cursor).getTime() - OVERLAP_MS)
      : new Date(to.getTime() - INITIAL_LOOKBACK_MS);

    const transactions = from < to ? await listTransactions(secretKey, { from, to }) : [];

    const byReference = new Map<string, StallRow>();
    for (const tx of transactions) {
      const row = stallFromTransaction(tx, to);
      if (row) byReference.set(row.paystack_reference, row);
    }
    const rows = [...byReference.values()];

    // ignoreDuplicates: a stall already captured (by webhook or an earlier
    // poll) is left as is. The select returns only the newly inserted rows.
    let inserted = 0;
    for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
      const { data, error } = await db
        .from("stalls")
        .upsert(rows.slice(i, i + UPSERT_CHUNK), { onConflict: "paystack_reference", ignoreDuplicates: true })
        .select("paystack_reference");
      if (error) throw new Error(`stalls upsert: ${error.message}`);
      inserted += data?.length ?? 0;
    }

    const { error: saveError } = await release({
      cursor: to.toISOString(),
      last_success_at: now.toISOString(),
      last_error: null,
    });
    if (saveError) throw new Error(`poller cursor save: ${saveError.message}`);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      fetched: transactions.length,
      stalls: rows.length,
      inserted,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await release({ last_error: message.slice(0, 1000) });
    throw err;
  }
}
