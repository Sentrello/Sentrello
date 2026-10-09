---
title: Free vs Pro
sidebar_position: 3
description: Line by line, what the free core does and what paying adds.
tags: [pro, free, pricing]
---

# Free vs Pro

The **free core** is the public repository: AGPLv3, no license key, no expiry,
and no per-person charge on any tier. A real product, not a trial.

**Pro** is a subscription. What it opens is the paid half of the modules
already sitting in the core, the same screens taken further. It is also the
only way to buy the optional modules, which are not sold against the free core.

Pro is **per instance, not per person**. Hiring somebody costs nothing.

One limit, and it is not a commercial one: an instance holds five hundred
people. It is there so a runaway invite loop cannot fill the table, it is the
same on both tiers, and a business with twenty-five staff will never meet it.

| | Free | Pro |
|---|:---:|:---:|
| **Users** | no per-person charge | no per-person charge |
| **Dashboard**: money owed and how late it is, what needs answering, server health | ● | ● |
| **CRM**: contacts, companies, deals board, activities, tasks, notes, tags, attachments, inbound email, CSV in and out | ● | ● |
| Defining a custom field. Values in the fields you already have stay readable and editable on Free | — | ● |
| 360° customer timeline: activities, invoices and payments in one stream | — | ● |
| **Forms**: contact and quote forms embedded on any site, origin allow-list, rate limiting, honeypot | ● | ● |
| **Quotes and invoices**: per-line tax, partial payments, sequential numbering, quote-to-invoice, early-payment discount, merge drafts, price list, CSV export | ● | ● |
| Shareable invoice page the customer opens without an account | ● | ● |
| Recurring invoices | — | ● |
| Credit notes | ● | ● |
| Online payments: card checkout straight from the invoice | — | ● |
| Customer statements, and the aged receivables and payables reports | — | ● |
| **Accounting**: chart of accounts, money in and out, double-entry journal, profit & loss, balance sheet, cash *or* accrual basis | ● | ● |
| Bills, vendors and vendor credits: the purchase side of the books | — | ● |
| Live bank feeds, CSV import and reconciliation | — | ● |
| Budgets, fixed assets and depreciation | — | ● |
| **Tax returns**: UK VAT in the Making Tax Digital boxes, Canadian GST/HST, US sales tax with state nexus thresholds, EU One Stop Shop | ● | ● |
| **Structured e-invoices**: EN 16931, in the Peppol BIS and XRechnung profiles — for a business selling from the EU or the UK | ● | ● |
| Tax summary, cash flow and multi-currency | — | ● |
| **Accounts and access**: thirteen policies and seven groups, all editable; sessions, sign-in providers, two-factor, event log | ● | ● |
| **Settings**: business details on every document, third-party connections, one-click update and rollback | ● | ● |
| **Automations**: rules on your own records, so that when a deal is won a task appears, an email goes out, and a field updates itself, without anybody remembering to do it | — | ● |
| Your own credit on public pages: replace or remove "Powered by Sentrello" on the sign-in screen and thank-you pages | — | ● |
| **Optional modules**: Booking, Shop, Subscriptions, Projects, Links, Newsletter, Documentation, Storage, SEO | — | available to subscribe |
| Self-hosted, your database, no per-seat pricing | ● | ● |

## What Pro does not change

Paying moves nothing. Same instance, same database, same server; more of the
screens work, and no per-seat charge ever appears.

Drop back to free and nothing is deleted. Every record stays in your database,
and every entry Pro posted stays in the books. The Pro screens stop, so what
only they show (a bill, a budget, a recurring schedule) waits there until a
license is back, and a backup carries all of it in the meantime. That is the
whole of what stops.

## The optional modules

Each is a whole application rather than a feature, sold separately on top of
Pro. Against the free core they are not available at all. [Modules](/modules)
says what each one does.

The **POS is not among them.** It is in development, it is not for sale, and no
date is promised for it — see [POS](/modules/pos). When it returns, it returns
as a **plugin** rather than a module: it extends the Shop and does nothing
without it, which is why the Shop has to sit alongside it. Its price will be
set when it returns.

## How money is handled

Two rules the codebase does not bend on, in either tier:
[integer cents and double-entry bookkeeping](/core/money).
