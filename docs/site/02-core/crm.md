---
title: CRM
sidebar_position: 2
description: Contacts, companies, and the work in progress against them.
tags: [core, crm]
---

# CRM

Who your customers are, and what is currently happening with each of them.

![The contacts list, with each customer’s company, town, tags and the date they became a customer](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/contacts.png)

Tags are yours to invent. The two above — a support plan, and who has come
back — are the kind that earn their place: both answer a question somebody
asks on the phone.

The records, and the two things every other module reaches for.

```mermaid
flowchart LR
  classDef screen fill:#eef4ff,stroke:#3b6fd4,color:#16305e
  classDef own fill:#eefaf1,stroke:#219653,color:#10442a
  classDef out fill:#f4f0fb,stroke:#6b47c4,color:#31205e
  classDef pub fill:#fff4ec,stroke:#c4470f,color:#5a2207
  subgraph OWN[" CRM "]
    CO["Companies<br/><small>the account</small>"]:::own
    CT["Contacts<br/><small>the person</small>"]:::own
    DL["Deals"]:::own
    TK["Tasks and activities"]:::own
  end
  FORM(["Forms on your website"]):::pub
  Q["Quotes and invoices<br/><small>Invoicing</small>"]:::out
  MOD["Booking · Shop · Links · Subscriptions"]:::out

  FORM --> CT
  CO --- CT
  CT --> DL --> Q
  DL --> TK
  MOD -->|"every one of them wants a contact"| CT
  style OWN fill:#fbfdfc,stroke:#cfe4d8,color:#10442a
```

## Contacts and companies

A **contact** is a person. A **company** is an organization, and contacts
belong to it. A sole trader is a contact with no company; nothing forces you to
invent one.

Both carry the details you would expect: addresses, phone numbers, email. Both
carry **tags** as well, which is the fastest way to pull a group back out later.

Every list has a search box, and it reads more than the name. On contacts it
also reads email, phone, job title and **background**, the free-text field
where "met at the trade show, knows Priya" ends up. That scrap is often the
only thing anybody can remember about the person they are trying to find again.
On companies, search reads the sector, city, website and description.

### Two people, one record

Somebody in sales corrects the phone number. Somebody in accounts corrects the
billing address. Both had the contact open; both press Save.

Sentrello refuses the second save rather than applying it, and says so: *somebody
else changed this while you had it open, so nothing here has been saved.* Open it
again and you see their version, with your change still to make.

The alternative is what most software does — the second save wins, quietly, and
the first person never learns their work is gone. It is the one kind of loss
nobody recovers from by trying again.

Contact, company and deal forms work this way, as do quotes and invoices. The
one-tap actions do not, deliberately: dragging a card to another stage or ticking
a task off should not be refused because somebody else edited the description.

## Deals

A **deal** is a piece of work you might win, moving through stages you define.
The board shows the pipeline and what each stage is worth, with every deal's
amount and its expected close date on the card.

Drag a card to another stage, or use the menu on it — which also moves a card
up and down inside its own column, so the order is the one you want to work in
rather than alphabetical. The menu is there because dragging is a mouse
gesture, and a keyboard and a touch screen both need somewhere else to go.

**A deal can become a quote.** The customer, the description and the figure
come across with it: three things somebody would otherwise retype, and three
chances to send a price that does not match what was discussed. You land on
Quotes with the new draft at the top, ready to send.

It arrives as one line, from the deal's own name and value. Sentrello does not
guess at a breakdown the deal never held.

The button is there at any stage, not only once a deal is won: quoting is often
how a deal gets won.

A quote then becomes an invoice with nothing re-entered. That holds when the
customer accepts it themselves from the portal, where the invoice is raised at
the moment they say yes.

## Notes, activities and tasks

Against any contact you can record a **note** (something that happened), an
**activity** (a call, a meeting, an email) and a **task** (something to do,
with a date). Overdue tasks show on the dashboard.

A company takes notes and tasks — "renew the retainer", "chase the PO" — which
belong to the account rather than to whoever answered the phone that day. An
activity is a thing that happened with a person, so it hangs off the contact;
the company page gathers its people's history into one column, which is the
same question asked the useful way round.

A note on a contact or a company can carry files. Add the note, then use
**Attach a file** under it; each file can be up to 10 MB, and it downloads from
the note rather than opening in the browser. Notes on a deal take text only.

A task that cannot happen today moves from its own menu: **Postpone to
tomorrow** or **Postpone to next week**. Either counts from the date the task
was already due, so postponing twice moves it two days rather than one.

### The whole history in one column

The **History** card on a contact lists the notes, activities, tasks, deals and
consent changes for that person, newest first.

With [Pro](/pro) it reads further: the quotes and invoices raised for them, the
payments against those invoices, when a deal was opened and when it was
decided, and the mail and meetings a connected mailbox found (see below). None
of it is copied into a feed. The card asks each module when you open the page,
so an invoice paid this morning is on it this morning. If a license lapses
those lines leave the card, and the quotes, invoices and payments themselves
stay where they are.

## Your own fields

Every business looks something up that no other business does: the boiler
model, the site access note, the license number. **Your own fields** puts those
on contacts, companies and deals, with a type each: text, a number, a date, a
list to pick from, or yes or no.

Filling them in is free. Defining them is [Pro](/pro), on **CRM → Settings**
under **Your own fields**, up to forty of them. A field defined while you had
Pro stays on every record and stays editable if the license lapses. Adding
another, or changing one, waits for Pro.

### Figures worked out for you

Pro also adds **Formulas**, under the CRM's Automation heading: a number worked
out from the fields beside it. A deal's value less a cost you record in a field
of your own. The days since a contact was last in touch. You build each one
from dropdowns, so there is no expression to type and nothing to break with a
stray character.

