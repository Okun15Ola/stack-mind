# Paystack AI Builder Challenge — Build Brief

Oct 15, 2026 · Okunola Olubanjo

A layer that watches every customer who tries to buy and does not, works out why, and acts on it inside limits the business owner sets. The agent is called Kemi. No chat window, no human in the loop, no dashboard to check. Submission week runs to Oct 23, 2026.

The whole system on one page: [How Kemi works](https://claude.ai/artifact/TgK936pbynsAW2pgNBUH4x).

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
| Pages visited, time on each | Website analytics | What they were weighing up |
| Pricing page opened twice | Website analytics | Price was the hesitation |
| Checkout started, not finished | Website analytics | How far they got before stopping |
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

**How Ask once works in practice.** A customer abandons a ₦45,000 order after reading the pricing page twice. Kemi believes a 10% discount would close it. That is not in Standing, so she stops and asks the owner, with the actual customer and the actual number in front of them. The owner says yes, and sets the conditions: discounts up to 10%, orders above ₦20,000, once per customer.

From that moment, discounting under those conditions is part of Standing. She never asks about it again.

**This is the part that compounds.** In month one Kemi asks often. By month six she rarely asks, because the Mandate has become a written record of how this particular business treats its customers. That record belongs to the merchant. It is specific to their business, it was built from real decisions they made, and no competitor can copy it.

It is also the honest answer to the abuse question. Kemi is powerful, but she is powerful inside a box the owner built one decision at a time.

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

Kemi needs exactly two inputs. Everything else is packaging.

1. **The money trail.** A connection to their Paystack account. No code and no access to their website.
2. **The behaviour trail.** One JavaScript snippet in the site's `<head>`, the same way Google Analytics or the Meta Pixel is installed.

That gives three ways in, and we are building all three.

| Path | Who it is for | What they do | What Kemi sees |
| --- | --- | --- | --- |
| **WordPress plugin** | WooCommerce shops | Install, connect Paystack | Everything |
| **One snippet** | Shopify, Wix, Squarespace, Webflow, custom builds | Paste one line, connect Paystack | Everything |
| **Paystack only** | Anyone, in sixty seconds | Connect Paystack, nothing else | Payments only |

**Why WordPress gets a path of its own.** [Paystack maintains its own WooCommerce plugin with over 20,000 active installations](https://wordpress.org/plugins/woo-paystack), built for merchants in Nigeria, Ghana, Kenya and South Africa. They built for WordPress because that is where their merchants are, on a platform that runs [40.1% of all websites and 58.6% of every site using a CMS](https://www.wpzoom.com/blog/wordpress-statistics/). Behaviour comes from PostHog or Google Analytics, whichever the merchant already uses, or from the tracking that ships with the plugin if they use neither. Whichever path they take, setup is about ten minutes and needs no developer.

**The third path matters more than it looks.** A merchant can connect Paystack and have Kemi working before they have decided to trust us with their website. She still catches every failed and abandoned payment with the real reason attached, and still recovers them. What she loses is the hesitation signal: she knows the card failed, she does not know they read the pricing page twice first.

The snippet then becomes an upgrade rather than a barrier. *Add one line and Kemi gets much better at knowing why.* That is an easier conversation than asking for site access on day one.

**Where the email comes from, honestly.** On WordPress, Kemi borrows the SMTP the site already has, so there is nothing to set up. Off WordPress there is no mailer to borrow, so the merchant connects their own: SMTP credentials, Gmail, or whatever provider they already send from. Still their address and their sending reputation, but it is a setup step and we should not pretend otherwise.

**Our own first channel.** ShopCart is a multi-tenant platform with live sellers already taking Paystack payments. One integration at the platform level puts Kemi in front of every seller on it with no install at all, which gives us a pilot population and a supply of real failed transactions to test diagnosis against.

## What the three businesses said

Three conversations, three industries, one complaint underneath.

| Business | Their words | What is underneath |
| --- | --- | --- |
| Healthtech, EMR and consultancy to private hospitals and specialists | Optimizing sales, getting clients | Every sale needs a human to build trust before money moves |
| Trading business | Inflated market, profit monitoring | Costs move weekly, so margin is invisible until cash runs out |
| Sales engine | Trust, not been easy to actualize | A stranger will not pay without a conversation first |

Two of the three describe the same thing in different words: in Nigeria, money does not move until a human has vouched for the other side. That human is the bottleneck, and removing it is what the brief asks for.

## The insight

Every Nigerian business has money that stopped halfway, and nobody goes back for it.

A card declined. A cart abandoned at checkout. A DM asking "how much" that nobody answered. An invoice sent three weeks ago. A quote that went quiet. Each one is a buyer who wanted to pay and then stopped.

Nobody chases any of it, because chasing takes a person, and the person is busy selling to whoever is in front of them right now.

The second half of the insight is the part nobody in that room will say out loud: **Paystack is the only party that can prove a Nigerian business is real.** Not reviews, not a website, not a verified badge. Settled transactions over time. Those cannot be faked, and the merchant already owns the record.

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

**If a judge asks why Paystack would not just build it:** the diagnosis needs context they do not hold. They see one transaction and its error code. We see the merchant's catalogue, policies, trading record and that buyer's history with them. And every naira recovered is a transaction that settles on their rails, so this makes their numbers better rather than competing with them.

**To confirm at the Paystack workshop:** whether subscription renewals are retried automatically. Most processors retry recurring charges even when they do nothing for one-off failures. If Paystack does, we say plainly that subscriptions are handled and we solve the one-off and abandoned case.

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

## Technical appendix

Everything above is the product. Everything below is how it is built, for readers who need to check that it can be.

## The system

The agent runs in the background. The merchant installs it and does nothing else. The buyer never meets a bot.

**Ingest.** Every signal that money stopped moving. Paystack webhooks for failed and abandoned transactions and unpaid invoices, plus a polling sweep of the Transactions API, because charge.failed is reportedly not sent for every failure type and a webhook-only design would miss stalls. Unanswered inbound messages from the channels the merchant already uses. Quotes with no reply.

**Process.** Work out why it stalled. This is the real problem and the real AI work. Insufficient funds is not a card decline, which is not hesitation, which is not "they asked a question and nobody answered". The signals are all there: the Paystack error code, the day of the month, the amount against that buyer's history, whether they came back to the page, what they last said.

**Action.** Execute the remedy without asking anyone. The next section lists what each remedy is.

The merchant sees one thing: money that was going to vanish comes back, with a line saying what the agent did and why.

## The stack

The four sponsor tools map onto the three stages without forcing. Each one below earns its place; if any stops earning it after its workshop, drop it and say why.

| Stage | Tool | What it does for us | Status |
| --- | --- | --- | --- |
| Ingest | Paystack | Webhooks for failed and abandoned transactions, transaction history behind the verified record | Committed, no alternative exists |
| Process | Google Gemini | Diagnose why the payment stalled | Committed, credits provided |
| Process | Cencori | Gateway in front of every model call: routing, failover, and keeping buyer PII out of prompts | Confirm at the 15 October workshop |
| Action | Bimpe AI | Deliver the remedy on WhatsApp from a server-side event | Confirm at the 16 October workshop |
| Action | Paystack | Issue the replacement payment link | Committed |

**Why Cencori is more than tool-checking.** The diagnosis layer reads buyer phone numbers and email addresses and sends them to a model. That is the exact leak Cencori exists to stop. Having just closed a personal-data exposure on our own platform, routing model calls through a gateway so buyer PII is never sent uninspected is a position we hold, not a feature we are reciting. Integration cost is close to zero: a gateway is a base URL change.

**Why Bimpe may reopen the scope.** WhatsApp delivery was cut from week one because the integration looked too heavy. Bimpe does WhatsApp agents as its core product. If it can trigger outbound messages from a server-side event with no human in the loop, the outbound channel stops being a blocker and the "they had a question" remedy returns to scope.

**Questions to put to each workshop**

- Cencori: what happens to a prompt containing a customer's phone number, and can the gateway redact before the provider sees it?
- Bimpe: can an agent send outbound with no human in the loop, and how long does WhatsApp Business approval take?
- Paystack: which webhook events distinguish abandoned from failed, and does Chord change the integration?

## Week one scope

Ship one loop end to end on real data, not six loops on mock data.

**In scope**

1. Paystack webhook listener for failed and abandoned transactions
2. Diagnosis across the first three rows of the taxonomy: no money now, card failing, no trust
3. Three remedies: timed retry, switch to transfer, send verified trading record
4. The verified record itself, computed from the merchant's own Paystack history
5. One merchant connected read-only: our own Paystack account, which carries both ShopCart and PassMate, for real stalled transactions
6. A recovered-money counter the merchant can see

**Explicitly out**

- Inbound message ingestion from social channels. It doubles the integration work and the Paystack signals alone prove the idea.
- Any merchant-facing dashboard beyond the counter
- Multi-merchant onboarding and billing
- The "they had a question" remedy, which needs the message channels we are cutting

The demo is a real failed transaction on a live Paystack account, diagnosed and acted on while the room watches. Most teams will demo a mockup.

**Data, code and sending.** Three rules that are not negotiable.

1. **Our Paystack data, yes.** Connected read-only as the first merchant. Real failures, real signals, and the one thing no other team in the room has.
2. **Our codebase, no.** Fresh repo, nothing from ShopCart or PassMate in it. The challenge IP terms stop being a question the moment our revenue product's code is not in the build.
3. **No messages to real buyers in week one.** The agent runs in dry-run: ingests live transactions, diagnoses, decides the remedy, logs what it would have sent. Live sending only to consenting test buyers who place real small orders for us.

Rule 3 is the one that matters. Those buyers never agreed to be contacted by a product that did not exist on Monday, and we would be routing their phone numbers and emails through four pieces of unvetted sponsor infrastructure four days after closing a personal-data exposure on that same platform.

Dry-run is also the better demo. The room sees the diagnosis and the reasoning, not a notification. And the line "we are not sending autonomous messages to real customers in week one" reads as judgement, which is rarer in that room than a working integration.

One caution on the number: ShopCart has roughly 10 paid orders in total, so recovered naira on our own base proves nothing. Lead with diagnosis quality on real data; use the figure only to show the mechanism runs.

## Who builds what

The split follows what each of us already does, so both are building from the first hour.

| Area | Owner | Why |
| --- | --- | --- |
| Diagnosis layer: why did this payment stall | Herbert | Closest to his retrieval and intelligence work on Robo-Teacher. Inference from sparse, messy signals. |
| Paystack integration: webhooks, transactions, payment links | Okunola | Live Paystack merchant, already runs webhooks and escrow in production |
| Verified trading record | Okunola | Computed from transaction history he already reads daily |
| Action layer: executing each remedy | Shared | Herbert picks the remedy, Okunola executes it against Paystack |
| Guardrails and rate limits | Okunola | Same shape as the authorisation work he shipped this week |
| Demo and pitch | Shared | Okunola tells the ShopCart story, Herbert explains the model |

Still outstanding from the organisers: the team has not agreed a name. Reply-all on the introduction thread with one and close it.

## Guardrails

An agent messaging real buyers without a human can damage a merchant's relationships faster than it recovers money. These are part of the pitch, not a later addition.

- **Hard stop on payment.** The moment the transaction settles, every pending action for that buyer is cancelled. Chasing someone who already paid is the worst failure mode.
- **Cap per buyer.** Three contacts maximum on a single stalled payment, ever.
- **Quiet hours.** Nothing sent outside 8am to 8pm in the buyer's time zone.
- **One-tap opt-out** on every message, honoured permanently across every merchant on the platform.
- **Merchant kill switch.** One toggle stops all autonomous action immediately.
- **Nothing invented.** The agent only sends facts from the merchant's own catalogue, policies and Paystack record. It never makes a claim the merchant has not made.
- **Full log.** Every decision and action recorded with the signals that caused it, so the merchant can audit what was sent in their name.

Say these unprompted when presenting. They signal we have thought past the demo, and Paystack will care about this more than which model we picked.

## Measures and the pitch

One number decides whether this works: **naira recovered that would otherwise have been lost.** Everything else is secondary.

| Measure | Why it matters |
| --- | --- |
| Naira recovered per merchant per month | The only number a merchant cares about |
| Recovery rate on stalled transactions | Proves the diagnosis is right, not just the chasing |
| Time from stall detected to action taken | The under-60-seconds claim, measured |
| Buyer complaints and opt-outs per 1,000 messages | The guardrails working, or not |

**The pitch**

> Every business has money that stopped moving. A failed card, an abandoned cart, a question nobody answered. Nobody follows up, because following up needs a person. We built the person. It watches every stalled payment, works out why it stalled, and fixes it by itself, in under a minute, using the merchant's own Paystack history as proof when the problem is trust.

**The hook to open with**

> How much money stopped moving in your business last month? Nobody can tell you. We can, and we can go and get it.

## Open questions

- [ ] Agree a team name and reply-all on the introduction thread. Outstanding since 13 October.
- [ ] Read the challenge IP terms before any ShopCart or PassMate code goes into the build. Cheap to check now, expensive to discover in three weeks.
- [ ] Confirm with the Paystack workshop which webhook events expose abandoned, as opposed to failed, transactions, and whether Chord changes the integration.
- [ ] Decide the channel for outbound remedies. Email is easy and weak. WhatsApp is right for this market and harder to get approved.
- [ ] Settle whether the verified trading record is shown to buyers as a link or embedded in the message.
- [ ] Go back to the three businesses with the built thing and ask whether they would install it. That is the customer discovery loop the organisers asked for.

**Decisions already made**

- Background agent, not a chatbot. No buyer-facing conversation surface.
- Paystack signals only in week one. Social channels cut.
- ShopCart is the first live merchant, because the stalled transactions are real and ours.
