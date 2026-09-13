---
title: Free vs Pro
sidebar_position: 2.5
description: Line by line, what the free core does and what paying adds.
tags: [pro, free, pricing]
---

# Free vs Pro

The **free core** is the public repository: AGPLv3, unlimited users, no licence
key, no expiry. It is a real product, not a trial.

**Pro** is a subscription that unlocks the paid half of the modules already in
the core — the same screens, opened up — and gives you access to buy the
optional modules, which are not sold on their own.

Pro is **per instance, not per person**. Hiring somebody costs nothing.

| | Free | Pro |
|---|:---:|:---:|
| **Users** | unlimited | unlimited |
| **Dashboard** — money owed, overdue, what needs answering, server health | ● | ● |
| **CRM** — contacts, companies, deals board, activities, tasks, notes, tags, attachments, custom fields, inbound email, CSV in and out | ● | ● |
| 360° customer timeline — activities, invoices and payments in one stream | — | ● |
| **Forms** — contact and quote forms embedded on any site, origin allow-list, rate limiting, honeypot | ● | ● |
| **Quotes and invoices** — per-line tax, partial payments, sequential numbering, quote-to-invoice, early-payment discount, merge drafts, price list, CSV export | ● | ● |
| Shareable invoice page the customer opens without an account | ● | ● |
| Recurring invoices | — | ● |
| Credit notes | — | ● |
| Online payments — card checkout straight from the invoice | — | ● |
| Customer statements and AR aging | — | ● |
| **Accounting** — chart of accounts, money in and out, double-entry journal, profit & loss, balance sheet, cash *or* accrual basis | ● | ● |
| Bills, vendors and vendor credits — the purchase side of the books | — | ● |
| Live bank feeds, CSV import and reconciliation | — | ● |
| Budgets, fixed assets and depreciation | — | ● |
| Tax summary, cash flow and multi-currency | — | ● |
| **Accounts and access** — five policies, four groups, all editable; sessions, sign-in providers, two-factor, event log | ● | ● |
| **Settings** — business details on every document, third-party connections, one-click update and rollback | ● | ● |
| **Projects** — tasks, boards, milestones and time against work | — | ● |
| **Optional modules** — Booking, Shop, POS, Subscriptions, Links, Newsletter, Documentation, Storage, SEO | — | available to subscribe |
| Self-hosted, your database, no per-seat pricing | ● | ● |

## What Pro does not change

Paying does not move your data, change where it runs, or add a per-seat charge.
The same instance, the same database, the same server — more of the screens
work. Dropping back to free leaves every record you created in place, still
readable and still exportable; the Pro screens simply stop.

## The optional modules

Each is a whole application rather than a feature, sold separately on top of
Pro. They are not available against the free core. See
[Modules](/modules) for what each one does.

One of them is a **plugin** rather than a module: the POS extends the Shop and
does nothing without it, so it is half a module's price and needs the Shop
alongside it.

## How money is handled

Two rules the codebase does not bend on, in either tier —
[integer cents and double-entry bookkeeping](/core/money).