A formula shows as a column on the contacts, companies or deals list it
belongs to, and on the deal board's cards. It is worked out each time the list
is read, so it is never stale. Every result is a whole number, and a division
rounds to the nearest one. There are twenty formulas at most.

## Duplicates

Every contact list ends up holding somebody twice. **Duplicates**, on the
contacts list, shows the likely pairs: the same email address, the same phone
number (the last ten digits, so a country code does not hide a match), or the
same full name.

For each pair, choose which one to keep. Everything on the other record
follows it — notes, tasks, activities, deals, quotes, invoices, tags — and the
other record is removed. Where both had a value, the one you kept wins; where
the kept one was blank, it takes the other's. An email or phone number that
differed is kept as an extra one rather than thrown away.

Press **Not duplicates** for two people who only look alike, such as two Sam
Patels, and the pair is not offered again.

A merge cannot be undone from a screen. It needs permission to update and to
delete contacts.

## Importing and exporting

Bring in a spreadsheet from **Contacts → Import**. Map the columns to fields,
look at how the first rows will read, and only then import. Rows that cannot be
read are listed rather than quietly skipped.

**Export**, on the contacts, companies and deals lists, downloads a CSV of what
the list is showing, with your search and filters applied, every matching row
rather than the current page. Your own fields come out too, one column each
under the name you gave the field.

## Webhooks

When another system of yours needs to know that a contact, company or deal
changed, give it a webhook. On **CRM → Settings**, under **Webhooks**, add the
address and tick which records it should hear about. It is told when one is
created, changed or deleted, with what changed.

Each call is signed, so the receiver can check it came from you. The signing
secret is shown once, when you add the webhook; store it then. Lose it and you
remove the webhook and add it again.

**Deliveries** shows what was sent and what came back. A delivery that fails
is tried again after one minute, five, thirty, two hours and twelve hours, and
then left as abandoned rather than tried for ever.

Webhooks go to `https` addresses unless you say otherwise, and never to an
address on your own private network.

## Email on the record

There are two ways to get mail onto a customer's record, and they keep
different things.

**Capture email** is free. On **CRM → Settings**, enter the address you will
CC and press **Turn it on**. Sentrello shows a private URL under **Point your
provider here**; set your mail provider's inbound forwarding to post to it
(Postmark, SendGrid and Mailgun formats are understood). The URL is the
credential, so treat it like a password, and **Rotate the URL** if it gets out.

From then on, CC that address and the message lands on the customer as a note,
with up to ten attachments kept on it. Mail from an address that matches no
contact is dropped rather than filed against a guess.

**Mailbox** is [Pro](/pro), under the CRM's Correspondence heading. Each person
connects their own Microsoft 365 or Google Workspace account, and the mail and
meetings they have with your customers appear on the customer's History: who,
when, and which way. Not the message itself. There is nowhere in the database
to put a message body, and mail with somebody who is not a contact is never
written at all, so your accountant, your bank and your family stay out of it.

A few things worth knowing before you connect one:

- **Test it** shows how many messages would match a customer, and how many
  would not be stored, before anything is written.
- Colleagues see that mail was exchanged and when, not the subject. Only the
  person whose mailbox it is can change that, under **What colleagues can
  see**.
- Disconnecting a mailbox removes every line it put on your customers' records.
- An administrator registers the Microsoft or Google app once, on the
  **Set-up** tab, before anybody can connect.

## Deleting, restoring and erasing

**Deleting** removes a record along with its notes, activities and tasks.
Contacts are deleted from the contacts list (select them, then **Delete**), and
a deal or a company from its own page, under **Edit**. On a free instance that
is final.

Sentrello refuses to delete a contact that money is attached to: an invoice, a
quote, a subscription, a bookkeeping entry. Deleting them would leave those
records without a customer. Delete several at once and the ones it could
delete go, with the reason the others stayed.

A company is kept while anybody works there or a deal names it. Move or delete
those first, and the screen says which.

With [Pro](/pro), **CRM → Records → Deleted records** keeps a deleted contact,
company, deal or task for thirty days, with the notes and tags that went with
it, and **Restore** puts it back. After thirty days it is gone.

**Erasing** is the third thing, for when a person asks you to forget them. It
is done from **Settings → Personal data**, across every module at once, and it
is final: the record goes, and so does their personal data in the change
history and the webhook delivery log. An erased record cannot be restored from
Deleted records either.

One exception: a contact that an invoice, quote or subscription still names.
The law makes you keep the invoice, and an invoice has to say who it was
issued to, so that contact keeps its name and its company. Everything else
goes: email addresses, phone numbers, picture, links, custom fields and the
portal link. The record's background then says it was erased. Erasing someone
doesn't cancel their subscriptions, though. If they've left, cancel those
yourself; the erasure result tells you when any are still running. See
[Compliance](/platform/compliance) for the rest of that screen.

## The customer portal

Every invoice and quote you send carries a link to a page holding that
customer's own documents. There is no account and no password: the link is the
credential, thirty-two random bytes of it, and it resolves to exactly one
contact. That is the whole design — asking somebody who buys from you twice a
year to make an account is asking them to reset a password instead of paying
you.

So nothing has to be switched on, and there is nothing to switch off. A
contact gets a link the first time one is sent to them, and it keeps working.
If a link goes somewhere it should not have, issue a new one from the
contact's own page and the old one stops resolving.

They see their own quotes and invoices, and nothing else — not because a
permission is checked, but because the link is only ever about them.

**Paying from that page needs Pro and a connected card processor.** On a free
instance, or before Settings → Connections has a processor in it, the page
shows the documents and your payment instructions and offers no Pay button —
which is the right outcome, since a button that cannot take money is worse
than no button.
