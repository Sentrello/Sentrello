---
title: Configure
sidebar_position: 3
description: Your business details, your currency, tax, email and payments.
tags: [setup]
---

# Configure

Almost everything here is set on a screen inside the application, and the
screens are named below as the sidebar names them. One thing is not: the mail
server is part of how the instance is deployed rather than how the business is
run, and it lives in the environment file beside the database URL.

## Your business

**Settings → Your business** holds the name, address, contact details, tax
number and bank details that appear on invoices, quotes and emails. Fill this in
first: an invoice sent before it is set carries a blank letterhead.

**Say which currency your books are kept in while you are there.** It starts as
US dollars, and it is fixed the moment anything is posted to the ledger —
because every figure in the books is held in that currency, so changing it later
would restate all of them rather than relabel them. A minute now, or an export
and a fresh start later.

**Check your timezone while you are there.** It was filled in from your browser
when you claimed the instance, so it is probably already right — and it decides
more than you would think. What day it is where you are is what makes an invoice
late, what puts a payment in September rather than October, and what "nine
o'clock" means to an automation chasing quiet deals on Monday morning. The **Use
mine** button fills it in again from whatever browser you are holding.

Leave it blank and everything is counted in UTC — the days and the times of day
alike, not the clock on the machine Sentrello is installed on. That is on
purpose: what a figure means should not depend on where the box is, and a server
moved between regions should not change what day an invoice was late. But it does
mean a blank box is rarely what anybody wants. Setting it is a five-second job.

## Tax

**Money → Invoice settings** holds your tax rates, what you sell, your payment
terms, and how overdue invoices are chased.

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

Mail is set on the server, in the same environment file as the database — an
API key for a provider, or a plain SMTP host, username and password. The
[self-hosting guide](https://github.com/Sentrello/Sentrello/blob/main/docs/self-hosting.md)
has the variables and an example of each.

**Settings → Connections** tells you whether it is working, and which address
mail goes out as. Until it is set, invoices and password resets cannot be
delivered and overdue invoices are not chased — they are left alone rather than
marked as chased, so nothing is lost by doing this later.

Sentrello sends email as your business, from your own domain, through your own
provider. Nothing routes through us.

## Taking payments

**Settings → Connections** connects a card processor. Authorise it, test the
connection, work in sandbox mode until you are happy, then switch it to live,
all from the screen. Once it is connected, an invoice can carry a payment link
and the customer can pay it online.

## People

**Users → People** is where you invite colleagues and decide what each of them
can see. Every module uses the same accounts and the same permissions; nothing
keeps a separate list of logins. See [Users and access](/core/users-and-access).

## License

**Settings → License and updates** shows which tier this instance is running and which
modules it is entitled to. Paste a key here to turn on Pro or a module. The
features appear in the application you already have, with no second install and
nothing to migrate.

If the license server cannot be reached, the instance keeps working on the last
good token for a grace period, then falls back to the free tier. It never
stops.

**Lost the key?** [sentrello.com/license](https://sentrello.com/license) looks
it up, emails it to the address you bought with, and shows which servers the
license is running on — which is also where you release one after moving to a
new machine.
