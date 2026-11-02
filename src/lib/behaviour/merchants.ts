// Hard gate (migration 0006): the behaviour-trail join doesn't filter by
// merchant, because stalls carry no merchant id. That is only safe with one
// merchant. If more than one exists, the join refuses to run: a second
// merchant must break things loudly, never silently cross trails.
//
// Lift this only together with stalls.merchant_id and a merchant filter in
// the join.

export class MultipleMerchantsError extends Error {
  constructor(readonly count: number) {
    super(
      `refusing to join behaviour trails: ${count} merchants have emitter keys, but stalls carry no merchant id, so trails would cross merchants. Add stalls.merchant_id and filter the join by it first.`,
    );
    this.name = "MultipleMerchantsError";
  }
}

export function assertSingleMerchant(count: number): void {
  if (!Number.isInteger(count) || count < 0) throw new Error("merchant count is not a non-negative integer");
  if (count > 1) throw new MultipleMerchantsError(count);
}
