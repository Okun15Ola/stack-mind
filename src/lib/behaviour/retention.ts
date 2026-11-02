import { supabaseAdmin } from "@/lib/supabase-admin";

// Retention of behaviour events is 30 days, enforced by a pg_cron job inside
// the database (migration 0005), never by app code. This module only CHECKS
// that the job is running: a purge that hasn't run in more than 48 hours, or
// never ran, is a failure, surfaced loudly:
//   - the ingest endpoint refuses new events (we don't collect what we can't
//     delete), and
//   - the cron poll route returns an error, which fails the GitHub workflow.

export const PURGE_OVERDUE_HOURS = 48;

export type RetentionStatus = { lastPurge: Date | null; overdue: boolean; hoursSince: number | null };

export function retentionStatus(lastPurge: Date | null, now: Date): RetentionStatus {
  if (!lastPurge) return { lastPurge: null, overdue: true, hoursSince: null };
  const hoursSince = (now.getTime() - lastPurge.getTime()) / 3_600_000;
  return { lastPurge, overdue: hoursSince > PURGE_OVERDUE_HOURS, hoursSince: Math.round(hoursSince * 10) / 10 };
}

export interface RetentionCheck {
  lastPurge(): Promise<Date | null>;
}

export function supabaseRetentionCheck(): RetentionCheck {
  return {
    async lastPurge() {
      const { data, error } = await supabaseAdmin().rpc("behaviour_retention_status");
      if (error) throw new Error(`retention status: ${error.message}`);
      return typeof data === "string" ? new Date(data) : null;
    },
  };
}
