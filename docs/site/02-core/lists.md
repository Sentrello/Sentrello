---
title: Working a list
sidebar_position: 9
description: Search, filters, sorting, columns and saved views — the controls every long list in Sentrello shares.
tags: [core, lists, views]
---

# Working a list

Every long list in Sentrello — customers, invoices, the journal, the bank feed
— is worked the same way. Learn it once.

## The controls

| Control | What it does |
|---|---|
| **Search** | Matches the fields that identify a row: a name, a number, a reference, a description. Two letters is usually enough. |
| **Filters** | Narrow by status, by owner, by date, by whatever that list is about. Filters combine. |
| **Sort** | Pick the column and the direction. Rows with the same value keep a stable order, so paging never shows you the same row twice or skips one. |
| **Columns** | On the tables that have several — invoices, quotes and bills — choose which you want to see. Kept per person, in your own browser. |
| **Group** | On customers and companies, break the list into sections by sector, city or size. Each section's count is over everything that matched, not just this page. |

Search, filters and sorting happen on the server, so they apply to the whole
list rather than to the page in front of you. Counting says the same: "24 of
310" means 310 rows match, not 310 rows exist.

## Saved views

A view is a search, its filters and its sorting, kept under a name.

Save one when you find yourself making the same choices every morning —
"unpaid, oldest first", "this account, still waiting", "fuel, last quarter".
Choosing a view puts the list back exactly as it was; choosing **All** puts it
back to the list's own default.

Views are **yours**: they live with your account, and a colleague's views are
not in your list. A view changes nothing but your own screen, so it needs no
permission beyond the one that let you see the list.

Views are available on:

- **Customers**, **companies** and **deals**
- **Invoices** and **quotes**
- The **journal** and **bills** (Pro)
- The **bank feed** (Pro)

## What is not here

**Shared views.** A view is one person's way of working, and a shared one is a
small piece of configuration that needs an owner, a permission and a
conversation about who may change it. If you want everybody looking at the same
thing, that is usually a report or a dashboard widget rather than a list.

**Views that travel between instances.** They are rows in your own database,
like everything else, and they come back with a restore.
