---
title: Open source
sidebar_position: 1
description: What the AGPLv3 lets you do with Sentrello Core, and where the commercial line is drawn.
tags: [platform, licence]
---

# Open source

Sentrello Core is public at
[github.com/Sentrello/Sentrello](https://github.com/Sentrello/Sentrello) under
the GNU Affero General Public License v3: run it, study it, modify it, share
it. The AGPL makes one demand in return. Modify it, offer it to others over a
network, and your changes have to be published under the same licence.

## The free tier is not a trial

No licence key, no expiry, no nag, and no cap on how many people use it. What
you get is a working business system rather than a demonstration of one:

- the dashboard
- CRM — contacts, companies and deals
- quotes, invoices and payments
- double-entry bookkeeping
- embeddable forms
- accounts, roles and permissions

All of it is in the repository. Nothing on that list needs a licence to run,
and nothing on it stops working if you never buy anything.

## Where the commercial line sits

Pro features and the optional modules are separately licensed commercial
software, outside the AGPL. They live in their own repositories and install
against a licence.

The split is written into the licence rather than left as policy. A **module
linking exception** at the top of `LICENSE` lets anyone build a module against
`@sentrello/module-sdk`, load it into Core, and license and sell that module on
whatever terms they choose. Changes to Core itself stay copyleft. See
[Extending Sentrello](/platform/extensible) for how that works in practice.

## Contributing

Development runs on Bun against a real PostgreSQL, so `bun test` exercises
every test against an actual database rather than against mocks. `CONTRIBUTING.md`
in the repository covers the house style, what a good pull request looks like,
and the sign-off.

Every commit needs a `Signed-off-by` line, which `git commit -s` writes for
you. No contributor agreement to sign, no form to fill in. The sign-off is the
whole of it.

Found a security problem? Email
[security@sentrello.com](mailto:security@sentrello.com) rather than opening a
public issue. [Security](/platform/security) explains why.
