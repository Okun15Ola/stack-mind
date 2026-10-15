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

## Contributing

**Never push to `main`.** Branch protection rejects direct pushes, and that's intended. Every change goes through a pull request that the repo owner reviews and merges.

1. Branch off the latest `main` with a descriptive name: `feat/…`, `fix/…`, `docs/…` or `chore/…` (e.g. `feat/diagnose-stub`, `fix/poller-window`).
2. Commit and push that branch.
3. Open a pull request against `main` (`gh pr create --base main`). In the body, cover:
   - what changed;
   - why;
   - anything the reviewer must check or do by hand: SQL to run, env vars to set, dashboard settings.
4. Don't merge your own PR. The owner reviews and merges.

If something seems to need a direct change to `main`, stop and ask the owner first, with the reason.

Ground rules that apply to every PR:

- **No secrets in the repo.** Keys live only in Vercel, GitHub Actions secrets and your local `.env.local`, which is gitignored. `.env.example` has names only.
- **Paystack test keys only** (`sk_test_…`). The code refuses anything else. Going live needs explicit owner sign-off.
- **SQL is never run by code or tooling.** Add a numbered file under `supabase/migrations/` and say in the PR that it needs running. The owner runs it in the Supabase SQL editor.
