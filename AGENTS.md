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
- **Two env vars choose the model, read in this order:**

  | `DIAGNOSIS_MODEL_PROVIDER` | `DIAGNOSIS_MODEL` | Result |
  | --- | --- | --- |
  | unset, empty or `none` | anything, or unset | **Rules only.** No model is called and no API key is read. A stall the rules can't classify stays undiagnosed. If `DIAGNOSIS_MODEL` is set, it is ignored and a warning is logged. |
  | `groq` (**the documented default**, the only provider with a key today) | unset | `openai/gpt-oss-120b`, checked against Groq's live model list before first use. If Groq has retired it, diagnosis throws and says to set `DIAGNOSIS_MODEL`. |
  | `groq` | a Groq model id | That model, checked the same way. A `claude-…` id throws. |
  | `anthropic` | unset | `claude-haiku-5-5` at low effort. |
  | `anthropic` | a `claude-…` id | That model (e.g. `claude-opus-5-5`). Anything that isn't a `claude-…` id throws. |
  | anything else | anything | Throws. |

  `DIAGNOSIS_MODEL_PROVIDER` decides *whether* a model is used and whose; `DIAGNOSIS_MODEL` only picks *which* model from that provider. "Documented default" means it's what `.env.example` sets: in code, an unset provider is still rules only.
- **Refusals are never silent.** Every refusal is logged with the stall id, the model that refused and its category, and returned on the diagnosis result. When no model answers, or replies stay unparseable after a retry, the stall is flagged in `stalls.diagnosis_blocked` and left undiagnosed.
  - Anthropic: Haiku has no server-side fallback, so a Haiku refusal is retried once on `claude-sonnet-5-5`; the other models use Anthropic's server-side fallback.
  - Groq: the API has no refusal signal, so **an unreadable reply is never recorded as a refusal.** A reply that isn't an answer in the schema (prose, empty, not a JSON object) is *unparseable*: it is retried once, and a second unparseable reply flags the stall as `model_unparseable: <model> (2 attempts)`, distinct from `model_refused: …`. Only an explicit `refusal` field counts as a refusal. There is no fallback model.
- **Record only what the provider told us.** Don't infer a refusal, an outage or any other cause the provider didn't report. That is the same mistake as reading Paystack's `abandoned` status as "the buyer left".
- **`diagnoses.model` names the model that actually produced the answer**, read from the API response, never the model that was requested. After a fallback it is the fallback model. If a response doesn't say which model answered, diagnosis throws rather than guess.
- **Nothing from `stalls.payload` reaches a prompt unredacted.** `buildModelInput()` copies an allowlist of fields, and `assertNoPii()` must pass before any model call. Never spread or serialise the payload into a prompt.
- **A gap in our data is never sent as a fact about the buyer.** When a section of model input can't be filled (no Paystack checkout log, no card details, behaviour trail not connected for the merchant), send `{ "available": false, "why": … }` saying so, never a bare `null`. A section Paystack sends empty, such as `authorization: {}` or an object whose fields are all null, is unavailable too, never "available" with nulls.
  - **Known tension, not yet acted on:** `card_details` is listed as a gap whenever Paystack sends no card details. For a payment that was never attempted, absent card details is the expected state rather than missing evidence. We chose honesty over cleverness: the code doesn't guess whether a card should exist. Revisit this once the behaviour trail lets the model tell "never attempted" from "attempted and we lost the record". Don't change it before then.
  - **Availability is decided in exactly one place:** `section()` in `src/lib/redact.ts`. A section is available only if at least one field has a value (not null, not undefined, not an empty array). Every section goes through it, including new ones. Never write `available: true` or `available: false` anywhere else: `tests/section-availability.test.ts` fails if you do. This rule exists because "available" meant "the key exists" twice (PR 9 for checkout, PR 13 for card).
  - `section()` lives in `redact.ts` for now, but availability is about the shape of the evidence, not about keeping PII out, which is `redact.ts`'s job. **It's a candidate for its own module if `redact.ts` keeps growing.** If you move it, move the `availability:begin/end` markers with it and update the path in `tests/section-availability.test.ts`. The system prompt tells the model unavailable data is not evidence either way. Real case: `T169809891137085`, where `checkout: null` was read as "no checkout activity, so the payment was likely never attempted".
