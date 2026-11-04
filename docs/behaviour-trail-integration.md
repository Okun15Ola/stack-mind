# Behaviour trail: integration note for emitters (ShopCart, PassMate)

The contract is issue #12 (approved, with the Ed25519 correction). This note is the practical version for an emitting app. Opada only receives. It never reads your database, and it never sees an email.

**What a forged or wrong event costs:** a polluted behaviour trail, so a wrong diagnosis and possibly a wrong message to a real buyer. Not money. Treat the signing key accordingly.

## 1. Get an emitter key (once per app, per environment)

On **your** machine, in a checkout of the Opada repo:

```
npm run emitter-key -- --merchant okunola --emitter shopcart --env test
```

This prints a key id (`oek_test_…`) and a public key, and writes the private key to `./oek_test_….private.pem` (mode 600).

1. Put the private key in your app's secret store (e.g. `OPADA_EMITTER_PRIVATE_KEY`, with `OPADA_EMITTER_KEY_ID`). Then delete the `.pem` file. It is never sent to Opada, and nobody at Opada can recover it.
2. Send Okunola the printed SQL. It contains only the key id and the **public** key. He runs it in the Supabase SQL editor.

**Rotation:** `npm run emitter-key -- --rotate oek_test_…` writes a new private key and prints SQL that adds the new public key as the second active key. Deploy the new private key, confirm events still arrive, then ask Okunola to promote the new key to `public_key_1` and clear `public_key_2`.

## 2. Attach the buyer ref to the Paystack transaction (live checkout code)

**Opada losing a join is an inconvenience. ShopCart losing a sale is not.** This change must be:

1. **Additive only.** Add `opada_buyer_ref` (and `opada_session_ref` if you use sessions) to the existing metadata. Never modify, replace or reorder existing keys. If metadata isn't a plain object, attach nothing. If `opada_buyer_ref` is already there, leave it.
2. **Unable to fail the checkout.** Wrap it. On any error, log the error kind only (never the customer), and initialise the payment exactly as before, without the ref.
3. **Behind a flag** (`OPADA_TRAIL_ENABLED`), off by default.
4. **No other change to the payment call:** same endpoint, amount, currency, callback, channels and timing.

```js
let metadata = existingMetadata;
if (process.env.OPADA_TRAIL_ENABLED === "true") {
  try {
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata) && !("opada_buyer_ref" in metadata)) {
      metadata = { ...metadata, opada_buyer_ref: buyerRefFor(customer), opada_session_ref: sessionRef };
    }
  } catch (err) {
    log.warn("opada ref not attached", { kind: err?.name }); // never log the customer
  }
}
// initialise the Paystack transaction exactly as before, with `metadata`
```

**`buyer_ref`:** a random 128-bit value, base64url (22–64 characters of `A–Z a–z 0–9 _ -`), generated once per customer and stored on the customer record. For guests, generate one per browser and keep it. **Never** derive it from an email, phone or database id. Hashes of emails can be reversed. **`session_ref`:** the same format, new per checkout session.

The trail is **forward-only**: transactions created before this ships never join.

## 3. Send events

```
POST https://<opada>/api/v1/behaviour-events
Content-Type: application/json
Opada-Key-Id: oek_test_…
Opada-Timestamp: <unix seconds, now>
Opada-Signature: v1=<base64url Ed25519 signature of "<timestamp>.<raw body>">
```

- **Sign the exact bytes you send.** Serialise the body once, sign that string, and send that string. Never re-serialise between signing and sending.
- **The timestamp must be within ±300 seconds** of Opada's clock, or the request is rejected (`401 timestamp_outside_window`). Keep your server clock synced.
- **Batches** of 1 to 100 events, at most 64 KB. Each `event_id` (ULID or UUID) is stored once, so resending is safe.
- **Fire-and-forget,** off the request path, with a short timeout. A slow or failed Opada must never slow or block the buyer's page or checkout.
- **On `503 retention_overdue`: drop the events, log locally, and do NOT retry or queue them.** This status means Opada has deliberately stopped collecting, because it can't currently prove it is deleting old events. Retrying defeats that, and turns one stalled cleanup job into a retry storm from every emitter. Log the drop (status code and count only, never the events or the buyer), then carry on. Collection resumes on its own once Opada's purge is running again; no action is needed on your side.
- **Other failures** (network errors, timeouts, `5xx` other than `retention_overdue`): drop and log too. The trail is best-effort evidence, and no event is worth slowing a checkout or building a local backlog for.

