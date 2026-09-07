---
title: Shop
sidebar_position: 3
description: Sell online, with the orders and the money landing in the same system.
tags: [module, shop]
---

# Shop

An online shop whose orders arrive as records in the business you already run,
rather than in a separate system you reconcile at the end of the month.

## Products

Products with descriptions, images, prices and stock levels. Variants — sizes,
colours — are handled as options on one product rather than as separate
products that drift apart.

Stock decrements when an order is placed and shows on the product screen. A
product can be hidden without deleting it.

## The storefront

A public shop, listing pages and product pages, that works on a phone. It uses
your business's name, logo and details from Settings.

## Orders

An order records what was bought, by whom, at what price, and where it is going.
It starts **pending**, becomes **paid** when the money is confirmed with the
processor rather than when the buyer comes back from it, and becomes
**fulfilled** once everything on it has been despatched — a part-despatched
order says so rather than pretending to be complete. Orders can also be
**cancelled** or **refunded**, and a refund puts the money back through the
books as its own entry.

A **customer is created or matched** in the CRM, so somebody who orders twice
is one customer with two orders.

## Payment

Connect a card processor in **Settings → Payments** — authorise, test in
sandbox, then go live. The same connection serves invoicing, so it is set up
once for the whole business.

## Where the money goes

A paid order posts to the ledger like any other income: the sale, the tax and
the money received. The books include the shop without anyone entering
anything twice.

:::info[New in 0.19]
The processor's fee is recorded too, so Cash matches the bank. A card sale of
$100.00 puts about $96.80 in your account; from 0.19 the books say $96.80 and
put the $3.20 in **Payment Processing Fees**, instead of showing $100.00 and
leaving you to reconcile the gap by hand. Where a processor has not reported
the fee yet, the sale posts as it did before — nothing is guessed.
:::
