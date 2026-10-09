---
title: Subscriptions
sidebar_position: 8
description: Sell the same thing every month, and let a customer manage their own.
tags: [module, subscriptions, invoicing]
---

# Subscriptions

A wash club. A box every two weeks, a retainer, a membership, a monthly round.
Selling the same thing every month is a different business from selling a thing
once, and what it costs you is not the making. It is knowing who is on which
plan, whose trial ends this week, who is paused, and who has given notice.

**It does not need the Shop.** Subscriptions bills contacts through Invoicing,
which you already have. A gym, an agency on a retainer, an MSP and a window
cleaner can all run on it without ever selling anything online.

One plan, many subscribers, and an invoice every cycle that posts like any
other invoice.

```mermaid
flowchart LR
  classDef screen fill:#eef4ff,stroke:#3b6fd4,color:#16305e
  classDef own fill:#eefaf1,stroke:#219653,color:#10442a
  classDef out fill:#f4f0fb,stroke:#6b47c4,color:#31205e
  classDef pub fill:#fff4ec,stroke:#c4470f,color:#5a2207
  subgraph OWN[" Subscriptions "]
    PLAN["Plans<br/><small>price, cycle, what is included</small>"]:::own
    SUB["Subscribers"]:::own
    DUN["Dunning<br/><small>what happens to a failed card</small>"]:::own
  end
  C["A contact<br/><small>CRM</small>"]:::out
  INV["An invoice, every cycle<br/><small>Invoicing</small>"]:::out
  LED["The journal"]:::out
  PORTAL(["The customer's own screen"]):::pub

  C --> SUB
  PLAN --> SUB
  SUB --> INV --> LED
  INV -->|"card declined"| DUN --> INV
  SUB --> PORTAL
  style OWN fill:#fbfdfc,stroke:#cfe4d8,color:#10442a
```

## What it is built on

Nothing new. A subscription raises an ordinary invoice, numbered and posted to
the ledger like any other: one set of books, and one place money is both
recognized and chased from.

The run that raises it belongs to this module, and it is the only thing that
bills a subscription, even with Pro's recurring invoices running beside it.
That is deliberate. Two things that each believe they own a renewal is how
somebody gets charged twice.

## Plans

**A plan is an item on your price list with a billing interval on it.** There
is no second catalog. It is priced and taxed exactly like anything else you
sell, because a second catalog would be a second answer to what a thing
costs.

