---
title: POS
sidebar_position: 5
description: Sell face to face, on the same products, prices and books as the shop.
tags: [module, pos, shop]
---

# POS

:::caution[In development — not for sale]

The POS was withdrawn from the catalog on 15 September 2026 and cannot be
bought today. There is no date, deliberately: this page describes how it works
rather than something you can subscribe to yet.

Most of what the withdrawal was waiting for is now built — the screens it is
actually used on, table service, the kitchen pass, a receipt that carries what
each of the four markets requires, and the code for paper: a receipt printer,
chits in the kitchen, a drawer, and a card reader the till talks to.

**None of the hardware has met a real device.** Printer, drawer and reader are
driven end to end by a test harness, which proves the exchange and cannot prove
the firmware: what a real printer does with a media type it dislikes, whether a
particular drawer answers the kick, how a reader behaves when somebody taps
twice. We expect the devices in the middle of November 2026. Until each one has
been used over a counter, nothing on this page about paper or cards is a
promise, and that — rather than the list under
[What is not here yet](#what-is-not-here-yet) — is what the till is waiting
for.

**There are no screenshots on this page**, deliberately. The ones that were here
showed a till with a Cash button and no Card, an open cash count with the
expected figure printed above the box, and a sidebar the product replaced in
September. Every one of those is a thing this page now describes the opposite of,
and a picture that argues with the words beside it is worse than no picture.
They come back with the rebuilt screens.

:::

:::danger[Where this till cannot lawfully be used at all]

Separate from the delay above, and permanent.

Some places require every sale to pass through certified hardware or a live
link to the tax authority, and a well-formed receipt does not satisfy that.
**Quebec has required it of every restaurant, bar and café in the province
since 31 May 2025** — the WEB-SRM regime. Germany's TSE signature, France's
certified-software rule, Italy's transmission to the Agenzia delle Entrate and
Portugal's ATCUD all work the same way.

This till has no fiscal device and no link to a tax authority, and there is no
plan to build one. If you trade somewhere that requires either, **you cannot
use this till for those sales**, whatever else the page below describes. That
is a limit on the markets it is sold into rather than a feature that is coming.

Everywhere else in the United States, Canada, the United Kingdom and the EU, a
receipt is a document and this prints a correct one.

:::


A point of sale for a counter. It sells the same products at the same prices as
your online shop, and it takes the stock off the same shelf and posts the money
to the same books. Sell both ways and you get one set of figures instead of two
that have to be reconciled on a Sunday evening.

The till is the screen somebody rings a sale up on. It is one part of this.
Beside it sit the drawer, the questions a product asks, and the cash-up at the
end of a shift.

**POS needs the Shop module.** This is not a separate product with its own
catalog. It is a second way of selling the one you already have.

## Before you start

Three things, in this order. The first needs a POS subscription, which is what
cannot be bought today — so read this part as what setting the till up will
involve rather than as something to go and do.

1. **Enable Shop and POS** under Settings → Modules.
2. **Add your products** under Shop → Products, and publish them. Anything not
   published does not appear on the till, on purpose: the till shows what is
   for sale, and a draft product is not.
3. **Set a price.** Every product has one — it is asked for when the product is
   created and cannot be left empty — so there is nothing here that can be rung
   up at nothing by accident.

Stock is optional. A product with a stock count is limited by it. A product
with no count is sold without limit, which is right for a coffee made to order
and wrong for the last loaf on the shelf. See
[Stock](#stock-what-a-counter-sale-does) below.

## Ringing up a sale

Tap a product. It goes on the ticket on the right, and the total stays in the
same place whatever else is happening on the screen. That total is the only
number a customer ever asks about.

Tap the same product again and the line becomes a quantity of two rather than a
second row. That is what a second tap means at a counter.

Everything on the ticket is priced as the shop prices it. Change a price under
Shop → Products and the till uses the new one immediately. There is no separate
menu to keep in step.

### More than one sale at once

A counter serves more than one person at a time. Tickets sit in a row above the
products — each one named for the terminal, the day and its place in the day,
like `front-260928-6` — and tapping one brings it back. Take a coffee order,
start a second while the first is being made, come back and take the money.

A ticket stays open until it is paid for. Nothing expires it while somebody is
still standing there.

## Questions: milk, sizes, extras

A till that cannot ask "which milk?" sends a member of staff back to the
counter to ask. Questions are the answer, set up under
**Shop → Point of sale → Questions**.

A question has:

| Field | What it does |
|---|---|
| **Name** | What the question is called — *Milk*, *Size*, *Extras* |
| **Prompt** | What the till actually asks. Defaults to the name |
| **At least** | `1` forces an answer. `0` makes it optional |
| **At most** | `1` for one answer only. Blank for any number |
| **Order** | Where it appears when a product asks several |

A choice has a name, an **extra cost** that may be negative (a discount for
bringing your own cup), and a **strength**: 200% for *extra*, 50% for *light*.
The till prices a double shot of syrup at double, without you creating a second
choice for it.

Then **ask it about a product**. One question can be asked about many products,
since *Milk* belongs on every coffee, and a product can be asked several.

### What it looks like at the counter

When a product has questions, the till asks them before the item goes on the
ticket. All of them on one panel, in front of everything else.

**A required question cannot be skipped.** The button says what is still
missing, *Choose milk*, rather than letting somebody carry on and sending a
half-made order to whoever is making it. That is the whole reason the questions
exist.

Choices with a price are added to the line and shown under it. A receipt can
then say 3.20 for the coffee and 0.50 for the oat milk, instead of a single
number nobody can take apart.

**Two of the same drink made differently are two lines.** A flat white with oat
milk and a flat white without are not one line of two. They are made
differently, priced differently, and handed to different people.

## Taking the money

**Cash is the simplest tender.** Type what the customer handed over and press
Cash; the till works out the change. Leave the box blank for the exact
amount.

The sale then becomes a Shop order. The same order a website sale becomes, with
the same order number series, in the same list under Shop → Orders, posting the
same double-entry journal to the same accounts. There is no second path from a
sale to your books.

**Card is a tender like any other**, including half on the card and the rest in
cash on one sale.

**The till can send the figure to the machine.** Pair a card reader to a
terminal under Point of sale → Serving, choose *Card*, and press *Take it on the
reader*: the amount goes to the reader, the customer taps, and the till shows
what the reader reported. Nobody types a
total twice, and nobody can type it wrong. A till with no reader paired never
shows the button.

The cashier still completes the sale. The reader's job ends at "taken"; one
path leads from a sale to the books and it is the same press that takes cash,
which is why there is no second way for a sale to reach the journal. Reader
support is code against a harness until the hardware arrives in
November 2026.

It also still takes a card the old way, which is not a fallback so much as how
most counters work: the customer taps a machine standing beside the till, and
somebody records the slip. Both paths end in the same order and the same
journal entry.

## The drawer

The drawer is how a business knows its cash is right. It is optional: a
business that never opens one still sells things, and the till never holds up a
sale over bookkeeping nobody asked for.

**Open a drawer** at the start of a shift with the **float**, the money going in
to make change with.

Everything that moves is written down as it happens:

| Line | What it is |
|---|---|
| **Float put in** | What you started the shift with |
| **Cash taken** | Every cash sale on this drawer |
| **Refunded** | Cash handed back |
| **Paid out** | Money spent — milk from the corner shop |
| **Dropped to the safe** | Money moved out of the drawer, still the business's |
| **Should be in the drawer** | All of the above, added up |

**Whether you can see that last line depends on who you are.** A shift holding
only `pos:sell` counts the drawer without being told what to expect — a blind
count, which is the point of counting at all: a figure on the screen is a
number to reconcile toward rather than a check on anybody. A manager, holding
`pos:manage`, sees the expectation. Both of them see the variance once the
count is in, and it is written down against that shift either way.

**Money out needs a reason.** "Where did forty pounds go" is the question a
variance produces, and a note written at the time is the only answer anybody
will ever have. A **payout** is money spent, milk from the corner shop. A
**drop** is money moved to the safe.

**Counted** is the one figure the till does not know. Count the drawer, type
what is actually in it, and press *Count and close*. The difference is worked
out and written down against that shift, as it was at that moment.

A shortfall is reported as a shortfall. It is never rounded away or called
"within tolerance". A figure that hides small differences is a figure everybody
learns to ignore, and then it is worth nothing on the night it is large.

### Printers, and the drawer that opens itself

Add a printer under **Point of sale → Serving → Printers**: a name, how it is
reached, and whether the cash drawer is wired to it. Then press **Test**, which
prints a test page and, if a drawer is wired to the printer, kicks it. The only way to know a printer works is to
have it print, and that is also why this part of the till is not finished: it
has printed for a test harness and not yet for a printer.

**Two ways round, and the default is the one that always works.**

| How it is reached | What it means |
|---|---|
| **It polls us** | The printer asks Sentrello for work every couple of seconds. Nothing is opened on your network, and it works wherever Sentrello is installed. |
| **We dial it** | Sentrello opens a connection to the printer's address. A fraction faster, and it needs the printer on the same network as the server. |

A polling printer is given an address instead of being asked for one. Copy it
into the printer's own settings — the manufacturer calls this CloudPRNT or
server-direct printing — and it starts asking. Until it asks, nothing prints,
and the screen says so plainly rather than leaving you guessing.

That arrangement has a second benefit nobody expects until they need it: there
is a queue. A printer switched off at six o'clock does not lose the evening's
receipts; it collects them when it comes back. And because the printer reports
its own condition on every poll, the screen can tell you the paper has run out
**before** somebody tries to print.

Two kinds, chosen when you add one:

| Prints | Where it goes |
|---|---|
| **Receipts** | What a customer is handed. One till, one printer. |
| **Kitchen chits** | Every round sent to the kitchen, and every cancellation. |

**The drawer is wired to the printer, not to Sentrello.** That is how a counter
is built: the drawer has a solenoid and a plug, and the plug goes in the back of
the receipt printer. So the till opens the drawer by sending the printer a job
with no paper in it. Pin 2 is the near-universal wiring; pin 5 is where a second
drawer on one printer goes.

**It opens on a cash sale and nothing else.** There is no change to give from a
card, so a drawer that opened for every tap would spend the day open. A sale the
till is told about twice — a queue draining after an outage — does not open it
either: a drawer that springs open on its own is the one thing on a counter
nobody can explain. Open it by hand with a **no-sale**, which is logged against the open drawer
with who did it.

**A printer never holds up a sale.** The money is taken, the sale is finished,
and the paper is a second copy of something already true. A printer with no paper
in it says so on the screen and nothing else changes.

:::note[Where the printer has to be]

**Dialling the printer** needs it on the same network as the server, which a
self-hosted instance in the back office is and a rented server in another country
is not. It also cannot be done from the till's own screen instead: a browser
cannot open a socket, and a printer answers plain http, which a page served over
https is not allowed to call.

**A polling printer has none of those problems**, which is why it is the default.
Pick it unless you have a reason not to.

One honest gap in both: a printer plugged into the till by USB cannot be reached
either way, because both of them are addresses on a network. A USB printer with a
small network adapter in front of it works.

:::

### Why a card sale never reaches the drawer

Cash is the only money nobody else is keeping a record of. Behind a card sale
sits a processor's account and a bank statement to reconcile against. Behind a
twenty-pound note sits a person and a box.

So the drawer counts notes, and so does the ledger. A cash sale goes to
**Cash**. A card sale goes to **Payments in Transit**, where it waits until your
processor pays it out to the bank. A sale paid half each way is split the same
way, to the cent. Money off and anything on the house never pass through Cash
at all: they show as Sales Discounts, or as Comps and Staff Meals, and Cash moves only
by money somebody handed over.

## Stock: what a counter sale does

A website order **claims** stock. The goods are still on the shelf, and they
are there until somebody packs a parcel, so the count moves when the parcel
does.

A counter has no parcel. The customer pays and walks out holding it, so a till
sale takes the goods off the shelf at the moment it is rung. The order is
placed, paid and fulfilled in one action.

This is why the Inventory screen has three numbers rather than one:

| Column | What it means |
|---|---|
| **On the shelf** | What is physically there, whoever it belongs to |
| **Claimed by orders** | Spoken for by orders not yet sent |
| **Free to sell** | What the till and the website may still sell |

**Free to sell is the number that decides whether a sale can happen.** Two
loaves on the shelf with two claimed means nought free. The loaves are there,
and they belong to somebody who has already paid for them. The till will refuse
to sell them, correctly.

Products with no stock count at all are never limited. A coffee is made when it
is ordered; there is no shelf to run out of.

## When the connection goes

**A till that stops trading because the broadband went is a till that gets
replaced by a tin.** So it does not stop.

With the line down, the terminal keeps the menu and the questions it last saw.
A sale can still be rung up and cash can still be taken. Each change is written
down as an instruction, *add a flat white to ticket 7*, and sent in order when
the connection comes back.

On a wide screen you will see **Offline · 3 changes waiting to send** across the
top of the till. On a phone the bar along the bottom — the one that carries the
running total and opens the sale — says **Offline · 3 waiting to send** in place
of the item count. And either way the message arrives again where it matters
most, under the sale that was just paid for, as **front-260910-4 paid — waiting
to send**, with a line saying the money is taken and the sale is kept on this
terminal.

Either way a sale paid while the line is down is confirmed with the terminal's
own name for it rather than an order number, because the order number is minted
when it reaches the server.

Some things to know, because they are true rather than because they are
comfortable:

- **The till will not authorise a card itself.** A card taken on a terminal
  standing beside it queues like any other sale: the machine authorised it, in
  front of the customer, without asking us. What would be wrong is the till
  approving a card on its own while it cannot reach anything — handing goods
  over against a payment that might be declined an hour later — and that is not
  what this is.
- **Totals shown offline are advisory.** The server works them out again when
  the queue arrives, and its figures are the ones that reach your books. They
  differ only if a price changed elsewhere while this terminal was dark.
- **Stock is advisory too.** Two tills that cannot see each other can both sell
  the last croissant. That happens in real cafés, and the answer is to notice
  it afterwards rather than to stop both tills.
- **A reload is fine.** The application is held on the device, so opening the
  till again with the line still down gives you the till, with anything it has
  not sent yet still waiting. It does need to have been opened once with a
  connection first. A brand-new device has nothing to hold.
- **If a queued sale is refused** when it finally reaches the server, because
  the last one really had gone, the till says so and names it, so somebody can
  put it right under Shop → Orders. It is never silently dropped.

## Tables, sections, and who served

A counter serves whoever is in front of it. A dining room does not, and the
difference is most of what a restaurant needs from a till.

**Draw the room once** under Point of sale → Floor plan: areas, tables, how
many each seats. Point of sale → Room is then the floor as it stands: which
tables are taken, whose they are, and how long each party has been sitting
there.

**Put a bill on a table** and it stays with that table through everything else:
a second round, a split, a handover at the end of a shift.

**Give a server their section.** On the Room screen, *Looked after by* assigns
tables to one person, and they stay theirs until somebody changes it. A bill opened on one of their tables is
theirs without anybody choosing from a list — which matters at eight in the
evening, when the answer somebody picks in a hurry is whoever is at the top of
it.

Three things can have an opinion about whose bill it is, and they rank:

1. **Whoever is signed in at that till** — they are standing there.
2. **The table's own server**, where nobody has signed in.
3. **The account the device holds**, which is a fallback rather than a person.

So a server who has signed in keeps their bill wherever they seat the party,
and a shared counter with nobody identified attributes to the section rather
than to the business. Only the first table counts, too. Move the party across
the room later and the bill stays with whoever has been looking after them.

## Eat in, takeaway, delivery

Most of what a till rings up is the same food leaving the building in different
ways, and how it leaves decides what the till needs to know. Set those up under
Point of sale → Serving → **Ways you sell**: a name for the button, whether it asks how
many sat down, whether it fires a ticket to the kitchen. One of them is the usual
one, and that is what a sale is rung under unless somebody says otherwise.

Switch on two or more and the till has to ask. **When** it asks is yours:

- **On the first item.** The keypad opens straight away and the answer sits in a
  row above the basket, one tap, changeable until the money goes in. A counter
  wants this — the queue is four deep and the question is almost always the same.
- **Before the sale starts.** Nothing can be rung until somebody has answered.
  One extra tap on every sale, which a counter feels and a dining room does not —
  and in a dining room the answer decides how many sat down and whether the
  kitchen sees the order, so being asked after three items is being asked too
  late.

Pick under Point of sale → Serving → **When the till asks**. With one way of
selling switched on the till never asks either way, which is the screen a shop
that has set none of this up has always seen.

A bill already open is never asked about again: it was rung under something when
it was started, and picking it back up takes you straight to it.

## Who is at the till

Some places give every server their own device. Some share one. Both work, and
the till has to be told which person is ringing a sale either way — or every
evening's takings, and every tip, land against one account.

Under Point of sale → **Who is serving**, give each person a **code** of four to
eight digits, or a **badge** to scan. At the till they tap it between customers.

What that does, and does not, do:

- It **identifies** a person. It is not a password and it opens nothing but the
  till: what somebody may *do* is still their role under Users.
- It **opens their shift** if one is not already open, so hours are recorded
  without a second thing to remember.
- Signing in at another device **moves** their shift rather than opening a
  second one, and ends the shift of whoever was signed in at the till they have
  just walked up to. Tapping in again at the till you're already on changes
  nothing.
- Codes are stored sealed, compared without telling a guesser how close they
  were, and **capped at ten tries a minute from one network address** — so two
  tills behind one router share a budget, and the same till on two networks has
  two. Two people can never share one code.
- The list of who has a code never shows the codes.

## Tips and service charges

Both are off until you turn them on, and that is a market decision rather than
a shy default. Tipping is woven into eating out in the United States and barely
exists in the United Kingdom, where a prompt on a card machine for a sandwich
reads as the shop asking for money.

Everything here lives under Point of sale → **Tips & charges**.

### Tips

- **On or off** for the business. Off means the prompt never appears.
- **Suggested percentages you set**, and none to begin with: an empty list means
  the till asks and suggests nothing, which is what a bar that takes tips and
  would rather not nudge wants.
- **Any amount**, always. Zero is as easy to give as a suggestion, because a
  customer who does not want to tip should not have to work at it.
- **Suggested on the goods before tax, or on the whole bill** — your call, and
  the till says which, right under the tip box.
- A tip **reaches the person who served**, which is why the section above
  exists. It posts as money held for them rather than as takings, and the
  Shifts screen is where somebody hands it over.

### Sharing a tip

Most places share. Some give the whole of it to the server, and plenty of
arrangements in between send a slice to the bar.

Set the shares as percentages that have to add up to the whole. They are
**written onto each tip as it is taken**, so changing the arrangement on a
Tuesday does not quietly restate what somebody was owed on Monday.

A share for the house is allowed and the screen warns you about it, because in
some places keeping part of a voluntary tip is a matter somebody will ask about.
A share for the bar carries no name until the end of a shift, when whoever was
on it is a decision rather than a column — so the bar's, the kitchen's and the
house's shares sit on the Shifts screen as their own figures, and you pick who
takes each one when you hand it over.

### A service charge is not a tip

A mandatory charge — an automatic gratuity on a large party, a flat percentage
on every bill — is part of what is owed rather than a gift. The till treats it
that way: it goes on the bill before tax, it is taxed where tax applies, and it
is posted to its own account so it never reads as a tip somebody is owed.

Set a percentage, a party size it starts at, and **the wording your menu uses**.
That last one is not decoration. In some places a required charge is lawful only
once it has been clearly disclosed in advance, so the words are snapshotted onto
the bill and printed on the receipt as they were at the time — not read back
from a setting somebody has since changed.

A manager can take one off. A table that queries an automatic gratuity is a
conversation that ends with somebody removing it, and a till that could not
would send them to the owner's laptop.

## Joining two bills

Two friends at the bar move to a table. A four becomes a six. Somebody opens a
second bill because the first was on the other terminal.

*Join another bill to this one* takes a list of what is open — never a box to
type a number into — and moves one into the other. Items, notes, and anything
already with the kitchen come across. Identical lines add up; a flat white with
oat milk and one without stay two lines, because somebody has to carry them to
the right person.

The bill that moved closes as joined, keeping its number so anybody who wrote it
on a slip can still find where it went.

It refuses where joining would be a lie: a bill a card reader is holding, a bill
already split, or one of each when one of them is a rehearsal.

## The customer's screen

A counter where the first figure somebody sees is the one they are asked for is
a counter where arguments start.

Pair a second screen under Point of sale → Serving. You get an address to open
once on that device; it then shows the bill as it is rung up — the lines, the
service charge in the words you disclosed, the tax, the total, and what each
suggested tip comes to.

- It **reads one till** and nothing else. No history, no other terminal, no
  staff name, nothing about the day.
- It **writes nothing**: no tender, no tip, no line.
- Once a bill is paid it shows a total and a thank-you, and clears itself after
  a minute and a half rather than holding the last customer's lunch in front of
  the next one.
- The address is the whole key, so treat it like one. *New address* replaces it,
  which is what you press when the tablet has gone.

## Rehearsing before you go live

You cannot learn a till by reading about it, and practising on the real one
leaves journal entries, stock off the shelf and figures in a month's takings.

Point of sale → **Rehearsal mode** gives you the whole till with nothing behind
it. Sales ring up, split, refund, print and cash up exactly as they do live, and
**nothing reaches the books, the stock or any figure** — a rehearsal posts
nothing at all rather than posting something harmless.

- Receipts print saying so, and the sell screen carries a banner. The person
  ringing a sale is not always the person who turned the mode on.
- A bill opened as a rehearsal stays one for its whole life, through a split, a
  refund and a reprint, whatever the setting says by then.
- **A card reader still charges whatever card is presented**, because the money
  is the processor's affair and not ours. The till refuses to send a rehearsal
  to a live reader and tells you to put the processor in test mode first.
- Going live says what it is about to start doing, and how many rehearsal bills
  are still open. Those keep the answer they were opened with.
- **Throw the practice away in one action** when you are done. It deletes the
  rehearsal bills, their orders and the drawers they were rung on, and touches
  no real sale. The Z numbers the practice used are not given back: a gap in the
  readings is the honest record of one.

## What a shift came to

Point of sale → Shifts answers the three questions somebody has at the end of a
night.

**Who was on**, and for how long — hours punched at a till, which is a different
question from who had the cash. Somebody carrying plates all evening never opens
a drawer.

**What one person did.** Open a shift from the list for sold, bills, covers,
spend a head, tips earned and still owed, voids, discounts and anything put on
the house. Sales and covers belong to whoever served the bill; voids and
discounts belong to whoever gave them, because a manager taking money off
somebody else's table has done that and the server has not.

It is not the cash-up, and it will not agree with one on a night where a manager
tendered somebody else's tables. A cash-up balances a box; this says who served
what. Both are right.

**What is owed in tips**, per person and per pool, with a button to hand it
over — which comes out of the drawer open now and leaves it short against its
own card takings. That is correct, and the count knows. Each person's figure is
their share under the arrangement in force when the tip was taken, not the whole
gratuity: the bar's slice is the bar's, and paying the server does not settle it.

Somebody may read their own shift without `pos:manage`, and the till shows it
under **Your shift**: bills, what they sold, and their tips earned and still
owed. A till that makes a server ask a manager what they earned is a till
people keep their own notes beside.

## Who can use it

The till uses the same people, roles and permissions as the rest of Sentrello.
It never has its own logins.

**Three policies arrive with your instance**, so nobody has to invent a cashier:

| Policy | For |
|---|---|
| **Till** | Rings up sales. No cancelling, no refunds, and no sight of what the drawer should hold |
| **Till Supervisors** | The same, plus cancelling a ticket and giving money back — the two doors money leaves by |
| **Till Managers** | The same again, plus setting the till up and seeing the drawer's expected total |

Put your counter staff in the **Till** group and give the person standing behind
them the supervisor policy. Each tier includes the one below it, because a
supervisor who cannot sell is no use on a counter.

Each of those grants read access to the Shop's catalogue as well, which is not
optional: the till's menu *is* that catalogue, and without it the screen is a
refusal rather than a till.

| Permission | What it allows |
|---|---|
| `pos:read` | See the till and the drawer |
| `pos:sell` | Ring up sales, take cash, open and close a drawer |
| `pos:void` | Cancel a ticket |
| `pos:refund` | Give money back |
| `pos:manage` | The manager's half: the questions the till asks, the module's own settings, the receipts list, the list of drawers and a cash-up — and the drawer's expected total, wherever it appears |

That last one is the reason the row is this long. A blind count is only blind
while the person counting cannot see what the till thinks is in the box, so the
expected figure carries this permission rather than the screen does: a counter
shift opens the same drawer screen and gets the drawer, their own payouts and
drops, and no totals. Read it with `pos:manage` and the same screen is the X
report a manager takes mid-shift.

## What is not here yet

Said plainly, because a list of what a product cannot do is more useful than a
list of what it can.

- **A single hour over a real counter.** The printer, the drawer and the card
  reader are driven end to end by a test harness, which proves the conversation
  and proves nothing about a device: a printer declining a media type, a drawer
  that ignores a kick, a reader with somebody's thumb on it. The devices are
  expected in the middle of November 2026, and this is the entry the other four
  are waiting behind.
- **A printer plugged into the till by USB.** Both ways of reaching a printer are
  addresses on a network, and a printer hanging off a cable has none. One with a
  small network adapter in front of it is the shape this module is built for.
- **A drawer on a printer that only takes plain text.** Opening a drawer is a
  command, and there is nowhere in a line of text to put one. Most printers take
  commands and this does not come up; where it does, the printers screen says so
  rather than offering a button that does nothing.
- **Routing to stations.** One pass and one kitchen chit, not a hot line and a
  cold line. That is a layer on top of this and one nobody should design without
  a kitchen to stand in.
- **A customer tapping their own tip.** The screen facing them shows what each
  percentage comes to and cannot take an answer. Tapping belongs on the card
  reader's own screen, which has one.
- **Fiscalisation.** No certified device, no signature, no live link to a tax
  authority — and none planned. See the notice at the top of this page: where
  a jurisdiction requires one, this till cannot be used for those sales.

## How it fits with everything else

- Every sale is a **Shop order**, in the same list, with the same numbering.
- Every sale posts a **balanced journal entry** through the same accounting the
  rest of Sentrello uses. Takings show up in the profit and loss without
  anybody typing them in.
- Stock is **one count**, shared with the website. You cannot sell the last one
  twice.
- People and permissions come from **Users**. A new starter gets till access
  the same way they get everything else, and the code they tap at the till is
  an identification on top of that rather than a second account.
- A **tip** is money held for a person, not takings: it posts to its own
  liability and leaves it when somebody is handed the cash. A **service charge**
  is the business's income and posts to its own account, so neither is ever
  mistaken for the other in a profit and loss.
