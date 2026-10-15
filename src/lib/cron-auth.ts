import { createHash, timingSafeEqual } from "node:crypto";

const MIN_SECRET_LENGTH = 32;

// Fail-closed check of Vercel's `Authorization: Bearer <CRON_SECRET>` header.
// A missing or short CRON_SECRET rejects everything. Both sides are hashed
// first so the comparison is constant-time regardless of input length.
export function isAuthorizedCron(authHeader: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < MIN_SECRET_LENGTH) {
    console.error(`[cron-auth] CRON_SECRET missing or shorter than ${MIN_SECRET_LENGTH} chars; rejecting`);
    return false;
  }
  if (!authHeader?.startsWith("Bearer ")) return false;

  const given = createHash("sha256").update(authHeader.slice("Bearer ".length)).digest();
  const expected = createHash("sha256").update(secret).digest();
  return timingSafeEqual(given, expected);
}
