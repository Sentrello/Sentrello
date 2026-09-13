---
title: Subscriptions
sidebar_position: 6
description: Sell the same thing every month, and let a customer manage their own.
tags: [module, subscriptions, invoicing]
---

# Subscriptions

A wash club, a box every fortnight, a retainer, a membership, a monthly round.
Selling the same thing every month is a different business from selling a thing
once: what it costs you is not the making, it is knowing who is on which plan,
whose trial ends this week, and who has given notice.

**It does not need the Shop.** Subscriptions bills contacts through Invoicing,
which you already have. A gym, an agency on a retainer, an MSP and a window
cleaner can all use it without ever selling anything online.

## What it is built on

Nothing new. A subscription raises an invoice on the schedule Invoicing already
owns, and that invoice posts to the ledger like any other — one set of books,
one place money is recognised, one place it is chased from.

That is deliberate. Two things that each believe they own a renewal is how
somebody gets charged twice.

## Plans

**A plan is an item on your price list with a billing interval on it** — not a
separate catalogue. It is priced and taxed exactly like anything else you sell,
because a second catalogue would be a second answer to what a thing costs.

Anything already on the price list can be promoted to a plan without retyping
its price, and a plan can carry a tax like any other line.

Withdrawing a plan does not disturb anybody on it. Subscribers keep the price
and the dates they agreed to.

## Subscribers

A subscriber is a contact, a plan, and the price they agreed to. The price is
copied onto the subscription when they sign up rather than read from the plan
each period: raising your prices does not raise them for the people who joined
last year, and a plan edited on a Tuesday must not silently rebill everybody on
Wednesday.

| State | What it means |
|---|---|
| **Trialling** | On a plan, not yet billed |
| **Active** | Billed on schedule |
| **Paused** | Not billed, not cancelled, keeps its place |
| **Cancelled** | Ends on a date; it is not a switch thrown today |

Cancelling sets the date it takes effect rather than stopping the billing that
instant. Somebody who cancels on the 3rd of a month they have already paid for
keeps the rest of it — which is what they expect, and what avoids a refund.

## The customer's own screen

If you also run the Shop, a subscriber can sign in to your storefront and pause
or cancel their own subscription without emailing you about it. This works
whether or not the Shop is installed — the Shop reads the subscription rows, not
the other way round.

## Permissions

Subscriptions uses the same people, roles and permissions as the rest of
Sentrello. There is no second list of accounts.

| Permission | What it allows |
|---|---|
| `subscriptions:read` | See plans and who is on them |
| `subscriptions:manage` | Create plans, move somebody between them, end a membership |

Ending somebody's membership is deliberately not the same job as raising an
invoice for work done, so it has its own permission rather than riding on
Invoicing's.

## What it does not do

- **No proration mid-period.** Changing a plan takes effect at the next renewal.
- **No usage-based or metered billing.** A plan has a price, not a meter.
- **No dunning beyond Invoicing's own reminders.** A failed payment is chased
  the way an overdue invoice is chased.
- **No mid-period upgrade credit.** Moving somebody to a dearer plan takes
  effect at their next renewal.

## If the module lapses

You keep every subscription you sold. The records are the platform's own, the
schedule goes on raising invoices, and what you lose is the screens for changing
one — which you then manage as recurring invoices, the way it worked before.