Anything already on the price list can be promoted to a plan without retyping
its price, and a plan can carry a tax like any other line. Which tax a
subscriber actually pays depends on where they are, though, and that has a
section of its own: [Tax, from where the subscriber is](#tax-from-where-the-subscriber-is).

Withdraw a plan and nobody on it is disturbed. Subscribers keep the price and
the dates they agreed to.

**A plan can cost nothing.** That is how you give somebody the thing you sell:
a free tier, a charity, a partner, a long trial you do not want to end on a
date. They are subscribers like everybody else, in the same list and on the
same screen, and they are billed nothing. A subscription whose agreed price is
zero raises no invoice, sends no email and posts nothing to your books.

## Subscribers

A subscriber is a contact, a plan, and the price they agreed to. That price is
copied onto the subscription at signup rather than read back from the plan each
period. Raising your prices does not raise them for the people who joined last
year, and a plan edited on a Tuesday must not silently rebill everybody on
Wednesday.

| State | What it means |
|---|---|
| **Trialling** | On a plan, not yet billed |
| **Active** | Billed on schedule |
| **Paused** | Not billed, not canceled, keeps its place — if you allow pausing |
| **Canceled** | Ends on a date; it is not a switch thrown today |

Cancelling sets the date it takes effect rather than stopping the billing that
instant. Somebody who cancels on the 3rd of a month they have already paid for
keeps the rest of it, which is what they expect and what avoids a refund. Until
that date the subscription reads **ending**, and **Keep them** takes the
cancellation back.

When you do want it over today, a disputed or fraudulent one say, **Stop now**
ends it on the spot. It refunds nothing; it only means no further invoice is
raised.

## Tonight's billing

Subscriptions bill themselves at two in the morning. Which is fine when it
works, and nothing at all when it does not — a subscription whose plan has been
deleted, or that nobody ever priced, is skipped every single night, and the only
trace is a line in a log you have no reason to read. The customer is simply
never billed.

So **Tonight's billing** shows you the run before it happens: everything due by
the end of today, what each one will raise, and the total. Read down the column
of sentences. Most of them say what will be billed and for which period. Any
that say somebody has to fix something first are money you are not collecting.

It is the same decision the night's run makes, not a description of one — the
same function answers both — so the figure you read here is the figure that
arrives.

**A night that didn't run is caught up on the next one that does.** Say the
server was down for a week, or your licence lapsed for a month. The next run
bills every period that came round in the meantime, oldest first, each on its
own invoice and each dated the day its period began, so March's invoice says
March whenever it went out. It's due on your usual terms counted from the day
it actually went out, though, not from March: your customer isn't late, or
chased, for a bill your outage held back. Where the books are closed for the
period's day, the invoice is dated the day it was raised instead.

A run catches up at most twelve periods for one subscription, a year of a
monthly plan. Anything older is still owed and goes out the following night.
The limit is there so a subscription imported with a start date years back
can't send one customer eighty invoices before anybody has looked at it.
**Tonight's billing** shows the oldest period due, which is the one the run
starts with.

## Charging for what somebody used

Some things are not a flat monthly fee. Hosting, phone minutes, text messages,
gigabytes out, seats in use — a plan can carry **meters**, and the invoice picks
up what was used alongside the subscription's own price.

### How it fits together

1. **A meter** is something you count: a code your own script sends
   (`api-calls`), a name your customer reads ("API calls"), and what one of them
   is ("call"). Set them up on the Plans page.
2. **A plan carries usage charges.** One charge is one line on the invoice, and
   it has a name of your own — "Minutes", "Data". A plan can have several, each
   settled on its own clock.
3. **A charge prices one or more meters** in tiers. Several together is not a
   convenience: for a charge that measures a peak it is the difference between
   right and wrong, because a tier is reached only when *every* limit in it is
   satisfied.
4. **Whatever counts it posts readings** against the subscription, on whatever
   schedule suits it.
5. **The renewal invoice carries both:** the month ahead for the subscription,
   and what was used in the month just gone.

That last point is worth reading twice. Usage is billed **in arrear**, because
nothing can be charged for usage that has not happened yet. So a subscription's
first invoice has no usage on it — no period has closed — and every invoice after
it covers the period that just ended.

### Three kinds of charge

| Measures | Means | For |
|---|---|---|
| **What they used** | The readings in the period, added up | Calls, emails, gigabytes transferred — anything consumed |
| **The most they had at once** | The highest reading in the period | Seats, concurrent connections, bandwidth — anything held |
| **What it cost** | The amounts the readings bring with them | Anything you resell, where the price is not yours to set |

A meter is only ever a thing you count. **How** it is measured belongs to the
charge, which is why the same meter can be counted by one charge and peaked by
another.

The second is charged a flat amount for the tier the peak lands in: "up to 500
members, £5 a month". It does not scale with the number.

The third is for reselling. If you pass a provider's service through to your
customers, the price varies by which call it was — forty endpoints at forty
prices, which is not a tier table and never becomes one. So the reading carries
the amount: whatever recorded the usage works out what to charge, sends it along
with the count, and the period is the sum. Amounts are in **millionths**, because
a resold call can cost a fraction of a penny and a thousand of them have to add
up to what you actually spent. The invoice is still in whole cents; the fraction
left over carries to the next bill, so what you have billed plus what is still
owed always equals what was recorded.

### Two ways to price tiers

For a charge that counts what was used, a tier table can mean one of two things,
and the difference is real money. Say which on the plan:

- **Priced tier by tier.** The first 5 at £2, then £1 each. Seven units cost £12.
- **All of it at the tier they reach.** Seven units reach the £1 tier, so all
  seven cost £1 each: £7.

The second is the one people mean by "it gets cheaper the more you use". Nothing
in a tier table shows which was intended, which is why it is a setting rather
than something we guess.

A tier charges by the **block**: `in blocks of 1,000,000` at £2 is two pounds per
million, and a part-used block is a whole block. Price in blocks of one if that
is not what you want.

**A tier's limit counts blocks, not units**, and this is the one thing here worth
reading twice. *Blocks of 10, 100 blocks in this tier* is a thousand units at
that price — not a hundred. Leave the last tier's limit empty: that is the one
everything above the others is priced at, and a table whose last tier still stops
is refused rather than silently leaving usage above it unpriced.

A tier priced at nothing is a free allowance: *the first 1,000 free, then 5p
each* is two tiers.

### When a period is too small to bill

Three settings, and they only make sense as a set.

| Setting | What it decides |
|---|---|
| **Included each period** | An allowance taken off before anything is charged. **It does not roll over** — a month's allowance that accumulated would let somebody who ignored the service for a year spend the lot in an afternoon. For a counted meter, make the first tier cost nothing instead; that is the same thing said the natural way. |
| **Too small to bill** | Under this, nothing is invoiced and the amount waits for the next bill. Card fees on a forty-pence charge cost more than the charge collects, and a receipt for forty pence reads badly against a service somebody pays ten pounds a month for. |
| **Carry for at most** | How many periods it may wait. Then it bills whatever it comes to, because carrying indefinitely is how a small kindness becomes an audit finding. |

Each of the three belongs to one charge, not to the plan: minutes can bill every
penny while data waits for five pounds.

Nothing is written down twice to make this work: a period that bills nothing
claims nothing, so the next period simply covers both. The amount a customer is
carrying is on their own page and on their record here, said in words — "carried
to a later bill, it is under the minimum charge" — because a balance nobody can
see is two periods arriving at once with no warning.

### An annual plan with monthly usage

Usage settles with the subscription by default, which is the obvious answer and
the wrong one for an annual plan: a year of usage sitting unbilled is a year of
your costs carried as exposure, and your customer gets one alarming invoice
instead of twelve ordinary ones.

So a charge can settle on **a period of its own**, whatever the subscription
bills on. The subscription is annual; the usage is monthly, as its own small
invoice.

When the two fall on the same day, you get one invoice. A monthly charge on a
subscription that renews on the 1st rides on the renewal: the month ahead for
the subscription, and the month just gone for the usage, together. A
subscription that renews on the 15th settles its monthly usage on the 1st, on
its own. Either way each period of usage is billed exactly once, however many
times the night's jobs run.

A charge can settle weekly, monthly, quarterly or yearly. Monthly closes on the
first of the month **where your business is**, not wherever the server happens to
be; the others count from the day the subscription started, so a quarterly
charge on a subscription that began in January settles in April, July and
October. The sweep runs nightly and does nothing on the days with no boundary
behind them.

### Recording what was used

```bash
curl -X POST https://your-instance/api/subscriptions/SUBSCRIPTION_ID/readings \
  -H "Authorization: Bearer $SENTRELLO_METER_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "reference": "nightly-2026-12-01",
    "readings": [
      { "meter": "api-calls", "quantity": 41200, "at": "2026-12-01T00:00:00Z" },
      { "meter": "lookups", "quantity": 3, "amountMicros": 2520000 }
    ]
  }'
```

**The `reference` is yours and it matters.** It is how a batch sent twice is
recorded once — the day, a job run, a log offset, whatever your side already has.
Every HTTP client retries, and without it a retry charges your customer twice for
the same gigabytes, with nothing anywhere saying so. Send it again and you get
the same answer back rather than an error, because a retry that gets an error
retries again.

Leave `at` out and the reading is now; send it when the batch is catching up on
yesterday's traffic. A date we cannot read is refused rather than quietly stamped
with the current time, because that would move usage into the wrong period.

`amountMicros` is for a **what it cost** meter and is what you are charging for
those units, in millionths — 2,520,000 is £2.52. Leave it off for a counted
meter, where the tiers do the pricing. Send a fraction and it is refused rather
than rounded: a silently dropped amount is a period that bills less than it
should and says nothing about it.

Recording usage needs **its own permission**, `subscriptions:meter`, and
nothing else. So make your script an API key under **Users → API keys** with
only that permission ticked, and send it as `Authorization: Bearer` with each
batch. It should be able to add up gigabytes without also being able to cancel
every subscription you have, and a key that carries one permission can't.

A batch holds up to 200 readings. Send more in another batch, with its own
reference.

### What you can see

- **The subscriber's own page** shows what they have used so far and what it has
  come to, beside the next invoice.
- **Their record here** lists every reading, with the batch it arrived in, and
  lets you add one by hand when a collector was down.
- **Tonight's billing** counts the usage each renewal will carry into its
  figure. A charge on its own clock is in there only when its period ends on
  the renewal day; otherwise it arrives on an invoice of its own.
- **The invoice line** carries the counts — one line per charge, however many
  meters it prices — and the working behind it, tier by tier and meter by meter,
  is kept at the time the invoice is raised. So "why is this £21.40" has an answer
  a year later even if the tier table has been edited since.

### The edges, decided

**A trial's usage is free.** The first invoice is raised the day the trial ends,
and it carries no usage for the free period. "Free for 30 days" that arrives with
a bill for those 30 days is not free.

**A customer who leaves is billed for what they used.** Ending a subscription
raises one last usage invoice for the period just finished, including any
charge that settles on a clock of its own. Nothing else ever would, and the
alternative is giving away every leaving customer's last month.

**A plan can cost nothing a month.** Pay-for-what-you-use is a plan priced at
zero with a usage charge on it; the invoice carries the usage and no subscription
line.

**Repricing a charge changes the period now running**, because usage is billed in
arrear and the tiers are read when the invoice is raised. That is the opposite of
the subscription's own price, which is copied onto each subscriber at signup and
never moves under them. Both are deliberate: a monthly fee is an agreement, and
what a gigabyte costs this month is a price list.

**Retiring a meter keeps billing what is already recorded**, including the period
running now. It stops the meter being offered on new charges. Its code never
changes, so renaming one is safe for the scripts that have been sending it for a
year.

**Readings are whole numbers.** If you need half a gigabyte, meter in megabytes.
Amounts on a *what it cost* charge are the exception and are in millionths, for
the reason above.

## Settings

The module has its own settings screen, and the first question people ask is
what lives there rather than at their payment processor. Cards, payment methods
and receipts belong to the processor and are managed there. What belongs to
your business is how you want the thing to behave:

| Setting | What it decides |
|---|---|
| **Pausing** | Whether a subscription can be paused at all. **Off until you turn it on.** |
| **Changes made mid-period** | Whether a plan change is settled today or simply takes effect at the next renewal. **At their next renewal until you change it.** |
| **Chasing a failed payment** | How long, and how often, a failed card is chased before the subscription is parked |

**Pausing is off by default deliberately.** A paused subscriber pays nothing
and keeps everything the subscription carries, including any discount for
staying subscribed. That suits a gym or a grooming club. It does not suit a
software plan. Turn it on and the control appears in both places a pause can
happen: your own screen, and the subscriber's.

## The customer's own screen

Every subscriber has a private page showing what they subscribe to, where it
stands, when the next payment is and **what the next invoice comes to** — the
amount, with the tax in it, worked out the way the night's run will work it out.
Not the price per period: on a business that quotes net those are different
numbers, and the difference is the thing the customer was left to work out.
Where nothing will be billed — a trial that has not ended, a pause, the last
period of a subscription that is leaving — it says so in a sentence instead of
showing nought.

A subscriber can cancel without emailing you about it, or pause if you allow
pausing — on the link this module sends them, which works on its own. Run the
Shop as well and the same two things are on your storefront, behind a sign-in,
beside everything else they have bought from you. What the storefront can change
it asks Subscriptions to change — a seat count goes through the proration policy
you set here, and the customer sees the figure before agreeing to it. If
Subscriptions is not running, the Shop cannot quote or collect anything: it
records the new count, and that count is on the next invoice the subscription
raises.

## Permissions

Subscriptions uses the same people, roles and permissions as the rest of
Sentrello. There is no second list of accounts.

| Permission | What it allows |
|---|---|
| `subscriptions:read` | See plans and who is on them |
| `subscriptions:manage` | Create plans, move somebody between them, end a membership |
| `subscriptions:meter` | Record what a metered customer used, and nothing else |

Ending somebody's membership is not the same job as raising an invoice for work
done, so it gets its own permission instead of riding on Invoicing's.

**Metering has a third** because what holds it is usually not a person. Whatever
counts your customers' usage posts readings on a schedule, with an API key
somebody put in a cron job, and that key should be able to add up gigabytes
without also being able to cancel every subscription you have.

## Changing a plan mid-cycle

You pick one of two answers under **Changes made mid-period**, and the default
is the one that cannot surprise a subscriber.

**At their next renewal** (the default) charges nothing today. The change waits,
and the new price is simply what the next invoice says. **Straight away**
settles it now: the unused days on the old plan come off at the rate they were
sold at, the days left go on at the new plan's rate, and tax follows each half
separately because tax follows the amount actually charged. An upgrade becomes
an invoice there and then. A downgrade becomes credit that comes off the next
one. Where there is nothing yet to settle, during a trial or before the first
invoice, a change made straight away waits for the renewal too, and the figure
you are shown before confirming says so.

The arithmetic below is what **Straight away** does.

It is correct in all four markets. US sales tax is due on what was
charged. Canadian GST/HST, PST and QST are each a percentage of consideration,
rounded per invoice line the way the CRA permits, and QST's 9.975% is held in
millionths so it survives the arithmetic unrounded to the final cent. UK and EU
VAT is adjusted in the period the change is made — output VAT on an upgrade's
extra consideration, and a reversal on the days a downgrade never supplied.

## Tax, from where the subscriber is

A plan used to carry one rate, and everybody on it paid that rate. Fine for a
gym whose members all live in one town. Less fine when a Texas business bills a
customer in New York, or a Vancouver business bills somebody in Toronto who
owes HST rather than GST and PST.

So every invoice a subscription raises works the tax out from the subscriber's
address: the country and state or province on their company record. That's the
same address your books copy onto the sale for your tax returns. Move a
customer and their next invoice follows them.

**Where you collect is what you've told us, in your own tax rates.** A rate
with a jurisdiction on it (`US-TX`, `US-TX-AUSTIN`, `CA-BC`, `FR`) means you're
registered there. Set them up under Invoicing, the same rates Invoicing offers
on its own invoices. No rate for a place means you aren't registered there, and
the subscriber is charged no tax.

| Subscriber in | What they're charged |
|---|---|
| **A US state** | That state's rate, plus a city or ZIP code rate if you hold one for their address. No rate for the state, no tax. |
| **Canada** | HST in Ontario and the Atlantic provinces. GST everywhere else, plus the province's own PST, RST or QST if you hold a rate for that province. |
| **Your own VAT country** | Your plan's own rate. |
| **Another EU country** | A business with a VAT number is reverse-charged at zero. A consumer pays their own country's rate if you hold one (you're registered for the One Stop Shop), and your home rate if you don't. |
| **Anywhere else** | Nothing, unless you hold a rate for that country. |

