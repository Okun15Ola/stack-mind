# Opada: product brief

> **This file is the source of truth for what Opada is and what it promises.** It is versioned with the code, and changes to it go through a PR like any other change. The Claude Docs version of the brief is a read-only pitch copy: don't edit it to change the spec, and if the two disagree, this file wins.
>
> Adapted on 4 November 2026 from the build brief of 15 October 2026 (Okunola Olubanjo), with the challenge material removed and the install paths corrected.

Opada is a layer that watches every customer who tries to buy and does not, works out why, and acts on it inside limits the business owner sets. The agent is called Kemi. No chat window, no human in the loop, no dashboard to check.

The whole system on one page: [How Kemi works](https://claude.ai/artifact/TgK936pbynsAW2pgNBUH4x) (pitch artifact).

## What it is

It sits between your website and your payment gateway, watches what every customer actually does, works out why the ones who did not pay did not pay, and does something about it, inside limits you set.

It is not a chatbot and it is not a dashboard you have to check. It is a layer that was already watching when the thing went wrong.

Today a Nigerian merchant sees this: a row in Paystack that says the payment failed, and a name. Nothing else happens. Nobody follows up, because following up on each one by hand is work nobody has time for. One person running a store cannot ring twenty people a day to ask why they stopped.

This closes that gap without the merchant doing anything.

## Meet Kemi

The work is done by an agent, and the agent has a name. She is called **Kemi**.

The name is short for Olukemi. The root means to care for, to look after. Every Nigerian knows the name on sight, and an agent whose whole job is to look after the customers who fall out of your checkout could not be called anything better.

This is not decoration. It changes what the merchant reads on their screen:

> Kemi noticed Chidi's card was declined at 11pm and sent him a new payment link this morning. He paid.

Against the alternative:

> System event: transaction 9v85euqujlld90l status failed. Recovery action dispatched.

The first one is a colleague. The second is software. A small business owner who has never hired anyone understands the first immediately, and that understanding is most of the sale.

Kemi works for one business at a time. She learns how that business treats its customers, and over the first few months she needs to ask fewer and fewer questions. How that works is the next section but one.

## What Kemi sees

This is the part that does not exist anywhere today.

Your payment gateway sees one thing: a charge succeeded or it did not. Your website analytics sees another: pages viewed, buttons clicked, a session that ended. Neither one knows about the other, so neither can tell you why someone did not buy.

Kemi reads both, joined into a single trail for each customer:

| What she reads | Where it comes from | What it tells her |
| --- | --- | --- |
| Pages visited, time on each | Behaviour trail | What they were weighing up |
| Pricing page opened twice | Behaviour trail | Price was the hesitation |
| Checkout started, not finished | Behaviour trail | How far they got before stopping |
| Payment attempted and declined | Payment gateway | The attempt was real, the money was the problem |
| The exact decline reason | Payment gateway | Card, funds, bank, or the provider itself |
| Whether they came back | Both | Whether this is over or still live |

Read on its own, each line is noise. Read together, they are a sentence.

**A customer who read the pricing page three times and never opened checkout has a different problem from a customer who opened checkout and had their card declined.** The first was not convinced. The second was convinced and could not pay. Sending both the same message is why follow-up has such a bad name, and it is what every existing tool does.

Kemi tells them apart, and that is the whole product.

## The Mandate

Everyone asks the same question about an AI that can contact customers: what stops it being abused?

The answer is the Mandate. **The business owner writes the Mandate. Kemi never writes it.** Everything she is allowed to do sits in one of three levels.

| Level | What it covers | Does she ask first? |
| --- | --- | --- |
| **Standing** | Email a customer whose card failed. Resend a payment link. Answer a question she already has the answer to. | No. Set once at install, done every time. |
| **Ask once** | Offer a discount. Message on WhatsApp instead of email. Reach someone outside normal hours. Anything not in Standing. | Yes, the first time. Then never again for that kind of action. |
| **Never** | Change a price. Issue a refund. Touch card details. Contact someone who opted out. Exceed the message cap. | No permission unlocks these. Ever. |

**How Ask once works in practice.** A buyer who has completed orders with this merchant before has a payment fail with insufficient funds, late in the month. Paystack's own `gateway_response` says so, and the gateway rules match it to `NO_FUNDS_NOW`, so the diagnosis rests on first-hand evidence and the Ask once gate can open. Kemi believes a 10% discount would close it. A discount is not in Standing, so she stops and asks the owner, with the actual buyer and the actual amount in front of them. The owner says yes, and sets the conditions: discounts up to 10%, orders above ₦20,000, once per customer.

From that moment, discounting under those conditions is part of Standing. She never asks about it again.

**This is the part that compounds.** In month one Kemi asks often. By month six she rarely asks, because the Mandate has become a written record of how this particular business treats its customers. That record belongs to the merchant. It is specific to their business, it was built from real decisions they made, and no competitor can copy it.

It is also the honest answer to the abuse question. Kemi is powerful, but she is powerful inside a box the owner built one decision at a time.

**Ask once needs first-hand evidence for the reason.** An Ask once action may only run when the diagnosis rests on at least one fact Opada observed first-hand for that reason: a Paystack field Opada fetched itself, or an event the merchant's own server saw. Browser-reported evidence can drive Standing actions, never Ask once. Provenance limits what Kemi may *do*, never what she may *conclude*. The rules and their reasoning are in `AGENTS.md`; the per-reason table is `src/lib/first-hand.ts`.

## Why it is safe to run unattended

AI is not deterministic. The same question can produce a different answer twice. That is the objection a serious reviewer will raise, and it is a fair one for a system that contacts paying customers while nobody is watching.

The design answers it by splitting the job in two:

> **Kemi decides why. She never decides what she is allowed to do.**

Working out why a customer stopped is a judgement, and judgement is where a model earns its place. That part is probabilistic, and it carries a confidence score and a written reason the owner can read.

Choosing what happens next is not a judgement. It is a lookup against the Mandate. The reason maps to a permitted action, or it maps to nothing and she asks.

The consequence matters: **a model that invents a wrong reason still cannot take an action the owner has not authorised.** The worst case is a well-intentioned email about the wrong thing, not a discount nobody approved and not a message to someone who asked to be left alone.

Three further constraints hold regardless of what the model concludes:

- Every action is re-checked against the payment gateway immediately before it fires. If the customer has paid in the meantime, nothing is sent. Nobody is ever chased for money they already paid.
- Every action starts in dry-run. The owner sees exactly what would have been sent before anything goes live.
- Every customer has a cap on how often they can be contacted, and it cannot be raised by any permission.

## How a business gets it

There are three ways a merchant can connect Opada. They are not equal. They differ in how much trust they ask of the merchant and how much of the picture Opada gets in return. Listed strongest first:

### 1. WordPress / WooCommerce plugin: easiest and strongest

The plugin runs inside the merchant's own site, so everything Opada needs is already there:

- **WooCommerce already knows** when an order failed or a checkout was abandoned.
- **Paystack's webhooks already arrive at the merchant's domain.** The plugin reads them where they land, so we don't take over the merchant's one webhook URL and their fulfilment keeps working untouched.
- **The signing keypair is generated on the merchant's server**, and the private half never leaves it. Opada only ever holds the public key.

There's no credential handover and no webhook takeover. The merchant installs a plugin, the way they install any other plugin.

**"Ten minutes, no developer" is true for this path, and only this path.**

### 2. One snippet: partial

A JavaScript snippet on the merchant's pages gives Opada the **behaviour trail**: what the buyer looked at, where they paused, and when they left.

It gives nothing else. **JavaScript in a browser can't see payments at all.** It doesn't know whether a charge was attempted, declined or abandoned. So the snippet on its own can't diagnose a stalled payment. It still needs a server-side piece for the money trail, which puts the merchant back on path 3, or on webhook forwarding (see below).

Every event the snippet sends is browser-originated (`client` provenance). It can support a diagnosis but never establish one alone, and it never opens the Ask-once gate.

### 3. Paystack only: hardest

Earlier versions of this brief called this path "anyone, in sixty seconds." It's the opposite: **the path that asks the most trust and offers the least.**

- **The webhook route is closed.** Paystack allows one webhook URL per account, and most merchants already use theirs for fulfilment.
- **The polling route needs the merchant's secret key**, and a Paystack secret key isn't read-only: it can issue refunds and initiate transfers. Opada's endpoint allowlist means we only ever read, but the merchant can't verify that. Handing it over means trusting a startup they've never heard of with their money.
- **What Opada gets back is the money trail only.** There's no behaviour trail, so behavioural reasons mostly come out as `INSUFFICIENT_EVIDENCE`.

Whether Paystack offers a scoped, read-only route is an open question, tracked in issue #22. If the answer is no, the fallback is **webhook forwarding**: the merchant keeps their webhook URL and adds a few lines to their handler that re-send each verified event to Opada. That hands over no credentials, but it needs a developer. So it breaks the ten-minute promise for exactly the merchants least able to meet it.

### What this changes about what we build first

The earlier order (snippet, then Paystack only, then the plugin "later") was upside down. Two of those three promised something the architecture can't deliver.

**The WordPress plugin isn't a later nice-to-have for the 29% of stores on WooCommerce. It's how Opada reaches anyone at all.** It's the only path where a merchant we've never met can connect both trails without handing us a key that moves money. It comes first. The snippet follows as an add-on for the behaviour trail. Paystack-only waits on Paystack's answer in issue #22.

## What the three businesses said

*From customer conversations in October 2026, before the build. Kept as the original discovery, not a current read of those businesses.*

Three conversations, three industries, one complaint underneath.

| Business | Their words | What is underneath |
| --- | --- | --- |
| Healthtech, EMR and consultancy to private hospitals and specialists | Optimizing sales, getting clients | Every sale needs a human to build trust before money moves |
| Trading business | Inflated market, profit monitoring | Costs move weekly, so margin is invisible until cash runs out |
| Sales engine | Trust, not been easy to actualize | A stranger will not pay without a conversation first |

Two of the three describe the same thing in different words: in Nigeria, money does not move until a human has vouched for the other side. That human is the bottleneck, and removing that bottleneck is what Opada is for.

## The insight

Every Nigerian business has money that stopped halfway, and nobody goes back for it.

A card declined. A cart abandoned at checkout. A DM asking "how much" that nobody answered. An invoice sent three weeks ago. A quote that went quiet. Each one is a buyer who wanted to pay and then stopped.

Nobody chases any of it, because chasing takes a person, and the person is busy selling to whoever is in front of them right now.

The second half of the insight is the part that is rarely said out loud: **Paystack is the only party that can prove a Nigerian business is real.** Not reviews, not a website, not a verified badge. Settled transactions over time. Those cannot be faked, and the merchant already owns the record.

So when the reason a payment stalled is trust, the proof needed to unstall it is already sitting in the merchant's Paystack account, unused.

## Why this does not already exist

Paystack detects and labels. It does not recover. That is the gap, and Paystack's own documentation states it.

| What happens | Who does it |
| --- | --- |
| Failure reason recorded in gateway\_response | Paystack |
| Transaction marked abandoned once checkout expires, around 24 hours | Paystack |
| Retrying, contacting the customer, recovering the sale | Nobody. Paystack's guidance is that the merchant should send follow-up emails. |

Paystack also publishes a full table of customer-side failure reasons: insufficient funds, balance not sufficient, payer reached their limit, expired card, invalid card number, incorrect PIN, PIN tries exceeded, invalid OTP, token expired, transaction not completed. Those map directly onto our six categories, so the diagnosis reads a documented field rather than guessing.

**The distinction that carries the pitch.** Paystack tells you what happened. We work out what to do about it. Knowing "insufficient funds" is not the same as knowing it is the 26th, this buyer is paid on the 28th, and they have completed two orders before. Detection, diagnosis and action are three different things, and only the first exists today.

**Why Paystack would not just build it.** The diagnosis needs context they do not hold. They see one transaction and its error code. We see the merchant's catalogue, policies, trading record and that buyer's history with them. And every naira recovered is a transaction that settles on their rails, so this makes their numbers better rather than competing with them.

Sources: [Paystack customer errors](https://support.paystack.com/en/articles/2124674), [Paystack transaction status values](https://www.mctaba.com/learn/paystack/paystack-transaction-status-values-and-what-each-means)

## The stall taxonomy

This table is the product. Everything else is plumbing around it.

| Why it stalled | How we know | What the agent does |
| --- | --- | --- |
| No money right now | Insufficient funds code, late in the month, buyer has paid before | Hold, retry timed to payday, or offer to split the payment |
| Card keeps failing | Repeated card decline codes on the same buyer | Switch channel: send a transfer option instead of asking again |
| Bank or processor was down | Clustered failures across many buyers in the same window | Retry quietly once the window clears, tell nobody |
| They do not trust us | First-time buyer, high amount, reached checkout and left | Send the merchant's verified Paystack record: months trading, orders fulfilled, repeat customers |
| They had a question | Inbound message with no reply, or left the page after viewing terms | Answer it from the merchant's own catalogue and policies, then re-send the link |
| They simply forgot | Cart abandoned mid-flow, no error, no reply | One timed nudge with the link, then stop |

Two things to note. The diagnosis is inference from sparse signals, not a lookup, which is where the model earns its place. And the remedy is an action taken, not a message suggested to the merchant for approval.

## What we have already proved

On 15 October we ran two declined card payments through our own live Paystack account and watched what the platform did. Both results are stronger than the argument we started with.

| Reference | Paystack's stored status | What actually happened | Webhook sent |
| --- | --- | --- | --- |
| 9v85euqujlld90l | failed | Card declined | None |
| yi8ijvdw7mjns54 | **abandoned** | Card declined | None |

**Paystack sent no webhook for either decline**, even though we were subscribed to `charge.failed` and it is offered as a subscribable event. A merchant waiting to be told is never told.

**The second one is worse, and it is the finding that justifies the whole product.** Paystack stored a declined card as `abandoned`, and attributed the abandonment to itself. A merchant reading that status would conclude the customer changed their mind. The customer's card had failed. The true reason was sitting in a separate text field that nothing in the dashboard draws attention to.

So the problem is not only that nobody follows up. **The data merchants have is wrong, and nothing tells them it is wrong.** Acting on that status means sending a "come back and finish your order" message to someone whose card does not work, which is both useless and slightly insulting.

Our poller picked up both within fifteen minutes, with the true reason preserved and no duplicates on repeat runs. That path is built and working.

## The system

The agent runs in the background. The merchant installs it and does nothing else. The buyer never meets a bot.

**Ingest.** Every signal that money stopped moving. Paystack webhooks for failed and abandoned transactions and unpaid invoices, plus a polling sweep of the Transactions API, because charge.failed is reportedly not sent for every failure type and a webhook-only design would miss stalls. Unanswered inbound messages from the channels the merchant already uses. Quotes with no reply.

**Process.** Work out why it stalled. This is the real problem and the real AI work. Insufficient funds is not a card decline, which is not hesitation, which is not "they asked a question and nobody answered". The signals are all there: the Paystack error code, the day of the month, the amount against that buyer's history, whether they came back to the page, what they last said.

**Mandate.** Look up whether the remedy for that reason is permitted. The owner writes the Mandate; Kemi never does. The reason maps to a permitted action, or it maps to nothing and she asks.

**Action.** Execute the permitted remedy without asking anyone, after re-verifying against Paystack immediately beforehand. The remedy for each reason is in the stall taxonomy.

The merchant sees one thing: money that was going to vanish comes back, with a line saying what the agent did and why.

## What runs today

| Part | What it does |
| --- | --- |
| Paystack | The money trail: transactions read by a polling sweep of the Transactions API, re-verified before any diagnosis or action. Read-only endpoints only (see `AGENTS.md`). |
| Groq | The diagnosis model, behind a provider seam, for stalls the deterministic gateway rules can't classify. Sees a redacted view with no customer identity. |
| Supabase | Postgres for stalls, diagnoses and the behaviour trail, with row-level security on and a scheduled purge enforcing 30-day trail retention. |
| Vercel | Hosts the app and the behaviour-trail ingest endpoint. |

The live list of what's being built next is the repo's open issues, not this brief.

## Guardrails

An agent messaging real buyers without a human can damage a merchant's relationships faster than it recovers money. These are part of the pitch, not a later addition.

- **Hard stop on payment.** The moment the transaction settles, every pending action for that buyer is cancelled. Chasing someone who already paid is the worst failure mode.
- **Cap per buyer.** Three contacts maximum on a single stalled payment, ever.
- **Quiet hours.** Nothing sent outside 8am to 8pm in the buyer's time zone.
- **One-tap opt-out** on every message, honoured permanently across every merchant on the platform.
- **Merchant kill switch.** One toggle stops all autonomous action immediately.
- **Nothing invented.** The agent only sends facts from the merchant's own catalogue, policies and Paystack record. It never makes a claim the merchant has not made.
- **Full log.** Every decision and action recorded with the signals that caused it, so the merchant can audit what was sent in their name.

## Measures

One number decides whether this works: **naira recovered that would otherwise have been lost.** Everything else is secondary.

| Measure | Why it matters |
| --- | --- |
| Naira recovered per merchant per month | The only number a merchant cares about |
| Recovery rate on stalled transactions | Proves the diagnosis is right, not just the chasing |
| Time from stall detected to action taken | The under-60-seconds claim, measured |
| Buyer complaints and opt-outs per 1,000 messages | The guardrails working, or not |
| Share of model diagnoses returning `INSUFFICIENT_EVIDENCE`, split by whether the behaviour trail was available | Whether the behaviour trail actually helps Kemi tell the reasons apart. It should drop when the trail ships (view `diagnosis_insufficient_evidence_rate`, issue #10) |

## The pitch

> Every business has money that stopped moving. A failed card, an abandoned cart, a question nobody answered. Nobody follows up, because following up needs a person. We built the person. It watches every stalled payment, works out why it stalled, and fixes it by itself, in under a minute, using the merchant's own Paystack history as proof when the problem is trust.

**The hook to open with**

> How much money stopped moving in your business last month? Nobody can tell you. We can, and we can go and get it.
