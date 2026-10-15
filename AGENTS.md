<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Unstall pipeline rules

**Re-verify before every diagnosis or action. No exceptions.** Chasing a customer who has already paid is the worst failure this product can have.

- Before diagnosing a stall, and again immediately before executing any action, call `reverifyStall()` from `src/lib/reverify.ts`.
- If it returns `resolved`, stop. The stall is marked `resolved` and its pending or scheduled actions are cancelled automatically.
- If it throws, stop. Don't fall back to acting on stale data.
- Diagnosis and action code should take a `VerifiedStall`, which only `reverifyStall()` can produce.
- The database enforces this independently. Inserting a diagnosis or an action, or moving an action to `executing`, is refused unless the stall was verified in the last 10 minutes and isn't resolved.
- New actions default to `mode = 'dry_run'`. Nothing runs in `live` mode without explicit sign-off.