- **The model may return `INSUFFICIENT_EVIDENCE` instead of guessing.** It is an outcome, not a reason (`OUTCOMES` vs `REASONS` in `src/lib/reasons.ts`). The gateway rules never return it, and the database refuses it on a `rules:` row.
  - **What would be needed is computed by code, never written by the model:** `evidenceGaps()` in `src/lib/evidence.ts` reads the input's `available: false` sections and is stored in `diagnoses.evidence_gaps`. The merchant sees `describeEvidenceNeeded()`.
  - **It maps to no action.** The database refuses to create an action on an `INSUFFICIENT_EVIDENCE` diagnosis.
  - **The metric** is the view `diagnosis_insufficient_evidence_rate`: the share of model diagnoses that couldn't be determined, split by whether the behaviour trail was available.
- **`diagnoses.confidence` means two different things in one column.** On a reason, it's the model's confidence that the reason is right. On `INSUFFICIENT_EVIDENCE`, it's the model's confidence that the evidence can't separate the reasons. The two numbers are not comparable: never compare, average or threshold them together.
  - **Never show a confidence figure to the merchant on `INSUFFICIENT_EVIDENCE`.** Show the outcome and the gaps only (`merchantView()` in `src/lib/evidence.ts`).
- **Requirements for the Mandate when it's built** (not before):
  - `INSUFFICIENT_EVIDENCE` maps to no remedy.
  - Every remedy has an owner-set minimum confidence, as a second line of defence behind `INSUFFICIENT_EVIDENCE`. Below it, no action.
  - **The confidence floor is NEVER applied to `INSUFFICIENT_EVIDENCE`.** An `INSUFFICIENT_EVIDENCE` at 0.85 would pass a 0.7 floor while meaning the opposite of what it looks like. The floor only ever compares against confidence in a reason.
- **Never add fields that carry the status** to model input: status, `abandoned_by`, `paystack_status`, `event_type`, `source`.

### Customer data

- **No customer PII in prompts, logs or error messages.** Use pseudonymous ids only (stall id, Paystack reference). Never print a buyer's email, phone, name, IP or card details.
- `src/lib/redact.ts` is the only thing between buyer data and a model prompt. Its checks fail closed; don't loosen them to make an input pass. Fix the input instead.

## Paystack safety

- **Never point the LIVE Paystack webhook URL at this app.** The live account's webhook serves ShopCart's production orders; repointing it would redirect them here. Webhook and poller work uses the test account only.
- **Test keys (`sk_test_…`) everywhere,** except the narrow read-only live-key staging path below. Going live for real needs Okunola's explicit sign-off.
- **A Paystack secret key is not read-only.** The same key that verifies a transaction can issue refunds and initiate transfers. "We don't call write endpoints" is not a control, so there is one:
  - **Every Paystack call goes through `paystackRequest()`** in `src/lib/paystack.ts`, which allows only the method and path pairs in `PAYSTACK_ALLOWLIST`. Today that's `GET /transaction` and `GET /transaction/verify/:reference`.
  - **Anything else is refused before a request is sent,** with an error that names the method and endpoint shape, never the key or customer data. Redirects are refused too.
  - **Never call Paystack another way:** no `fetch` to `api.paystack.co`, and no reading `PAYSTACK_SECRET_KEY` outside `paystack.ts`. `tests/paystack-allowlist.test.ts` fails if you do, and fails if the allowlist gains a non-GET entry.
  - **Add an allowlist entry only for a read endpoint Opada actually needs,** with a test, in its own PR.
- **Decision (2 November 2026): staging uses the LIVE Paystack account.** No ShopCart staging environment. Live `gateway_response` text is what the classifier is tuned on, and the poller already reads live transactions without a webhook. The constraints don't change:
  - the live webhook URL is never pointed at Opada (poller only);
  - dry-run is absolute, and no message reaches any real buyer.

- **A live Paystack key exists ONLY for staging on Okunola's own Paystack account, read-only.** It is not a path to going live, and not for any other merchant's account. `paystackKeyFor()` in `src/lib/paystack.ts` accepts `sk_live_…` only when **all** of these hold:
  1. **The entrypoint is one of `LIVE_KEY_ENTRYPOINTS`:** `poller`, `diagnose-stall`, `compare-models`, `export-test-set`. These only read from Paystack. **Never the webhook handler, and never anything that could send.** Adding an entrypoint to that list needs Okunola's sign-off.
  2. **`PAYSTACK_LIVE_READ_ONLY=true` is set explicitly.** The key alone is not enough.
  3. **`OPADA_DRY_RUN=true` is set explicitly.** With a live key and dry-run anything but explicitly on, the entrypoint refuses to start.
  - **Every live-key run logs** `[paystack] LIVE secret key in use by <entrypoint>`.
  - **Each entrypoint asks for the key once, at startup, under its own name,** and passes it down; library code never asks. `tests/guards.ts` checks every entrypoint uses its own name, as a string literal, and that nothing else asks. Negative fixtures prove that guard bites.
  - **The endpoint allowlist still applies:** even a live key can only reach the allowlisted GET endpoints.
  - **Why `diagnose-stall` is on the list:** the risk a live key carries is moving money or reaching a customer. `diagnose-stall` does neither: it writes only to Opada's own database, and the endpoint allowlist already limits a live key to two GET endpoints. Removing it would cost stored diagnoses on staging day with no reduction in real risk.
  - **An unset `OPADA_DRY_RUN` counts as off.** Only the exact value `true` counts as on. That's deliberate; keep it.
  - **The live key and both flags go in `.env.local` only, never in Vercel.** The only exception would be a deliberate decision that the deployed poller should read live. That is a separate decision, and **it has not been made.**

