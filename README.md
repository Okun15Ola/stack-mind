# Opada

*Opada* (Yoruba, *ó padà*: "it came back"). The agent inside it is called **Kemi**.

Opada sits between a merchant's checkout and their payment gateway. It watches every customer who tries to pay and doesn't, works out why, and acts on it within limits the business owner sets.

What Opada is, what Kemi does and what it promises merchants is in **[`docs/brief.md`](docs/brief.md)**, the source of truth for the product. Engineering rules are in [`AGENTS.md`](AGENTS.md).

## How it works

Four stages, in order:

1. **Ingest.** Catch every signal that money stopped moving: Paystack webhooks, plus a polling sweep of the Transactions API, because webhooks alone are not reliable. Declined cards have arrived with no webhook at all.
2. **Diagnose.** Work out *why* the payment stalled, into one of six reasons (`src/lib/reasons.ts`). Known Paystack failure strings are classified by rule (`src/lib/gateway-rules.ts`). Everything else goes to a model, as a redacted view of the transaction with no customer identity.
3. **Mandate.** Look up whether the remedy for that reason is permitted. The owner writes the Mandate; Kemi never does. *(Not built yet.)*
4. **Act.** Carry out the permitted remedy, after re-verifying against Paystack immediately beforehand. Nobody is chased for money they have already paid. *(Dry-run only for now.)*

> **Kemi decides why. She never decides what she is allowed to do.**

Diagnosis is probabilistic. Every diagnosis carries a confidence score, and thin evidence means low confidence. Action selection is not: it is a deterministic lookup of the diagnosed reason against the Mandate. So a model that invents a wrong reason still cannot take an action the owner has not authorised.

## Why classify on `gateway_response`

Paystack stores some declined cards as `abandoned`. A merchant reading that status would conclude the customer wandered off, when the card actually failed. The true reason is in `gateway_response`. Opada classifies on that field and never on status. This is Paystack behaviour; other gateways are not assumed to do the same.

## Running it

```bash
npm ci
npm test          # full suite
npm run test:pii  # the PII gate on its own
npm run dev
```

Copy `.env.example` to `.env.local` and fill it in. Use Paystack test keys only (`sk_test_…`). `DIAGNOSIS_MODEL_PROVIDER` unset or `none` means rules only, with no model calls.

```bash
npm run diagnose -- <paystack_reference>
```

This re-verifies and diagnoses one stall. It writes to Supabase and sends nothing to the customer.

## Contributing

See [`AGENTS.md`](./AGENTS.md) for the rules every change follows.
