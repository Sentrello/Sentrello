---
title: Configure
sidebar_position: 2
description: Your business details, tax, email and payments — all from a screen.
tags: [setup]
---

# Configure

Everything about how Sentrello behaves is set from **Settings** inside the
application. You do not edit files on the server to change how the product
works — if something is configurable, there is a screen for it.

## Your business

**Settings → Business** holds the name, address, contact details, logo and
registration numbers that appear on invoices, quotes and emails. Fill this in
first: an invoice sent before it is set carries a blank letterhead.

## Money

**Settings → Money** sets your currency, your financial year end, and your tax
rates.

Tax rates are stored in basis points — 875 means 8.75% — so a rate is exact
rather than a rounded decimal. Money itself is held in whole cents and never as
a fraction, which is why totals always agree with the sum of their lines.

:::info[Every financial event is double-entry]
An invoice, a payment, a bill, an expense: each posts a balanced journal entry.
The ledger is the source of truth, and reports are read from it rather than
recalculated. It is what makes the books stand up to an accountant.
:::

## Email

**Settings → Email** connects the server that sends your invoices and
notifications. Enter the host, port, username and password your mail provider
gave you, then send a test message from the same screen before relying on it.

Sentrello sends email as your business, from your own domain, using your own
provider. Nothing routes through us.

## Taking payments

**Settings → Payments** connects a card processor. Authorise it, test the
connection, work in sandbox mode until you are happy, then switch it to live —
all from the screen. Once connected, invoices can carry a payment link and
customers can pay them online.

## People

**Users → People** is where colleagues are invited and what they can see is
decided. Every module uses the same accounts and the same permissions; nothing
keeps a separate list of logins. See [Users and access](/core/users-and-access).

## Licence

**Settings → Licence** shows which tier this instance is running and which
modules it is entitled to. Paste a key here to unlock Pro or a module — the
features appear in the application you already have, with no second install and
nothing to migrate.

If the licence server cannot be reached, the instance keeps working on the last
good token for a grace period, then falls back to the free tier. It never
stops.
