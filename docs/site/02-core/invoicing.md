---
title: Invoicing
sidebar_position: 3
description: Quotes, invoices, payments, and getting paid on time.
tags: [core, money]
---

# Invoicing

## Quotes

A quote is a priced offer with an expiry date. Send it as a PDF, or as a link
the customer can accept online. An accepted quote converts to an invoice with
its lines, tax and customer intact.

![The quotes list, showing what is out for decision, until when, and what each is worth](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/quotes.png)

A quote can also be split into **instalments**, a deposit and two stages, say.
That produces several invoices scheduled across the work rather than one large
one at the end.

## Invoices

An invoice has lines, each with a quantity, a unit price and a tax rate. Money
is held in whole cents, so the total always equals the sum of the lines.

Every invoice carries **the date it was issued** as well as the date it falls
due. That distinction earns its keep the week you enter work you did last
month.

Three letterhead layouts to choose from. Payment terms and units are managed
lists, so they read the same on every document.

:::info[An invoice posts to the books when you issue it]
It creates a balanced journal entry: income, and the amount owed to you. There
is no separate bookkeeping to do, and the two cannot disagree.
:::

## Payments

Record a payment in full or in part. A part-paid invoice shows what is
outstanding, and the ledger shows the money received.

**A payment belongs to the day the money arrived**, not the day you got round
to entering it. That is what keeps a month's figures right when you catch up on
a Friday.

Connect a card processor and an invoice can carry a payment link, then
reconcile itself the moment the customer pays.

## Chasing

Overdue invoices are listed on the dashboard, and they can be chased on a
schedule you set: how many days before or after the due date, and what each
reminder says. All of that is in the free tier.

Reminders sent on the free tier carry a small Sentrello credit at the foot.
[Pro](/pro) removes it, so the reminder goes out under your business's name
alone.

## US sales tax

The United States has no national sales tax. Each state sets its own, and
counties, cities and special districts add their share on top. Sentrello
handles that with **named rates that know their jurisdiction**: give a rate a
jurisdiction like `US-TX` or `US-TX-Austin` and it becomes US sales tax,
charged on sales, never reclaimed on purchases, and tracked to its own
liability account so that what you owe Texas never gets mixed up with what you
owe the city.

Several rates can sit on one line. A sale in Austin carries the state rate and
the city rate together, each worked out and rounded on its own, exactly the
way the two filings will want them. Sell in one town and none of this machinery
ever appears: set your combined local rate as the default and carry on.

**Where you owe tax.** You owe a state's sales tax where you have a presence.
You also owe it once your sales into that state pass its *economic nexus*
threshold, which is around $100,000 a year in most of them. Sentrello watches
your out-of-state sales against each state's threshold and warns you on the
invoicing dashboard **before** you cross a line, while there is still time to
talk to your accountant. It never decides for you. Registering is a judgement
call that belongs to you and them.

**Exempt customers.** Resellers, non-profits and government bodies hand you an
exemption certificate and are charged no tax. Record the certificate (number,
state, reason, expiry) and pick it when you invoice them. The sale is then
charged at nothing, and the invoice keeps a reference back to the certificate,
which is exactly the evidence an audit asks for. An expired or revoked
certificate stops working immediately and says so on the screen. Quietly
under-collecting is the mistake that costs you the tax plus penalties later.

**Filing.** For any period, the filing report shows taxable sales and tax
collected per jurisdiction, with the same figure read back from the ledger
beside it so you can watch the two agree. Your exempt sales by state are on it
too. Those are the numbers a state return asks for, and you type them into the
state's portal yourself, once you have checked them.

Rates are yours to maintain, which is workable while you collect in one or two
states. Locality-accurate rates across many states need a data provider.
Sentrello is built so that one can be connected on your own account from
settings, the same way a card processor is.

## Canadian sales tax

