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
it. The AGPL makes one demand in return. Modify it and offer it to others over
a network, and those changes have to be published under the same licence.

## The free tier is not a trial

There is no licence key, no expiry and no nag, and the number of users is not
capped. What you get is a working business system rather than a demonstration
of one:

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
software and are not covered by the AGPL. They live in their own repositories
and are installed against a licence.

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

Every commit needs a `Signed-off-by` line — `git commit -s` writes it. There is
no contributor agreement to sign and no form to fill in; the sign-off is the
whole of it.

Found a security problem? Email
[security@sentrello.com](mailto:security@sentrello.com) rather than opening a
public issue. [Security](/platform/security) explains why.
