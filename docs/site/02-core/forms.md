---
title: Forms
sidebar_position: 5
description: Forms on your own website that land as contacts and enquiries.
tags: [core]
---

# Forms

Build a form, put it on your website, and what people send arrives as a contact
or an enquiry rather than as an email you have to retype.

Forms live inside the CRM, at **CRM → Forms**. What they collect ends up there,
so that is where they are set up.

![The forms list, with where each one is embedded, how many submissions it has taken, and how much spam was blocked](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/forms.png)

A form on somebody else's website, and the one gate that decides whether it
is allowed to be there.

```mermaid
flowchart LR
  classDef screen fill:#eef4ff,stroke:#3b6fd4,color:#16305e
  classDef own fill:#eefaf1,stroke:#219653,color:#10442a
  classDef out fill:#f4f0fb,stroke:#6b47c4,color:#31205e
  classDef pub fill:#fff4ec,stroke:#c4470f,color:#5a2207
  SITE(["Your website"]):::pub
  EMB["embed.js<br/><small>one script tag</small>"]:::screen
  ALLOW{{"On the allow-list?"}}:::screen
  subgraph OWN[" Forms "]
    DEF["The form's questions"]:::own
    SUBM["Submissions"]:::own
  end
  CT["A contact<br/><small>CRM, tagged by form</small>"]:::out

  SITE --> EMB --> ALLOW
  ALLOW -->|"no"| X["Refused<br/><small>the form renders; nothing sends</small>"]:::pub
  ALLOW -->|"yes"| DEF --> SUBM --> CT
  style OWN fill:#fbfdfc,stroke:#cfe4d8,color:#10442a
```

## Building one

Add fields (text, email, phone, number, web address, choice, date and longer
text) and mark which of them are required. A **choice** field is a dropdown you
supply the answers to. A **date** field uses the visitor's own device picker,
so on a phone it behaves the way they already expect.

Each form has its own settings for what happens on submission: where the person
is sent afterwards, and who is notified.

## Putting it on your site

Each form gives you a snippet to paste into your website. It works on any site,
including ones that are nothing to do with Sentrello.

## What arrives

A submission can create a contact, or attach itself to one that already exists
when the email address matches. Somebody who fills in two forms is then one
person rather than two records sharing an address.

Submissions are listed with what was sent and when, and they export as a
spreadsheet. The columns come from the form's own questions, not from whatever
the first submission happened to answer. A question added last week is still a
column. Answers to a question you have since deleted are still in the file.

## Spam

Forms carry basic protection against automated submission. A form that is being
abused can be paused rather than deleted, which keeps the address valid and
leaves the submissions you already have where they are.
