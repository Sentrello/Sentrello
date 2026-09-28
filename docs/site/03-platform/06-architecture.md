---
title: Architecture
sidebar_position: 6
description: What a request passes through, from the browser to the ledger, and which of those layers can say no.
tags: [platform, architecture]
---

# Architecture

One deployable service. It discovers its feature modules at startup, decides
which of them this instance is allowed to load, and then checks every request
against the person making it. Below is the whole of it on one page.

Read it top to bottom. That is the order a request meets things.

```mermaid
flowchart TD
  classDef browser fill:#eef4ff,stroke:#3b6fd4,color:#16305e
  classDef host fill:#fff4ec,stroke:#c4470f,color:#5a2207
  classDef gate fill:#fdeaea,stroke:#c0392b,color:#6b1a12,stroke-width:2px
  classDef no fill:#fff,stroke:#c0392b,color:#6b1a12,stroke-dasharray:4 3
  classDef module fill:#eefaf1,stroke:#219653,color:#10442a
  classDef store fill:#f4f0fb,stroke:#6b47c4,color:#31205e
  classDef aside fill:#f7f7f8,stroke:#9aa3ad,color:#444c55

  SPA["React SPA<br/><small>TanStack Router and Query</small>"]:::browser
  API["Hono<br/><small>one process, one container</small>"]:::host
  AUTH["Better Auth<br/><small>the session, and which organisation</small>"]:::host
  ENT{{"entitled?<br/><small>has this instance paid for it</small>"}}:::gate
  NOENT["Not loaded at all<br/><small>no routes, no tables, no nav</small>"]:::no
  LOADER["Module loader<br/><small>every feature is a SentrelloModule</small>"]:::host

  subgraph MODULES[" Feature modules — all the same kind of object "]
    FREE["Free<br/><small>CRM · Invoicing · Accounting<br/>Dashboard · Users</small>"]:::module
    PRO["Pro<br/><small>pro-core</small>"]:::module
    OPT["Optional<br/><small>Shop · Booking · Links · …</small>"]:::module
  end

  PERM{{"requirePermission?<br/><small>may this person do this</small>"}}:::gate
  NOPERM["403<br/><small>checked again on the API, not just the screen</small>"]:::no
  LEDGER["postJournalEntry<br/><small>debits equal credits, or it throws</small>"]:::store
  DB[("PostgreSQL 17<br/><small>Drizzle · a schema per module</small>")]:::store

  CP["Control plane<br/><small>sentrello.com</small>"]:::aside
  LIC["Licence<br/><small>Ed25519, verified offline</small>"]:::aside
  JOBS["pg-boss<br/><small>jobs, in the same database</small>"]:::aside

  SPA -->|"one request"| API
  API --> AUTH
  AUTH -->|"organizationId on every query"| ENT
  ENT -->|"no"| NOENT
  ENT -->|"yes"| LOADER
  LOADER --> FREE
  LOADER --> PRO
  LOADER --> OPT
  FREE --> PERM
  PRO --> PERM
  OPT --> PERM
  PERM -->|"no"| NOPERM
  PERM -->|"yes, and it moves money"| LEDGER
  PERM -->|"yes"| DB
  LEDGER --> DB

  CP -.->|"signed token, refreshed hourly"| LIC
  LIC -.-> ENT
  LOADER -.-> JOBS
  JOBS -.-> DB

  style MODULES fill:#fbfdfc,stroke:#cfe4d8,color:#10442a
```

## The two gates are not the same gate

They sit next to each other above on purpose, and confusing them is the most
common misreading of this diagram.

**`entitled()` asks about the instance.** Has this business paid for the tier,
or bought this module? A module that fails it is never loaded at all — its
routes do not exist, its tables are not migrated, and nothing in the interface
refers to it.

**`requirePermission()` asks about the person.** May *this* user do *this*
thing to *this* resource? It runs on every route inside a module that was
loaded.

Passing one says nothing about the other. A fully licensed instance still
refuses a member of staff who tries to open the ledger, and an administrator
with every permission in the product still cannot open a module nobody bought.

A screen that shows or hides a button is a convenience on top of both. The
same request made straight to the API is checked exactly the same way.

## What the browser is told

The interface does not know what exists. It asks `/api/_meta` and is told what
this person, on this instance, may see — and it draws that. Which means the
nav is a *result* of the two gates rather than a list maintained beside them.

## What never leaves your server

The licence is verified **offline**, against a public key compiled into the
build. The control plane signs tokens; it is not asked for permission at
request time, and an instance with no route to the internet keeps working.

A missing, expired or invalid token fails safe to Free. It never crashes the
application, and it never quietly opens something.

## Where the state lives

One database. A schema per module, and every business table carries an
`organizationId` — the scoping lives in the data layer rather than in each
page's good intentions, which is the difference between a rule and a habit.

Jobs run through pg-boss, in that same PostgreSQL. No Redis, no second thing to
back up, no second thing to be down.

**Every financial event goes through `postJournalEntry`**, which throws unless
the debits equal the credits. The ledger is the source of truth for every
report, and nothing writes money to the database around it.

## Why one service

A business with nine people has no operations team. One container to run, one
database to back up, one process to restart. Modules are discovered rather than
deployed separately, so buying one is a licence change rather than an
infrastructure change.

See [Extending Sentrello](/platform/extensible) for the contract each module
implements, and [Security](/platform/security) for what the gates above are
enforcing.