### Declaring what your server saw: `observed`

Each event may carry `"observed": "server"` or `"observed": "browser"`. Leave it out and Opada treats the event as `"browser"`.

- **Declare `"server"` only for an event your server itself handled**: you initialised the Paystack transaction, created the checkout or order row, or received a form POST. Anything the browser reported to you (a page view, a tab closing, a popup closing) is `"browser"`, even though your server is the one sending it.
- **`observed` can only lower trust, never raise it.** Opada stores `server_observed` for a signed request declaring `"server"`, and `server_relayed` for everything else. Claiming `"server"` for an event a server cannot see is rejected (`server_observation_not_possible`), not downgraded:

| Event | `observed: "server"` allowed? |
| --- | --- |
| `checkout_started` | yes (the checkout or order is created server-side) |
| `payment_started` | yes (the Paystack transaction is initialised server-side) |
| `question_asked` with `channel: "form"` | yes (the form POST reaches your server) |
| `question_asked`, any other channel | no |
| `info_viewed` | no (a page view is a browser fact) |
| `checkout_left` | no |
| `payment_closed` | no (the popup closes in the browser) |

- **Why it matters:** an Ask-once action needs first-hand evidence for the reason it acts on, and `server_relayed` evidence never counts. Overclaiming `"server"` is how the trail would lie about itself, so don't.


```js
import { createPrivateKey, sign } from "node:crypto";

const key = createPrivateKey(process.env.OPADA_EMITTER_PRIVATE_KEY);
const body = JSON.stringify({ events });                // serialise ONCE
const ts = String(Math.floor(Date.now() / 1000));
const signature = sign(null, Buffer.from(`${ts}.${body}`), key).toString("base64url");

fetch(`${OPADA_URL}/api/v1/behaviour-events`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "opada-key-id": process.env.OPADA_EMITTER_KEY_ID,
    "opada-timestamp": ts,
    "opada-signature": `v1=${signature}`,
  },
  body,                                                 // the same string that was signed
  signal: AbortSignal.timeout(2000),
})
  .then(async (res) => {
    if (res.status === 202) return;
    const code = (await res.json().catch(() => ({}))).error;
    // 503 retention_overdue: Opada stopped collecting on purpose. Drop the
    // events. Do NOT retry and do NOT queue them.
    log.warn("opada events dropped", { status: res.status, error: code, count: events.length });
  })
  .catch(() => log.warn("opada events dropped", { status: "network", count: events.length })); // never retry, never affect the buyer
```

**Events** (no free text anywhere; unknown fields and values are rejected):

| `type` | `properties` |
| --- | --- |
| `checkout_started` | `item_count`, `amount_minor_units`, `currency` (all optional) |
| `info_viewed` (one per view) | `kind` (required): `pricing`, `terms`, `refund_or_returns`, `delivery`, `faq`, `payment_methods`, `contact`, `other` |
| `question_asked` | `channel` (required): `chat`, `whatsapp`, `email`, `phone`, `form`, `other` |
| `payment_started` | `paystack_reference` (optional) |
| `payment_closed` | `stage`: `before_method`, `card_entry`, `otp_or_pin`, `bank_transfer`, `unknown` |
| `checkout_left` | `last_step`: `cart`, `details`, `delivery`, `payment`, `other`; `reason`: `navigated`, `closed`, `idle` |

**Envelope:** `event_id`, `type`, `occurred_at` (RFC 3339 UTC, within the last 7 days and no more than 5 minutes ahead), `buyer_ref`, optional `session_ref`, optional `device` (`mobile`, `tablet`, `desktop`), `properties`.

**Response:**
- `202 { accepted, duplicates, rejected: [{ event_id, error }] }`. Valid events in a batch are kept even if others are rejected.
- `401`: authentication failed, with an error code that names the rule. Fix your key or clock; don't retry the same request.
- `503 { error: "retention_overdue" }`: Opada has deliberately stopped collecting. **Drop, log locally, never retry, never queue.**
