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
- New actions default to `mode = 'dry_run'`. Nothing runs in `live` mode, and no message reaches a real buyer, without Okunola's explicit sign-off.

### Diagnosis (`src/lib/diagnose.ts`)

- **Classify on `gateway_response`, never on status or `abandoned_by`.** Paystack stores some declined cards as `abandoned` (real case `yi8ijvdw7mjns54`). Going by status, that reads as FORGOT when it's CARD_FAILING.
- **Don't build on `error_code`.** Paystack puts no code on the transaction, so the column stays empty.
- **Known gateway strings are classified by rules** in `src/lib/gateway-rules.ts`, with no model call. Add a rule only for unambiguous text, and add a test case with it.
- **Model calls go through `DiagnosisModel`** in `src/lib/diagnosis-model.ts`. Swap providers there; the classifier doesn't change.
- **Nothing from `stalls.payload` reaches a prompt unredacted.** `buildModelInput()` copies an allowlist of fields, and `assertNoPii()` must pass before any model call. Never spread or serialise the payload into a prompt.
- **Never add fields that carry the status** to model input: status, `abandoned_by`, `paystack_status`, `event_type`, `source`.

### Customer data

- **No customer PII in prompts, logs or error messages.** Use pseudonymous ids only (stall id, Paystack reference). Never print a buyer's email, phone, name, IP or card details.
- `src/lib/redact.ts` is the only thing between buyer data and a model prompt. Its checks fail closed; don't loosen them to make an input pass. Fix the input instead.

## Paystack safety

- **Never point the LIVE Paystack webhook URL at this app.** The live account's webhook serves ShopCart's production orders; repointing it would redirect them here. Webhook and poller work uses the test account only.
- **Test keys only** (`sk_test_…`) until Okunola approves live. The code refuses anything else.

## Payment providers: direction, not yet built

Opada will integrate with three of Okunola's products:

- **PassMate and ShopCart**, both on the **same** Paystack account. One Paystack connection covers both.
- **finalyear.ng**, which runs on **Bachs**, not Paystack.

None of this is implemented. Don't pull in ShopCart, PassMate or finalyear.ng code, schema or types until the architecture is decided.

The decision so far:

- A later PR introduces a **`PaymentProvider` seam**, the same shape as `DiagnosisModel`: one interface covering *list stalls*, *verify a reference*, and *return the raw failure reason*. Paystack implements it. Bachs implements it only if and when finalyear.ng is in scope.
- **Don't genericise anything beyond that interface.** `src/lib/gateway-rules.ts` stays Paystack-specific and keeps its name. Bachs, if it happens, gets its own rules file with its own strings.
- **The abandoned-vs-failed finding is Paystack behaviour.** Don't assume another provider mislabels declines the same way, or that its failure text means what Paystack's does.

## Contributing

**Never push to `main`.** Branch protection rejects direct pushes, and that's intended. Every change goes through a pull request that Okunola reviews and merges.

1. Branch off the latest `main` with a descriptive name: `feat/…`, `fix/…`, `docs/…` or `chore/…` (e.g. `feat/diagnose-stub`, `fix/poller-window`).
2. Commit and push that branch.
3. Open a pull request against `main` (`gh pr create --base main`). In the body, cover:
   - what changed;
   - why;
   - anything the reviewer must check or do by hand: SQL to run, env vars to set, dashboard settings.
4. Don't merge your own PR. Okunola reviews and merges.

If something seems to need a direct change to `main`, stop and ask Okunola first, with the reason.

Ground rules that apply to every PR:

- **No secrets in the repo.** Keys live only in Vercel, GitHub Actions secrets and your local `.env.local`, which is gitignored. `.env.example` has names only.
- **Paystack test keys only** (`sk_test_…`). The code refuses anything else. Going live needs Okunola's explicit sign-off.
- **SQL is never run by code or tooling.** You have no database access. Add a numbered file under `supabase/migrations/` and say in the PR that it needs running. Okunola runs all SQL himself in the Supabase SQL editor.