## Behaviour trail (issue #12)

- **The emitting apps send events; Opada only receives.** Opada never reads ShopCart's or PassMate's databases and pulls in none of their code. The contract is issue #12, and the emitter-side guide is `docs/behaviour-trail-integration.md`.
- **Opada must never hold a credential that can forge events.** Emitters sign with their own Ed25519 private key; `emitter_keys` stores only public keys (two per emitter, for rotation). Don't switch this to HMAC or any shared secret.
  - The signature covers `"<timestamp>.<raw body>"`, the raw bytes, and is verified before parsing.
  - **The ±300-second timestamp window is enforced.**
  - `event_id` is deduplicated per merchant.
  - Keys are generated with `npm run emitter-key` on the emitter's side. The private key is never sent to Opada.
- **Event `source` is set by Opada from the credential, never from the body.** It reaches the model input on every event. Client-sourced events are weak evidence and, per the Mandate requirements, never enough alone to trigger an action.
- **No free text anywhere in an event.** Unknown fields, properties and enum values are rejected, and errors never echo values.
- **The trail is forward-only.** A transaction joins only if `opada_buyer_ref` was in its Paystack metadata at creation. The join is on `session_ref`, else on `buyer_ref` from the buyer's last `checkout_started`.
- **Principle: if we cannot prove we are deleting, we stop collecting.** This holds for any data Opada keeps on a retention limit, not just behaviour events. Collection depends on deletion being demonstrably on schedule, not the other way round. A new store with a retention promise gets the same treatment: a recorded purge, an overdue check, and collection refused while it's overdue.
- **Retention is 30 days, and it's a privacy commitment.** `purge_behaviour_events()` runs **daily from pg_cron inside the database**, never from app code and never on the cron poller (GitHub Actions runs that far less often than scheduled, and disables it after 60 days of repo inactivity). `tests/guards.ts` fails if any app code calls the purge.
  - **Every run is recorded in `retention_runs`.** A purge that hasn't run in over 48 hours (or whose status can't be read) is a failure. The ingest endpoint refuses new events (`503 retention_overdue`), applying the principle above. Emitters must drop events on that status and never retry or queue them (`docs/behaviour-trail-integration.md`), or a stalled cron job becomes a retry storm. The cron poll route returns `500`, which fails the GitHub workflow.
- **What a forged event buys an attacker:** a polluted trail, so a wrong diagnosis and possibly a wrong message to a real buyer. Not money.

## Payment providers: direction, not yet built

Opada will integrate with three of Okunola's products:

- **PassMate and ShopCart**, both on the **same** Paystack account. One Paystack connection covers both.
- **finalyear.ng**, which runs on **Bachs**, not Paystack.

None of this is implemented, apart from the behaviour-trail ingest above. Don't pull in ShopCart, PassMate or finalyear.ng code, schema or types.

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
- **Paystack test keys only** (`sk_test_…`), apart from the read-only live-key staging path under "Paystack safety". Going live needs Okunola's explicit sign-off.
- **Guard tests require negative fixtures. A guard with no test proving it bites is not a guard.** A test that scans the code to forbid something (for example the Paystack bypass guard or the `section()` guard) must live in `tests/guards.ts` as a function, and must have fixtures in `tests/guard-fixtures.test.ts` that violate it and make it fail. Guards scan raw source text and don't strip comments: an earlier comment-stripper hid a URL-string bypass, which is exactly the failure these fixtures catch.
- **SQL is never run by code or tooling.** You have no database access. Add a numbered file under `supabase/migrations/` and say in the PR that it needs running. Okunola runs all SQL himself in the Supabase SQL editor.
