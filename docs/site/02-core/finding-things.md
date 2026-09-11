---
title: Finding things
sidebar_position: 7
description: One box that searches everything — customers, invoices, orders, files, bookings.
tags: [core, search]
---

# Finding things

Press **⌘K** — or **Ctrl-K**, or the **Find anything** button in the header —
and type. Two letters is enough.

![Searching from any screen](../../images/find-anything.png)

It searches everything this instance has, in one list:

| What | Found by |
|---|---|
| **Contacts** | Name, email, phone |
| **Companies** | Name |
| **Deals** | Their own name, the company, the contact |
| **Invoices** | Number, and the customer's name |
| **Products** | Name and SKU |
| **Orders** | Number, customer, email |
| **Documents** | Name |
| **Bookings** | Customer name, email, phone |

Whatever this instance has. A business without the Shop module sees no products,
because there are none — not because the search is hiding them.

## It opens the thing

Press Enter on a result, or click it, and you land on **that record** — not on
the list it lives in. Arrow keys move between results.

Searching an order number and being taken to a list of every order, to find it
again by eye, is most of the work searching is meant to remove.

## What you can see

**You only find what you could already open.** Search asks each part of the
system whether you are allowed it *before* asking what it has — so somebody who
cannot open the customer book does not find customers in here, and the question
is never even put to the database.

A contractor with access to one project searching for a supplier's name finds
nothing, which is the same answer they would get by looking.

## Why something is not in the list

**Two letters minimum.** One letter is every record in the business.

**Only what is stored.** Search looks at names, numbers and addresses — the
things a record is identified by. It does not read the inside of a document, the
body of a note, or an attachment.

**Deals are the exception worth knowing about.** A deal is found by its company
and its contact as well as its own name, because a deal's own name is the least
memorable thing about it: people say "the Henderson job", meaning whoever it is
for.

## Ranking

An exact match comes first, then one that starts with what you typed, then one
that contains it. That order is shared across every kind of record, so a contact
called Ruth beats a deal whose notes mention her — whichever part of the system
each came from.
