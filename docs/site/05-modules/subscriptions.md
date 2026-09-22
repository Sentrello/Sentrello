---
title: Subscriptions
sidebar_position: 8
description: Sell the same thing every month, and let a customer manage their own.
tags: [module, subscriptions, invoicing]
---

# Subscriptions

A wash club. A box every fortnight, a retainer, a membership, a monthly round.
Selling the same thing every month is a different business from selling a thing
once, and what it costs you is not the making. It is knowing who is on which
plan, whose trial ends this week, who is paused, and who has given notice.

**It does not need the Shop.** Subscriptions bills contacts through Invoicing,
which you already have. A gym, an agency on a retainer, an MSP and a window
cleaner can all run on it without ever selling anything online.

## What it is built on

Nothing new. A subscription raises an invoice on the schedule Invoicing already
owns, and that invoice posts to the ledger like any other: one set of books,
and one place money is both recognised and chased from.

That is deliberate. Two things that each believe they own a renewal is how
somebody gets charged twice.

## Plans

**A plan is an item on your price list with a billing interval on it.** There
is no second catalogue. It is priced and taxed exactly like anything else you
sell, because a second catalogue would be a second answer to what a thing
costs.

Anything already on the price list can be promoted to a plan without retyping
its price, and a plan can carry a tax like any other line.

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
| **Paused** | Not billed, not cancelled, keeps its place — if you allow pausing |
| **Cancelled** | Ends on a date; it is not a switch thrown today |

Cancelling sets the date it takes effect rather than stopping the billing that
instant. Somebody who cancels on the 3rd of a month they have already paid for
keeps the rest of it, which is what they expect and what avoids a refund.

## Settings

The module has its own settings screen, and the first question people ask is
what lives there rather than at their payment processor. Cards, payment methods
and receipts belong to the processor and are managed there. What belongs to
your business is how you want the thing to behave:

| Setting | What it decides |
|---|---|
| **Allow pausing** | Whether a subscription can be paused at all. **Off until you turn it on.** |
| **Proration** | Whether a mid-cycle plan change settles now or on the next bill. **Next bill until you change it.** |
| **Chasing a failed payment** | How long, and how often, a failed card is chased before the subscription is parked |

**Pausing is off by default deliberately.** A paused subscriber pays nothing
and keeps everything the subscription carries, including any discount for
staying subscribed. That suits a gym or a grooming club. It does not suit a
software plan. Turn it on and the control appears in both places a pause can
happen: your own screen, and the subscriber's.

## The customer's own screen

Run the Shop as well and a subscriber can sign in to your storefront to cancel
their own subscription without emailing you about it, or pause it if you allow
pausing. This works whether or not the Shop is installed. The Shop reads the
subscription rows; nothing flows the other way.

## Permissions

Subscriptions uses the same people, roles and permissions as the rest of
Sentrello. There is no second list of accounts.

| Permission | What it allows |
|---|---|
| `subscriptions:read` | See plans and who is on them |
| `subscriptions:manage` | Create plans, move somebody between them, end a membership |

Ending somebody's membership is not the same job as raising an invoice for work
done, so it gets its own permission instead of riding on Invoicing's.

## Changing a plan mid-cycle

Two settings decide what happens, and the default is the one that cannot
surprise a subscriber.

**Next bill** (the default) leaves today's invoice alone and settles the
difference on the next one. **Immediate** raises the adjustment there and then.
Either way the arithmetic is the same: the unused days on the old plan come off
at the rate they were sold at, the new terms go on at the new plan's rate, and
tax follows each half separately because tax follows the amount actually
charged.

That treatment is correct in all four markets. US sales tax is due on what was
charged. Canadian GST/HST, PST and QST are each a percentage of consideration,
rounded per invoice line the way the CRA permits, and QST's 9.975% is held in
millionths so it survives the arithmetic unrounded to the final cent. UK and EU
VAT is adjusted in the period the change is made — output VAT on an upgrade's
extra consideration, and a reversal on the days a downgrade never supplied.

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

- **No usage-based or metered billing.** A plan has a price, not a meter. If
  what you sell varies by how much somebody used, this is the wrong module and
  raising the invoices yourself is the right answer.
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

You keep every subscription you sold. The records are the platform's own and
the schedule goes on raising invoices. What you lose is the screens for
changing one, which you then manage as recurring invoices, the way it worked
before.
