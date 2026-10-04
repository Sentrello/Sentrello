<p align="center">
  <img src="docs/images/sentrello-header.gif" alt="Sentrello" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL v3" src="https://img.shields.io/badge/license-AGPL--3.0-2f6f62"></a>
  <a href="https://github.com/Sentrello/Sentrello/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Sentrello/Sentrello/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://bun.sh"><img alt="Bun 1.3.14" src="https://img.shields.io/badge/bun-1.3.14-000000"></a>
  <a href="https://www.postgresql.org/"><img alt="PostgreSQL 17" src="https://img.shields.io/badge/postgres-17-336791"></a>
  <a href="https://www.typescriptlang.org/"><img alt="TypeScript strict" src="https://img.shields.io/badge/typescript-strict-3178c6"></a>
  <br>
  <a href="https://github.com/orgs/Sentrello/packages"><img alt="Container image" src="https://img.shields.io/badge/image-ghcr.io%2Fsentrello%2Fcore-0db7ed"></a>
  <img alt="Self-hosted" src="https://img.shields.io/badge/hosting-self--hosted-2f6f62">
  <img alt="No per-seat pricing" src="https://img.shields.io/badge/pricing-no%20per--seat-2f6f62">
  <a href="#project-status"><img alt="Status: stable, v1" src="https://img.shields.io/badge/status-stable%20v1-2f6f62"></a>
  <a href="SECURITY.md"><img alt="Security policy" src="https://img.shields.io/badge/security-policy-555555"></a>
</p>
<div id="user-content-toc">
<ul align="center" style="list-style: none;">
  
# **Run your whole business on software you actually own.**

</ul>
</div>
<p align="center">
  Sentrello is a Unified Business Management Platform (UBM) for small businesses: CRM, Accounting, Booking, Shop, Subscriptions, Projects, Links, Newsletter, Documentation, Storage and SEO.<br>
  Start with the free core. If you need more upgrade to Pro, and add only the modules you need.<br>
</p>
<div align="center">

### **One Server, One Price, No Per-Person Charge**

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

The installer asks four things — a license key if you have one, a domain, an
administrator email, and whether to send usage reports (the answer is no unless
you change it) — generates its own database password and signing secrets, starts PostgreSQL and the app, and runs
migrations. A few minutes later you have a working instance. Put a reverse proxy
with TLS in front of it and you're done.

