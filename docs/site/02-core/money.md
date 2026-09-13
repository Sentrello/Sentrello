---
title: How money is handled
sidebar_position: 8
description: Integer cents and double-entry, and why neither is negotiable.
tags: [money, accounting, invoicing]
---

# How money is handled

Two rules the codebase does not bend on, because getting either wrong quietly
corrupts a business's books — quietly being the problem. A rounding fault does
not announce itself; it shows up as a balance sheet that is out by four pounds
and nobody able to say since when.

## Money is integer cents

Every amount is stored as a whole number of the smallest unit — cents, pence —
and never as a floating-point number. `10.00` is stored as `1000`.

Floating point cannot represent most decimal fractions exactly. `0.1 + 0.2` is
famously not `0.3`, and a ledger that adds thousands of such numbers drifts. It
drifts by fractions of a penny at a time, which is small enough that nobody
notices for a year and large enough that the books no longer balance when they
do.

**Tax rates are basis points.** `875` is 8.75%. The same reasoning: a rate is an
exact number, so it is stored as one. Tax is applied **per line**, not to the
invoice total, because a bill with two lines at different rates has two answers
and only one of them is right.

## Bookkeeping is double-entry

Every financial event posts a **balanced journal entry**, or it throws. There is
no path that writes an unbalanced one — issuing an invoice, recording a payment,
raising a bill, a sale at the counter, all of it goes through the same posting
function, and that function refuses anything whose debits and credits disagree.

**The ledger is the source of truth.** Every report — profit and loss, balance
sheet, the tax summary, the dashboard's figures — is computed from journal
entries, never summed from the invoice table. That is what makes the cash basis
and the accrual basis two readings of one set of books rather than two sets of
numbers that have to be reconciled.

It also means a report cannot disagree with the journal behind it. If a figure
looks wrong, the entries that produce it are on screen and can be read.

## Why it is written down here

These are not implementation details you can take or leave. They are the reason
the books can be trusted, and they are why some things the software could
otherwise do easily are refused instead — a nicer-looking shortcut that writes a
half-entry is not a shortcut, it is a corrupted ledger with a pleasant interface.

See [Accounting](/core/accounting) for the screens, and
[Invoicing](/core/invoicing) for what posts to the ledger and when.
