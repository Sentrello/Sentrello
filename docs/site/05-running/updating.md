---
title: Updating
sidebar_position: 1
description: One command, and a way back if you need it.
tags: [operations]
---

# Updating

```bash
sentrello update
```

That takes a backup, pulls the new version, fetches any modules your licence
entitles, runs the migrations, and restarts. It takes a few minutes on a small
server.

## What it does, in order

1. **Dumps the database** and refuses to continue if the dump is empty. An
   update that cannot be undone is not one worth starting.
2. **Pulls the image** for the release your licence is offered.
3. **Fetches your modules** at that same version. Modules and Core move
   together — a module several versions behind its Core is a screen missing
   whatever changed.
4. **Runs migrations** *before* restarting. They are additive, so the version
   still serving is unaffected while they run.
5. **Restarts** and waits for the instance to answer.

## Checking it worked

```bash
sentrello status
```

The version it reports must be the one you expected. Ask the instance rather
than looking inside the container — an updater that pulled a new image and
started the old one reports success either way, and that is exactly the failure
this catches.

## Going back

```bash
sentrello rollback
```

Back to the previous version, with the bundles that shipped with it. **Your
data is not changed** — a rollback undoes the code, not the records. If the new
version migrated something you need undone as well, restore the backup the
update took:

```bash
sentrello restore backups/sentrello-pre-update-<stamp>.sql.gz
```

:::tip[Exercise it before you need it]
Update, check the version, roll back, check again. Ten minutes once is worth
more than any amount of confidence. A rollback that has never been run is a
plan, not a capability.
:::

## Updating from the application

**Settings → Updates** offers the same thing from a screen, for people who
would rather not open a terminal. It is the same code path.

## If an update fails

Nothing is lost. Migrations run before the restart, so a failure leaves the
previous version serving. Read `sentrello logs`, fix what it names, and run it
again — updates are safe to repeat.
