---
title: Newsletter
sidebar_position: 6
description: Mailing lists, campaigns, and the counting — done lawfully.
tags: [module, newsletter]
---

# Newsletter

Run a mailing list properly: lists, subscribers, campaigns, and honest numbers
about what happened to each message.

A list is not your customer list, and the arrow below only goes one way on
purpose.

```mermaid
flowchart LR
  classDef screen fill:#eef4ff,stroke:#3b6fd4,color:#16305e
  classDef own fill:#eefaf1,stroke:#219653,color:#10442a
  classDef out fill:#f4f0fb,stroke:#6b47c4,color:#31205e
  classDef pub fill:#fff4ec,stroke:#c4470f,color:#5a2207
  subgraph OWN[" Newsletter "]
    L["Lists"]:::own
    S["Subscribers<br/><small>with their consent, and when</small>"]:::own
    T["Templates"]:::own
    C["Campaigns"]:::own
  end
  FORM(["A signup form on your site"]):::pub
  MAIL["Your own mail setup"]:::out
  CRM["CRM contacts"]:::out

  FORM --> S --> L
  T --> C
  L --> C --> MAIL
  MAIL -->|"opens and clicks"| C
  CRM -.->|"only if they agreed"| S
  style OWN fill:#fbfdfc,stroke:#cfe4d8,color:#10442a
```

## Lists and subscribers

A **list** is a group of people who agreed to hear from you. Public or private.
Single or double opt-in.

:::info[Double opt-in is a property of the list]
On a double opt-in list, nobody is written to until they confirm. In several of
the markets Sentrello is sold into, the difference between that and not is the
difference between marketing and an offence.
:::

Subscribers carry whatever attributes you want to keep. Import them from a
spreadsheet, export them in full whenever you like.

**An import does not resubscribe somebody who asked to stop.** An import is the
business speaking. A subscribe form is the person speaking, and only the second
of those undoes an unsubscribe.

## Signup forms

The usual way anybody joins a mailing list is a form on your own website. Build
one, choose the lists a signup joins, paste the snippet into any page, even a
page on a site that has nothing else to do with Sentrello.

A form asks for an email address, and for a name if you want one — that is a
setting per list, and a one-field form is the one people finish. Tick several
lists and you get one form that joins all of them. Lists set to
double opt-in still send their confirmation email, so a signup here joins on
exactly the terms the list already has.

**A signup can also become a CRM contact**, per form, and it stays off unless
you turn it on. Whether that is worth turning on depends on what the form asks
for. An address on its own makes a contact with no name against it, which is a
record somebody has to tidy later; an address and a name makes one worth
keeping. The builder tells you which of the two you have, and a list that
feeds the CRM asks for a name whatever else you have set. It needs the CRM
installed, and without it the switch does nothing.

## Campaigns

Write a campaign, choose its lists, send a test to yourself, then schedule or
send it. Templates give you a consistent header, footer and color.

Sending happens in batches so that a large campaign does not make the rest of
the application unresponsive. A campaign can be paused and resumed, and
**nobody is written to twice**: the recipients are written down before sending
starts, and each one moves from pending to sent exactly once.

Somebody on three of a campaign's lists receives one email.

## Counting

Opens and clicks are counted from the first send. How many people opened a
campaign and how many followed a link is what makes the next one better, and a
setting you have to find before you learn anything is a setting nobody finds.
Either can be switched off, and off means nothing is written down at all.

What is **not** on is tying a read or a click to the person who made it. The
counts are kept and the identity is not, which is the difference between a
measurement and a record about somebody — and in every market this is sold
into, that second thing is the business's decision rather than ours. Turn it on
in Privacy if the business wants it, and read the obligations that come with it
first.

## Unsubscribing

Every campaign carries an unsubscribe link that works from a phone, in any mail
client, with no account and no JavaScript, plus the header that lets Gmail and
Outlook offer their own one-click button. An unsubscribe link that only
sometimes works will cost you a fine rather than a bug report.

**Transactional messages do not**, deliberately. A receipt, a booking
confirmation or a password reset is not marketing, and an unsubscribe link on
one is an invitation to switch off the email that tells somebody their order
shipped. Anti-spam law draws the same line; if you use a transactional
template for marketing, you have moved it to the wrong side of that line
yourself.

Once somebody has gone, the page asks — optionally, and after the fact —
whether they would say why. It is one box, skipping it costs them nothing,
and what they write appears beside them on your subscribers list. A question
in the way of unsubscribing is a dark pattern; a question after it is the only
feedback you will ever get from somebody leaving.

## Subscribers are not customers

They are kept separately, and linked to a CRM contact where the address already
matches. Most subscribers gave you an email address and nothing else. Count
them as customers and every answer to "how many customers do we have" comes out
wrong.