Prefer to look before you run a script? It's [right
here](https://get.sentrello.com/install.sh), and the image is
`ghcr.io/sentrello/core` (amd64 and arm64).

Manage it afterwards with `sentrello status | update | rollback | backup |
restore | logs`. Updates can also be applied from Settings, and every update
takes a database backup before it starts and refuses to continue without one
unless you say `--no-backup`.

**[Running it yourself](docs/self-hosting.md)** covers TLS, email, backups,
updates and what to look at when something is wrong — including exactly what an
instance does and does not send anywhere.

---

## Why this exists

Look at what a five-person business pays for today. A CRM at $25 a seat. An
invoicing tool at $30. A bookkeeping subscription at $40. A forms product at
$20. None of them speak to each other, so somebody re-types the same customer
four times and the books are always two weeks behind. Then you hire a sixth
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
- **Nothing about your customers reaches us.** A paid instance sends one
  license check an hour — a key and an instance id. A Free instance need never
  contact us at all.
- **Start free and stay free if you like.** The free core is not a trial. It
  doesn't expire and doesn't need a license key. One block on the dashboard
  says what Pro adds, and the pages your customers see carry a "Powered by
  Sentrello" line. That is the whole of it.
- **Grow by module, not by seat.** Add a shop, a booking diary or a newsletter
  when the business needs one, and pay nothing for the ones it doesn't.

One command puts it on a $6 VPS. Go and take it for a walk.

---

## What it looks like

Every screenshot in the documentation is a real instance, captured by an
automated run against a live server. Nothing is a mock-up. The screens below
are the free core and need no license key; the ones in the module and Pro pages
are the same run against an instance that has one.

![Money owed, overdue invoices, pipeline value and the server's own health](docs/images/dashboard.png)

**[Take the tour →](https://docs.sentrello.com/docs/getting-started/what-it-looks-like)**
— the dashboard, CRM, quotes and invoicing, accounting, forms, roles and
settings, screen by screen.

---
## Free vs Pro

The **free core** is this repository: AGPLv3, no license key, no expiry, and no
per-person charge on any tier. It is a real product, not a trial.

**Pro** is a subscription that unlocks the paid half of the modules already in
the core — the same screens, opened up — and gives you access to buy the
optional modules, which are not sold on their own. It is **per instance, not per
person**: hiring somebody costs nothing.

**The tax work is free, all of it.** The UK VAT return in the nine boxes
Making Tax Digital expects, the Canadian GST/HST return, US sales tax with the
state nexus thresholds, the EU One Stop Shop return, and a structured EN 16931
e-invoice — every one of those is in this repository, computed from the ledger,
and runs on an instance with no license key at all.

Dropping back to free leaves every record you created in place and in the same
database. The Pro screens simply stop — which means the records only they can
reach, like bills, vendors, budgets and fixed assets, are still readable but no
longer exportable from inside the app. Export those before you cancel.

One other thing worth knowing before you compare: a free instance carries a
"Powered by Sentrello" line on the pages your customers land on — the sign-in
screen, a form's thank-you page, an invoice opened from a link. Replacing it
with your own, or removing it, is a Pro feature.

**[The full comparison, line by line →](https://docs.sentrello.com/docs/free-vs-pro)**

---
## The optional modules

Each is a whole application, not a feature — and each is built so another
module can consume what it produces: the Shop's orders reach Accounting, a
booking becomes an invoice. They need a Pro subscription underneath; none is
sold against the free core.

| Module | What it is | Availability |
|---|---|---|
| **[Booking](https://docs.sentrello.com/docs/modules/booking)** | Diary, availability, who takes which appointment, and a page customers book themselves on | Available |
| **[Shop](https://docs.sentrello.com/docs/modules/shop)** | Products, stock by location, storefront, checkout and payments | Available |
| **[Subscriptions](https://docs.sentrello.com/docs/modules/subscriptions)** | Plans, subscribers, trials, pauses, and a customer who can change or cancel their own | Available |
| **Projects** | Projects, tasks, boards, milestones, and the hours that become invoice lines | Available |
| **[Links](https://docs.sentrello.com/docs/modules/links)** | Short links on your own domain, and the click → signup → sale chain | Available |
| **[Newsletter](https://docs.sentrello.com/docs/modules/newsletter)** | Lists, segments, templates, campaigns and delivery | Available |
| **[Documentation](https://docs.sentrello.com/docs/modules/docs)** | Publishes your own documentation site | Available |
| **[Storage](https://docs.sentrello.com/docs/modules/storage)** | Folders, versions, sharing and retention, with warnings before a certificate lapses | Available |
| **[SEO](https://docs.sentrello.com/docs/modules/seo)** | Keyword research, rank tracking, audits, backlinks, competitors — see below | Available |
| **POS** | Ring up a sale in person, take the money, and the books are written without anybody typing it again. Needs the Shop | **In development — not for sale** |
| **HR** | Records for the people who work for you, and the time off they take | **Being built** |
| **Helpdesk** | Customer questions arriving as tickets in a queue, rather than into one person's inbox | **Being built** |

**POS is not for sale, and has no date.** It was withdrawn from the catalog
on 15 September 2026 on its own review, and most of what that review was
waiting for has since been built: the cash controls a till needs (void, refund,
comp, discount, a blind drawer count, a receipt and the closure it printed), a
card reader the till drives rather than one somebody taps beside it, table
service with floors and sections, a kitchen pass, tips and a mandatory service
charge with the disclosure one lawfully needs, a per-person shift report, two
bills joining into one, a screen the customer reads over the counter, and a
rehearsal mode that posts nothing anywhere.

What is still missing: a thermal printer driver and a drawer that kicks open,
routing between kitchen stations, and fiscalisation — no certified device and
no live link to a tax authority, which is permanent and rules out those
markets that require one.

Nothing here says when it returns, because we do not know. When it does it is a
**plugin**: it needs Shop, it is bought separately at half a module's price,
and it shares Shop's catalog rather than keeping a menu of its own.

**HR and Helpdesk are being built, and are not dated either.** Neither has
code yet, so anything said about them here beyond what they are for would be a
guess with a quarter attached. They are separate modules, split apart on
purpose: a business that wants a ticket queue rarely wants a leave calendar in
the same week.

Projects is a module like the others, bought on its own. It shipped inside Pro
until 15 September 2026, which meant every Pro subscriber got it whether they
wanted it or not and nobody could buy it deliberately.

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

**[What the module does, and how the two options differ →](https://docs.sentrello.com/docs/modules/seo)**

---
## Founder pricing

**v1 shipped on 1 October 2026, and the window is open now.** Everything is
**40% off until 31 December 2026**, and what you start on is what you keep —
through every release, and through every module you add two years from now.
Locked for as long as the subscription stays active, not an introductory rate
that steps up next year. Cancel and the rate leaves with it.

Nothing is sold before it exists: a module that is not finished is not on the
price list, at any price. One that is finished inside the window goes on sale
at the founder price like everything else, so waiting for it costs you nothing.

One window, one set of dates, and nobody gets a better one by asking.

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
    ctx.registerNav({ id: "crm", label: "CRM", group: "Sales", order: 10 });
    ctx.app.get("/api/contacts", requireSession(), requirePermission({ crm: ["read"] }), handler);
  },
});
```

Paid features are gated twice: the loader refuses to register a module the
license doesn't cover, and each route checks permissions independently. Licenses
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
floating point, with tax rates in integer millionths (Quebec's 9.975% QST is
exactly `99750`); and **bookkeeping is
double-entry**, so every financial event posts a balanced journal entry or
throws, and every report is computed from the ledger rather than summed from the
invoice table.
**[Why, and what it means for your books →](https://docs.sentrello.com/docs/core/money)**

---

## Development

```bash
bun install
cp .env.example .env
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL
bun run db:migrate
bun run dev                                       # API + web
```

The tests want a database of their own — they truncate tables, and the gate
refuses to point at the one you are clicking around in:

```bash
docker compose -f docker-compose.dev.yml exec -T postgres \
  createdb -U sentrello sentrello_t_core
export DATABASE_URL=postgres://sentrello:sentrello@localhost:5432/sentrello_t_core

bun test          # every test runs against a real PostgreSQL, not mocks
bun run typecheck
bun run lint
```

Requires [Bun 1.3.14](https://bun.sh) exactly and a Docker runtime.
[CONTRIBUTING.md](CONTRIBUTING.md) covers the DCO sign-off, the house style and
what a good pull request looks like.

---

## Project status

**Stable since 1 October 2026.** The version number stopped being a warning
that day. The free core is built and tested, the install path works end to end
on both Docker and Podman, and a release does not go out until every test in
four repositories is green on a database created that morning.

What that does not mean is that it has been run by a large number of
businesses, because it has not. Expect rough edges and please report them —
an early release fixed the Podman path because somebody hit it, and two faults
in 1.0.0 were found and patched the same night by installing it here from
nothing, the way a stranger would.

Live bank feeds arrived in Pro: a business connects its bank through a data
provider and transactions arrive on their own, alongside the CSV import that is
still there for anyone who would rather not connect anything.

E-invoices are **built, not proven**. The documents this produces carry the EN
16931, Peppol BIS Billing 3.0 and XRechnung 3.0 customisation identifiers, and
the shapes that matter were put through the official validator by hand and
passed — a run on a day, not a step in every build. The network leg exists too:
connect an access point of your own, test it from the settings screen, and an
invoice has a control for it. What has not happened yet is one document making
the round trip on the live network, so that is not claimed until it has.

That gap will not close here, and the reason is worth knowing because it is
also the way round it: an access point issues a test account to the business
holding the contract with them, and Sentrello holds none and does not intend
to. We asked for one and were told exactly that. So ask your own provider for a
sandbox key when you open the account, walk it, and read what comes back before
a real invoice depends on it.

Not yet available, and not promised on any date: QuickBooks or Xero sync,
mobile apps, and the POS.

**Markets:** the United States first, then Canada, the United Kingdom and the
EU. That is a scoping decision, not a shipping restriction — it decides which
tax regimes and statutory features exist at all. **Italy and Poland are
deliberately outside it**: both require every business to file through a
national e-invoicing system, and half-supporting one of those would be worse
than saying plainly that we do not.

---

## Security

Found a vulnerability? **Please don't open a public issue** — email
`security@sentrello.com`. [SECURITY.md](SECURITY.md) has the scope, the response
times you can expect, and what the design already assumes.

---

## License

[GNU AGPLv3](LICENSE). You may run, study, modify and share this software. If
you modify it and offer it to others over a network, you must publish your
changes under the same license.

**Modules are exempt, on purpose.** A [module linking exception](LICENSE) at
the top of the license lets you write a module against `@sentrello/module-sdk`,
load it into Core, and license and sell that module on whatever terms you like.
Core itself stays AGPL — modify Core and those changes are still copyleft — but
the module you wrote is yours.

Pro features and optional modules are separately licensed commercial software
and are not covered by the AGPL.

Built by [Sentrello LLC](https://sentrello.com).
