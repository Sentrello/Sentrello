---
title: Invoicing
sidebar_position: 3
description: Quotes, invoices, payments, and getting paid on time.
tags: [core, money]
---

# Invoicing

## Quotes

A quote is a priced offer with an expiry date. Send it as a PDF or as a link
the customer can accept online. An accepted quote converts to an invoice with
its lines, tax and customer intact.

A quote can also be split into **instalments** — a deposit and two stages, say —
producing several invoices scheduled across the work rather than one at the end.

## Invoices

An invoice has lines, each with a quantity, a unit price and a tax rate. Money
is held in whole cents, so the total always equals the sum of the lines.

Every invoice carries **the date it was issued** as well as the date it falls
due, which matters when you enter work you did last month.

Choose from three letterhead layouts, and set payment terms and units as
managed lists so they are consistent across every document.

:::info[An invoice posts to the books when you issue it]
It creates a balanced journal entry — income and the amount owed to you. You do
not do the bookkeeping separately, and the two cannot disagree.
:::

## Payments

Record a payment in full or in part. A part-paid invoice shows what is
outstanding, and the ledger shows the money received.

**A payment belongs to the day the money arrived**, not the day you got round
to entering it. That is what keeps a month's figures right when you catch up on
a Friday.

If a card processor is connected, an invoice can carry a payment link and
reconcile itself when the customer pays.

## Chasing

Overdue invoices are listed on the dashboard and can be chased automatically on
a schedule you set — how many days before or after the due date, and what each
reminder says. This is part of the free tier.

Reminders sent on the free tier carry a small Sentrello credit at the foot.
[Pro](/pro) removes it, so the reminder goes out under your business's name
alone.

## US sales tax

There is no national sales tax in the United States — each state sets its own,
and counties, cities and special districts can add their share on top of it.
Sentrello handles this with **named rates that know their jurisdiction**: give
a rate a jurisdiction like `US-TX` or `US-TX-Austin` and it becomes US sales
tax — charged on sales, never reclaimed on purchases, and tracked to its own
liability account so what you owe Texas is never mixed up with what you owe
the city.

Several rates can sit on one line. A sale in Austin carries the state rate and
the city rate together, each worked out and rounded on its own, exactly the
way the two filings will want them. If you sell in one town, none of this
machinery appears: set your combined local rate as the default and carry on.

**Where you owe tax.** You owe a state's sales tax where you have a presence —
and also once your sales into a state pass its *economic nexus* threshold
(around $100,000 a year in most states). Sentrello watches your out-of-state
sales against each state's threshold and warns you on the invoicing dashboard
**before** you cross a line, while there is still time to talk to your
accountant. It never decides for you; registering is a judgement call that
belongs to you and them.

**Exempt customers.** Resellers, non-profits and government bodies hand you an
exemption certificate and are charged no tax. Record the certificate — its
number, state, reason and expiry — and pick it when you invoice them: the sale
is charged at nothing and the invoice keeps a reference to the certificate,
which is exactly the evidence an audit asks for. An expired or revoked
certificate stops working immediately and says so, because quietly
under-collecting is the mistake that costs you the tax plus penalties later.

**Filing.** For any period, the filing report shows taxable sales and tax
collected per jurisdiction, with the same figure read back from the ledger
beside it so you can see the two agree — plus your exempt sales by state.
Those are the numbers a state return asks for; you type them into the state's
portal yourself, after you have checked them.

Rates are yours to maintain, which is workable when you collect in one or two
states. Locality-accurate rates across many states need a data provider, and
Sentrello is built so one can be connected on your own account from settings —
the same way a card processor is.

## Canadian sales tax

Canada charges GST everywhere, HST instead in the harmonised provinces, and —
in British Columbia, Saskatchewan, Manitoba and Quebec — a provincial tax
**beside** GST, on the same sale. The same jurisdiction idea covers it: give a
rate `CA` for GST, `CA-ON` for Ontario's HST, `CA-QC` for QST, `CA-BC` for
BC's PST, and Sentrello knows what it is. Two taxes sit on one line where the
province stacks them, each worked out on its own and tracked to its own
liability account, and Quebec's 9.975% is charged as exactly 9.975%.

The part worth being careful about is that these are **different taxes filed
to different governments**. GST and HST go to the CRA on one federal return.
QST goes to Revenu Québec — filed on the same combined form as your GST, but
a separate tax with a separate net. A PST province's tax goes to that
province, separately again. And the taxes behave differently on your own
purchases: GST, HST and QST you pay your suppliers **comes back** as input
tax credits on the return; PST does not — it is simply part of what the thing
cost, and no figure here will ever net it against what you collected.

**Which province's tax?** Where the sale is delivered decides — goods take the
province they are shipped to, services generally take the customer's address.
Not where you sit.

**Filing.** Accounting → Canadian tax shows, for any period, one card per
government you collect for: the CRA's return with its own line numbers,
the QST return, each province's PST — with the ledger's figure and your
documents' figure side by side so you can see them agree before you type
anything into NETFILE or a provincial portal. A credited sale has already
come back off the right return. If you charge tax in one province, that is
the only card you will ever see.

## EU VAT and the One Stop Shop

Sell to a consumer in another EU member state and, at first, you charge your
own country's VAT. That holds until your cross-border sales to consumers pass
**€10,000 across the whole union in a calendar year** — the current one or the
one before it. After that, VAT is due at the rate of your *customer's*
country, on every such sale.

Sentrello watches that line for you from your issued invoices — cross-border,
unregistered customers, net of VAT, credit notes subtracting — and says on the
invoicing dashboard which side of it you are on. Registering is your decision
and your accountant's; the point is that you hear about it rather than
discover it.

**Which sales count.** Sales to customers in other member states whose company
record carries no VAT number. A customer with a valid VAT number accounts for
the tax themselves, and a sale at home is your ordinary domestic return's
business — neither is distance selling.

**The return.** Rather than registering in every country you sell into, one
quarterly *One Stop Shop* return covers all of them, filed through your own
member state. **Money → EU OSS return** shows exactly what that return asks
for, for any quarter: for each member state, at each rate you applied, the
taxable amount and the VAT due, in euro, with the total and the date it has to
be in by — the last day of the month after the quarter ends. Save it as a file
for your records; the paperwork behind an OSS return has to be produceable for
ten years.

The screen appears once you tell Sentrello you operate in the EU, under
Settings → Tax regimes.

**If your books are not in euro.** The return is filed in euro, and the rate is
not yours to choose: it is the European Central Bank's for the last day of the
quarter, or the next day it published. Record that rate under Accounting and
the figures convert exactly. Until you do, Sentrello shows no figures rather
than converting at a rate that happens to be on file — a return that is
plausible and wrong is worse than one that is late.

**Corrections.** A return you have filed cannot be amended. A credit note
raised against an earlier quarter's invoice therefore appears in the
*corrections* panel of the current return, naming the quarter it relates to,
which is how the scheme handles it. Corrections are accepted for three years
from the date the original return was due, and one that falls outside that
window is flagged rather than quietly included.

**It computes; it does not file.** Nothing is sent anywhere. You submit the
return through your own member state's portal, and the deadline is yours.

## The catalogue

Products and services you invoice for repeatedly live in a price list, each with
a code, a description and a kind. Adding one to an invoice fills in the rest.

## Deleting

Documents go to a trash you can restore from, rather than disappearing. An
invoice that has posted to the ledger cannot simply vanish — the books would no
longer balance — so it is credited instead, which is what an accountant expects
to see.