Canada charges GST everywhere, HST instead in the harmonised provinces, and in
British Columbia, Saskatchewan, Manitoba and Quebec a provincial tax **beside**
GST, on the same sale. The same jurisdiction idea covers it. Give a rate `CA`
for GST, `CA-ON` for Ontario's HST, `CA-QC` for QST, `CA-BC` for BC's PST, and
Sentrello knows what it is looking at. Two taxes sit on one line where the
province stacks them, each worked out on its own and tracked to its own
liability account, and Quebec's 9.975% is charged as exactly 9.975%.

What makes this worth being careful about is that these are **different taxes
filed to different governments**. GST and HST go to the CRA on one federal
return. QST goes to Revenu Québec, on the same combined form as your GST, but
a separate tax with a separate net. A PST province's tax goes to that
province, separately again. The taxes also behave differently on your own
purchases. GST, HST and QST you pay your suppliers **comes back** as input tax
credits on the return. PST does not; it is part of what the thing cost, and no
figure here will ever net it against what you collected.

**Which province's tax?** Where the sale is delivered decides. Goods take the
province they are shipped to, services generally take the customer's address.
Not where you sit.

**Filing.** Accounting → Canadian tax shows, for any period, one card per
government you collect for: the CRA's return with its own line numbers, the QST
return, each province's PST. Each card puts the ledger's figure and your
documents' figure side by side, so you can see them agree before you type
anything into NETFILE or a provincial portal. A credited sale has already come
back off the right return. Charge tax in one province and that one card is all
you will ever see.

## EU VAT and the One Stop Shop

Sell to a consumer in another EU member state and, at first, you charge your
own country's VAT. That holds until your cross-border sales to consumers pass
**€10,000 across the whole union in a calendar year**, either the current one
or the one before it. After that, VAT is due at the rate of your *customer's*
country, on every such sale.

Sentrello watches that line for you, reading it off your issued invoices:
cross-border, unregistered customers, net of VAT, with credit notes
subtracting. Which side of it you are on shows on the invoicing dashboard.
Registering is your decision and your accountant's. What matters here is that
you hear about the threshold rather than discover it.

**Which sales count.** Sales to customers in other member states whose company
record carries no VAT number. A customer with a valid VAT number accounts for
the tax themselves, and a sale at home belongs to your ordinary domestic
return. Neither of those is distance selling.

**The return.** Rather than registering in every country you sell into, you
file one quarterly *One Stop Shop* return through your own member state, and it
covers all of them. **Money → EU OSS return** shows exactly what that return
asks for, for any quarter: for each member state, at each rate you applied, the
taxable amount and the VAT due, in euro, with the total and the date it has to
be in by, which is the last day of the month after the quarter ends. Save it as
a file for your records. The paperwork behind an OSS return has to be
produceable for ten years.

The screen appears once you tell Sentrello you operate in the EU, under
Settings → Tax regimes.

**If your books are not in euro.** The return is filed in euro, and the rate is
not yours to choose. It is the European Central Bank's rate for the last day of
the quarter, or the next day it published. Record that rate under Accounting
and the figures convert exactly. Until you do, Sentrello shows no figures at
all rather than converting at whatever rate happens to be on file. A return
that is plausible and wrong is worse than one that is late.

**Corrections.** A return you have filed cannot be amended. So a credit note
raised against an earlier quarter's invoice appears in the *corrections* panel
of the current return instead, naming the quarter it relates to, which is how
the scheme handles it. Corrections are accepted for three years from the date
the original return was due. One that falls outside that window is flagged
rather than quietly included.

**It computes; it does not file.** Nothing is sent anywhere. You submit the
return through your own member state's portal, and the deadline is yours.

## The catalogue

Products and services you invoice for repeatedly live in a price list, each with
a code, a description and a kind. Add one to an invoice and the rest fills
itself in.

## Deleting

Documents go to a trash you can restore from rather than disappearing. An
invoice that has posted to the ledger cannot vanish at all, since the books
would stop balancing. It is credited instead, which is what an accountant
expects to see.
