<p align="center">
  <img src="docs/images/sentrello-header.gif" alt="Sentrello" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: AGPL v3" src="https://img.shields.io/badge/licence-AGPL--3.0-2f6f62"></a>
  <a href="https://github.com/Sentrello/Sentrello/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Sentrello/Sentrello/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://bun.sh"><img alt="Bun 1.3.14" src="https://img.shields.io/badge/bun-1.3.14-000000"></a>
  <a href="https://www.postgresql.org/"><img alt="PostgreSQL 17" src="https://img.shields.io/badge/postgres-17-336791"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178c6"></a>
  <br>
  <a href="https://github.com/orgs/Sentrello/packages"><img alt="Container image" src="https://img.shields.io/badge/image-ghcr.io%2Fsentrello%2Fcore-0db7ed"></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/hosting-self--hosted-2f6f62">
  <img alt="No per-seat pricing" src="https://img.shields.io/badge/pricing-no%20per--seat-2f6f62">
  <a href="#project-status"><img alt="Status: early access" src="https://img.shields.io/badge/status-early%20access-orange"></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-555555"></a>
</p>
<div id="user-content-toc">
<ul align="center" style="list-style: none;">
  
# **Run your whole business on software you actually own.**

</ul>
</div>
<p align="center">
  Sentrello is a Unified Business Management Platform (UBM) for small businesses: CRM, Accounting, Booking, Shop, POS, Subscriptions, Links, Newsletter, Documentation, Storage, SEO and Project Management.<br>
  Start with the free core. If you need more upgrade to Pro, and add only the modules you need.<br>
</p>
<div align="center">

### **One Server, One Price, Unlimited Users**

</div>

---

## Install

On any Linux server with Docker or Podman:

```bash
curl -fsSL https://get.sentrello.com | bash
```

**Podman needs a compose provider** — `dnf install podman-compose`, `apt
install podman-compose`, or `pip3 install podman-compose`. Podman stopped
bundling one, and the installer will tell you the same thing if it is missing.

The installer asks for a domain and an administrator email, generates its own
database password and signing secrets, starts PostgreSQL and the app, and runs
migrations. A few minutes later you have a working instance. Put a reverse proxy
with TLS in front of it and you're done.

