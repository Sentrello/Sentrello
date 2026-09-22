---
title: Configure
sidebar_position: 3
description: Your business details, tax, email and payments — all from a screen.
tags: [setup]
---

# Configure

**Settings**, inside the application, is where Sentrello's behaviour is set.
Nothing about how the product works is changed by editing a file on the server.
If it is configurable, it has a screen.

## Your business

**Settings → Business** holds the name, address, contact details, logo and
registration numbers that appear on invoices, quotes and emails. Fill this in
first: an invoice sent before it is set carries a blank letterhead.

**Set your timezone while you are there.** It decides what "nine o'clock" means
for everything that acts at a time of day, whether that is an automation
chasing quiet deals on Monday morning or a report of yesterday. Leave it blank
and the server's own clock is used. For a computer sitting in your office that
is the right answer; for one rented in another country it is how a Monday chase
goes out on Sunday evening. The **Use mine** button fills in whatever your
browser says, which is usually what you wanted.

## Money

**Settings → Money** sets your currency, your financial year end, and your tax
rates.

Tax rates are stored in millionths. 99750 means 9.975%, which is Quebec's QST,
and storing it that way keeps it exact rather than rounded, three decimal
places and all. Money itself is held in whole cents and never as a fraction.
That is why a total always agrees with the sum of its lines.

:::info[Every financial event is double-entry]
An invoice, a payment, a bill, an expense: each posts a balanced journal entry.
The ledger is the source of truth. Reports are read from it rather than
recalculated, and that is what makes the books stand up to an accountant.
:::

## Email

**Settings → Email** connects the server that sends your invoices and
notifications. Enter the host, port, username and password your mail provider
gave you, then send a test message from the same screen before you rely on it.

Sentrello sends email as your business, from your own domain, through your own
provider. Nothing routes through us.

## Taking payments

**Settings → Payments** connects a card processor. Authorise it, test the
connection, work in sandbox mode until you are happy, then switch it to live,
all from the screen. Once it is connected, an invoice can carry a payment link
and the customer can pay it online.

## People

**Users → People** is where you invite colleagues and decide what each of them
can see. Every module uses the same accounts and the same permissions; nothing
keeps a separate list of logins. See [Users and access](/core/users-and-access).

## Licence

**Settings → Licence** shows which tier this instance is running and which
modules it is entitled to. Paste a key here to turn on Pro or a module. The
features appear in the application you already have, with no second install and
nothing to migrate.

If the licence server cannot be reached, the instance keeps working on the last
good token for a grace period, then falls back to the free tier. It never
stops.
