---
title: What it looks like
sidebar_position: 1
description: A tour of the free core, screen by screen, from a real instance.
tags: [tour, core]
---

# What it looks like

Everything below is **one install, one server, one login**, and nothing on this
page needs a licence key.

The screens are rendered from the application's own stylesheet and components,
with a demo business in them — so the chrome, the type, the status colours and
the way money is set are the product's, because they are the product's code.
Every one is drawn as a free instance draws it: no Bills, no bank feeds, no
recurring invoices, because those are not yours until you pay for them, and a
tour of the free tier showing paid features would be a tour of something you
cannot have.

## Dashboard

What is owed, what is overdue, what needs answering. Plus how the server itself
is holding up, which is your problem when the server is yours.

![Money owed, overdue invoices, pipeline value and the server's own health](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/dashboard.png)

## CRM

Contacts, companies, activities, tasks, notes and tags, with CSV import and
export so nothing is a one-way door.

![The contact book, searchable and filterable](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/contacts.png)

The pipeline is a board, and every column carries what it is worth.

![Deals as a five-column board with per-stage totals](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/deals.png)

## Quotes and invoicing

Quotes go out, get accepted, and convert into an invoice without being retyped.

![Quotes with status, customer and value](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/quotes.png)

Invoices have per-line tax, sequential numbering, partial payments and a
discount for paying early, and several drafts can be merged into one bill.
Issue one and it posts to the ledger there and then.

![Invoices with status, due dates and totals](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/invoices.png)

## Accounting

A chart of accounts, money in and out, and a profit and loss and balance sheet
for any period. Cash basis or accrual basis, out of the same books.

![Profit and loss and balance sheet, computed from journal entries](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/accounting.png)

Underneath sits a real double-entry journal. Every figure on the screen above
is derived from these entries. Every entry balances, or it was never written.
[How money is handled](/core/money) says why that is not negotiable.

![The journal, entry by entry, with debits and credits](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/journal.png)

## Forms

Contact and quote forms you embed on any website, posting straight into your own
instance. Origin allow-list, rate limiting and a honeypot, because they face the
internet by design.

![Embeddable forms with their allowed sites and submission counts](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/forms.png)

## Accounts and roles

Five policies out of the box: Admins, Executives, Managers, Staff, and an
external Customers policy that only ever sees its own invoices. Four groups as
well, for Sales, Marketing, Accounting and Customer Service. All of it is data
you can edit, copy or throw away.

A **policy** is how senior somebody is, given to a person directly. A **group**
is what department they are in, so moving somebody between departments is one
change, not nine.

![Roles and groups, each with the permissions it grants](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/roles.png)

## Settings

Your business name, address and tax number, which appear on every invoice,
quote and customer page you send. Third-party connections live here too,
alongside one-click updates, rollback, and the list of modules installed.

![Business details, used on every document the business sends out](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/settings.png)

---

Next: [what Pro adds](/free-vs-pro), or [install it](/getting-started/install).
