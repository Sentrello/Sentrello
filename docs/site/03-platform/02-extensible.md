---
title: Extending Sentrello
sidebar_position: 2
description: One module contract for every feature, and the licence exception that lets you sell modules of your own.
tags: [platform, modules, sdk]
---

# Extending Sentrello

Sentrello is one deployable service that discovers its feature modules at
startup. One container to run, one database to back up. For a business with no
operations team, that is the right trade.

Every feature implements the same contract, free and paid alike. The CRM in the
free core and a commercial module bought years later are the same kind of
object to the host.

## The module contract

```ts
import { requirePermission, requireSession } from "@sentrello/auth/hono";
import { defineModule } from "@sentrello/module-sdk";

export default defineModule({
  id: "crm",
  tier: "free",
  register(ctx) {
    ctx.registerNav({ id: "crm", label: "Contacts", order: 10 });

    ctx.app.get(
      "/api/contacts",
      requireSession(),
      requirePermission({ crm: ["read"] }),
      async (c) => c.json({ contacts: [] }),
    );
  },
});
```

Three things are worth reading off that:

- **`id` and `tier` are what the host loads against.** A module whose tier the
  licence does not cover is never registered. Its routes do not exist and its
  screens are never served, as opposed to being served and then hidden.
- **`register` receives the application**, so a module owns its own routes
  instead of asking the host to add them.
- **The route still checks its own permissions.** Entitlement says the business
  bought the module; permission says this account may use it. Both are
  required, and they answer differently. An unentitled request gets a 404,
  because the feature genuinely is not there. An unpermitted one gets a 403.

Beyond routes and navigation, a module can register dashboard widgets, account
sections, summary figures, computed columns, payment webhooks, background jobs,
retention rules and a personal-data reader. That last one is why a subject
access request can answer across every installed module at once. See
[Compliance](/platform/compliance).

## Modules combine

Each module is a whole application rather than a feature, and is built so
another module can consume what it produces. The Shop's orders reach
Accounting. A booking becomes an invoice. An admin connects them; neither
module was written knowing about the other.

## Write a module of your own

The licence carves this out deliberately. The **module linking exception** at
the top of `LICENSE` lets you write a module against `@sentrello/module-sdk`,
load it into Core, and license and sell it on whatever terms you like. Core
stays AGPL, so changes to Core remain copyleft, but the module belongs to
whoever wrote it.

The SDK is published from the same public repository as the free core, so the
contract you build against is the contract the free modules use. There is no
private extension API.
