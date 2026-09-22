---
title: How money is handled
sidebar_position: 8
description: Integer cents and double-entry, and why neither is negotiable.
tags: [money, accounting, invoicing]
---

# How money is handled

Two rules the codebase does not bend on. Get either wrong and a business's
books corrupt quietly, and quietly is the problem. A rounding fault never
announces itself. It shows up as a balance sheet out by four pounds, with
nobody able to say since when.

## Money is integer cents

Every amount is stored as a whole number of the smallest unit, cents or pence,
and never as a floating-point number. `10.00` is stored as `1000`.

Floating point cannot represent most decimal fractions exactly. `0.1 + 0.2` is
famously not `0.3`. A ledger adding thousands of such numbers drifts, by
fractions of a penny at a time: small enough that nobody notices for a year,
large enough that the books no longer balance when somebody finally does.

**Tax rates are millionths.** `99750` is 9.975%, which is Quebec's QST, a real
rate carrying three decimal places and stored exactly. Same reasoning. A rate
is an exact number, so it is kept as one, and the arithmetic stays in whole
integers the whole way through. Tax is applied **per line** rather than to the
invoice total, because a bill with two lines at different rates has two answers
and only one of them is right.

## Bookkeeping is double-entry

Every financial event posts a **balanced journal entry**, or it throws. No path
writes an unbalanced one. Issuing an invoice, recording a payment, raising a
bill, a sale at the counter: all of it goes through one posting function, and
that function refuses anything whose debits and credits disagree.

**The ledger is the source of truth.** Profit and loss, balance sheet, the tax
summary, the dashboard's figures — every one of them is computed from journal
entries, never summed off the invoice table. That is what makes the cash basis
and the accrual basis two readings of one set of books, rather than two sets of
numbers somebody has to reconcile.

It also means a report cannot disagree with the journal behind it. If a figure
looks wrong, the entries that produce it are on screen and can be read.

## Why it is written down here

These are not implementation details you can take or leave. They are why the
books can be trusted, and they are why some things the software could otherwise
do without effort are refused instead. A nicer-looking shortcut that writes
half an entry buys you a corrupted ledger with a pleasant interface.

See [Accounting](/core/accounting) for the screens, and
[Invoicing](/core/invoicing) for what posts to the ledger and when.
