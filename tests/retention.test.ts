import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PURGE_OVERDUE_HOURS, retentionStatus } from "@/lib/behaviour/retention";
import { purgeCallViolations, readTree } from "./guards";

const NOW = new Date("2026-11-02T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

describe("retention status", () => {
  it("is overdue when the purge never ran", () => {
    assert.deepEqual(retentionStatus(null, NOW), { lastPurge: null, overdue: true, hoursSince: null });
  });

  it(`is overdue only past ${PURGE_OVERDUE_HOURS} hours`, () => {
    assert.equal(retentionStatus(hoursAgo(1), NOW).overdue, false);
    assert.equal(retentionStatus(hoursAgo(48), NOW).overdue, false);
    assert.equal(retentionStatus(hoursAgo(48.1), NOW).overdue, true);
    assert.equal(retentionStatus(hoursAgo(24 * 30), NOW).overdue, true);
  });
});

describe("the purge runs in pg_cron, never from app code", () => {
  it("no file in src/ or scripts/ calls purge_behaviour_events", () => {
    assert.deepEqual(purgeCallViolations(readTree("src", "scripts")), []);
  });
});