Prefer to look before you run a script? It's [right
here](https://get.sentrello.com/install.sh), and the image is
`ghcr.io/sentrello/core` (amd64 and arm64).

Manage it afterwards with `sentrello status | update | rollback | backup |
restore | logs`. Updates can also be applied from Settings, and every update
takes a database backup before it starts and refuses to continue without one.

**[Running it yourself](docs/self-hosting.md)** covers TLS, email, backups,
updates and what to look at when something is wrong — including exactly what an
instance does and does not send anywhere.

---

## Why this exists

Look at what a five-person business pays for today. A CRM at $25 a seat. An
invoicing tool at $30. A bookkeeping subscription at $40. A forms product at
$20. None of them speak to each other, so somebody re-types the same customer
four times and the books are always a fortnight behind. Then you hire a sixth
person and every one of those bills goes up again.

The usual dodge is to share one login. That works right up until you need to
know who changed the invoice.

**Sentrello is the whole thing, on one server, for one price, with as many
people as you like.** Raise an invoice and it is in the ledger before you close
the tab. A form on your website drops a lead into the pipeline you actually
look at. The profit and loss is computed from journal entries, so it is right
by construction rather than right because somebody reconciled a spreadsheet on
Friday.

And the database is yours. Not "exportable" — **yours**, on your machine, in
PostgreSQL, queryable with `psql` at two in the morning if that is what the
accountant needs. If this project vanished tomorrow, your instance keeps
running and your data keeps being readable.

- **Give everyone their own account,** with the permissions their job needs,
  because it costs nothing to do so. Audit trails only work when people sign in
  as themselves.
- **Nothing about your customers reaches us.** A paid instance sends one daily
  licence check — a key and an instance id. A Free instance need never contact
  us at all.
- **Start free and stay free if you like.** The free core is not a trial. It
  doesn't expire, doesn't nag, and doesn't need a licence key.
- **Grow by module, not by seat.** Add a shop, a booking diary or a newsletter
  when the business needs one, and pay nothing for the ones it doesn't.

One command puts it on a $6 VPS. Go and take it for a walk.

---

## What it looks like

Every screenshot in the documentation is a real instance running the free core,
captured by an automated run against a live server. Nothing is a mock-up and
nothing needs a licence key.

![Money owed, overdue invoices, pipeline value and the server's own health](docs/images/dashboard.png)

**[Take the tour →](https://docs.sentrello.com/getting-started/what-it-looks-like)**
— the dashboard, CRM, quotes and invoicing, accounting, forms, roles and
settings, screen by screen.

---
## Free vs Pro

The **free core** is this repository: AGPLv3, unlimited users, no licence key,
no expiry. It is a real product, not a trial.

**Pro** is a subscription that unlocks the paid half of the modules already in
the core — the same screens, opened up — and gives you access to buy the
optional modules, which are not sold on their own. It is **per instance, not per
person**: hiring somebody costs nothing.

Dropping back to free leaves every record you created in place, still readable
and still exportable. The Pro screens simply stop.

**[The full comparison, line by line →](https://docs.sentrello.com/free-vs-pro)**

---
## The optional modules

Each is a whole application, not a feature — and each is built so another
module can consume what it produces: the Shop's orders reach Accounting, a
booking becomes an invoice. They need a Pro subscription underneath; none is
sold against the free core.

| Module | What it is | Availability |
|---|---|---|
| **[Booking](https://docs.sentrello.com/modules/booking)** | Diary, availability, resources, and a page customers book themselves on | Available |
| **[Shop](https://docs.sentrello.com/modules/shop)** | Products, stock by location, storefront, checkout and payments | Available |
| **[POS](https://docs.sentrello.com/modules/pos)** | Sell face to face: works offline, drives a receipt printer and a cash drawer. A plugin for Shop | Available |
| **[Subscriptions](https://docs.sentrello.com/modules/subscriptions)** | Plans, subscribers, trials, pauses, and a customer who can change or cancel their own | Available |
| **[Links](https://docs.sentrello.com/modules/links)** | Short links on your own domain, and the click → signup → sale chain | Available |
| **[Newsletter](https://docs.sentrello.com/modules/newsletter)** | Lists, segments, templates, campaigns and delivery | Available |
| **[Documentation](https://docs.sentrello.com/modules/docs)** | Publishes your own documentation site | Available |
| **[Storage](https://docs.sentrello.com/modules/documents)** | Folders, versions, sharing and retention, with warnings before a certificate lapses | Available |
| **[SEO](https://docs.sentrello.com/modules/seo)** | Keyword research, rank tracking, audits, backlinks, competitors — see below | Available |
| **Project Management** | Projects, tasks, boards, milestones and time against work | **Included with Pro from v1** |
| **HR** | People records, leave, onboarding and reviews | **Q1 2027** |
| **Helpdesk** | Tickets, queues, SLAs and a customer-facing portal | **Q1 2027** |

POS is a **plugin**: a module that plugs into another module. It needs Shop, it
is bought separately at half a module's price, and it shares Shop's catalogue
rather than keeping a menu of its own — one price to change, one stock figure,
one line in the books whether something sold at a counter or on a website.

It arrives for **counter service** first: a queue, an order, cash or card. Table
service, bars and retail follow, and they are deliberately not given dates here.
They are each a substantial piece of work and a date we are not certain of is
worth less to you than no date at all.

Project Management is not sold separately — it arrives **with the v1 release of
Pro**, for everyone who has Pro. HR and Helpdesk are separate modules, split
apart on purpose: a business that wants a ticket queue rarely wants a leave
calendar in the same week.

---

## SEO, and the one thing it does differently

Every other module runs entirely on your server. SEO cannot: keyword volumes,
rankings and backlink graphs come from a search-data provider, because nobody
self-hosts a search index.

So it is the one module with **two ways to buy the data**, chosen in a single
setting — our cloud at the provider's cost plus 40% with an allowance included,
or your own provider account, talking to them directly with nothing passing
through us. The second earns us nothing and exists because an agency large
enough to hit a provider's minimum deposit is exactly the one that would object
to its clients' keywords transiting somebody else's server.

**[What the module does, and how the two options differ →](https://docs.sentrello.com/modules/seo)**

---
## Founder pricing

**v1 lands on 1 October 2026.** For the **first 90 days** after it does, Pro
subscriptions bought during that window keep their price for as long as they
stay active. Locked — not an introductory rate that steps up next year.

Modules not finished by launch are sold in that window too, at the founder
price, and released as they are completed — so buying early never means waiting
at a worse rate than somebody who waited.

**Watch this repository** to be told the day it does, and **star it** if
you want to see a business platform exist that nobody has to rent seats on.

[![Star on GitHub](https://img.shields.io/github/stars/Sentrello/Sentrello?style=social)](https://github.com/Sentrello/Sentrello/stargazers)
[![Watch this repo](https://img.shields.io/github/watchers/Sentrello/Sentrello?style=social)](https://github.com/Sentrello/Sentrello/subscription)

---

## Architecture

A **modular monolith**: one deployable service that discovers feature modules at
startup. One container to run and one database to back up — the right trade for
a business with no operations team.

Every feature, free or paid, implements the same contract:

```ts
import { defineModule } from "@sentrello/module-sdk";

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "crm", label: "Contacts", order: 10 });
    ctx.app.get("/api/contacts", requireSession(), requirePermission({ crm: ["read"] }), handler);
  },
});
```

Paid features are gated twice: the loader refuses to register a module the
licence doesn't cover, and each route checks permissions independently. Licences
are Ed25519-signed tokens verified **offline** against a public key embedded in
this repository — so an instance keeps working without reaching the internet,
and a missing or expired token degrades to Free rather than breaking.

| Layer | Choice |
|---|---|
| Runtime | Bun 1.3.14, TypeScript strict |
| API | Hono |
| Database | PostgreSQL 17 with Drizzle ORM |
| Auth | Better Auth — email/password, optional Google, org-scoped roles |
| Jobs | pg-boss, inside Postgres (no Redis) |
| Front end | React, Vite, TanStack Query, Tailwind |
| Deploy | Docker Compose, multi-arch |

Two rules the codebase does not bend on: **money is integer cents**, never
floating point, with tax rates in basis points; and **bookkeeping is
double-entry**, so every financial event posts a balanced journal entry or
throws, and every report is computed from the ledger rather than summed from the
invoice table.
**[Why, and what it means for your books →](https://docs.sentrello.com/core/money)**

---

## Development

```bash
bun install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL
bun run db:migrate
bun run dev                                       # API + web
```

Then:

```bash
bun test          # every test runs against a real PostgreSQL, not mocks
bun run typecheck
bun run lint
```

Requires [Bun 1.3.14](https://bun.sh) exactly and a Docker runtime.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the DCO sign-off, the house style and
what a good pull request looks like.

---

## Project status

**Early access, with v1 on 1 October 2026.** The free core is built and tested, and
the install path works end to end on both Docker and Podman. It has not yet been
run by a large number of businesses, so expect rough edges and please report
them — the Podman path was fixed in v0.13.0 because somebody did.

Live bank feeds arrived in Pro: a business connects its bank through a data
provider and transactions arrive on their own, alongside the CSV import that is
still there for anyone who would rather not connect anything.

Not yet available, and not promised on any date: QuickBooks or Xero sync, and
mobile apps.

**Markets:** the United States first, then Canada, the United Kingdom and the
EU. That is a scoping decision, not a shipping restriction — it decides which
tax regimes and statutory features exist at all.

---

## Security

Found a vulnerability? **Please don't open a public issue** — email
`security@sentrello.com`. [SECURITY.md](SECURITY.md) has the scope, the response
times you can expect, and what the design already assumes.

---

## Licence

[GNU AGPLv3](LICENSE). You may run, study, modify and share this software. If
you modify it and offer it to others over a network, you must publish your
changes under the same licence.

**Modules are exempt, on purpose.** A [module linking exception](LICENSE) at
the top of the licence lets you write a module against `@sentrello/module-sdk`,
load it into Core, and license and sell that module on whatever terms you like.
Core itself stays AGPL — modify Core and those changes are still copyleft — but
the module you wrote is yours.

Pro features and optional modules are separately licensed commercial software
and are not covered by the AGPL.

Built by [Sentrello LLC](https://sentrello.com).