**Your plan's own rate is the fallback.** It applies when the subscriber has no
address on file, when their state or province isn't written as its two-letter
code, when your business has no country set, and at home when you've set no
rates with a jurisdiction for your own market. So if you've configured none of
this, every subscriber is billed exactly what they were billed before.

Each tax goes where its return reads it. Where two apply, the invoice line
carries both by name: Texas's 6.25% and Austin's 2% in Austin, GST and QST in
Montreal. Each posts to its own liability account, the one the US sales tax or
Canadian return reads, so nothing needs splitting by hand.

## Chasing a failed card

A subscription business loses more money to failed cards than to cancellations,
so a failed payment is not simply an overdue invoice here. The subscription
itself knows it is in trouble.

It moves `active` to `past_due` once the invoice goes unpaid, emails the
customer promptly rather than weeks later, retries on the schedule you set, and
comes to a stated end: paid at any point and it returns to `active`, retries
exhausted and it becomes `unpaid`. Status shows the trouble on every screen
that already shows status. How long and how often is the **Chasing a failed
payment** setting above.

## What it does not do

- **No refund to the card on a downgrade.** Money owed back becomes a credit
  against the `Customer Credits` account and is spent on the next subscription
  invoice before the card is charged. That is deliberate: the customer is
  still a customer, another invoice is coming, and returning money to a card
  costs you a fee to hand back what you are about to ask for again. When you
  genuinely want to refund, Money's refund path does it.
- **No restating tax on the days already invoiced.** If a tax rate changes
  between the sale and a mid-cycle change, the unused days keep the rate they
  were sold at. Re-reading the rate would restate a supply that has already
  been invoiced, and that is a correction rather than a proration.

## If the module lapses

You keep every subscription you sold. The records are the platform's own,
and nothing is deleted or altered — but **billing stops**. The run that
turns a subscription into an invoice belongs to this module, so when the
module goes, the invoices stop being raised.

It is worth saying plainly, because the alternative is finding out when
somebody notices the money has not arrived.

Nothing is lost by it. Every subscription stands, with its price, its
discount and its next date, and the day the license comes back the run
picks them up and carries on from where it stopped. If you would rather
keep billing without the module, each one can be re-made as a recurring
invoice before you let it go. Recurring invoices come with Pro.

**The subscriber's own page goes too**, and that is the part worth acting on
before rather than after. Pause, resume and cancel reach a subscriber through a
link this module serves, so when the module stops loading the link stops
answering and somebody wanting to cancel has to ask you instead. End the ones
that should end while the screens are still there.
