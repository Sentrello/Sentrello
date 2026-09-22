---
title: Platform
sidebar_position: 0
description: What Sentrello is built on, what it sends, and what you are allowed to do with it.
---

# Platform

Questions about Sentrello itself rather than about any one module. What
licence it carries, how to extend it, what the API is built on, what leaves
your server, and what it hands you towards a compliance framework.

## What a request passes through

![One request, from the browser to the database: the API, both entitlement gates, the module route, the journal posting, and PostgreSQL](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/architecture.png)

Read it top to bottom; that is the order a request meets things.

Two of those rows are the ones people get wrong, and they are next to each
other on purpose. `entitled()` asks whether this instance has paid for the tier
or the module, and a module that fails it is never loaded at all. Then
`requirePermission()` asks whether the person making the request may do this
particular thing. **They are separate checks in separate places**, and passing
one says nothing about the other: a fully licensed instance still refuses a
member of staff who tries to open the ledger.

Underneath both, `postJournalEntry()` throws unless the two sides of the entry
agree. There is no code path that writes an unbalanced one — which is why every
report in the product can be read off the ledger rather than assembled beside
it.

| Page | What it answers |
|---|---|
| [Open source](/platform/open-source) | What the AGPLv3 lets you do, and where the commercial line sits |
| [Extending Sentrello](/platform/extensible) | The module contract, and writing a module of your own |
| [The API](/platform/api) | The stack, how routes are guarded, and where the reference stands |
| [Security](/platform/security) | Where data lives, what the licence check sends, how it fails |
| [Compliance](/platform/compliance) | What self-hosting puts in your hands, framework by framework |
