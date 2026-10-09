---
title: Updating
sidebar_position: 1
description: One command, and a way back if you need it.
tags: [operations]
---

# Updating

```bash
sudo sentrello update
```

That takes a backup, pulls the new version, fetches any modules your license
entitles, runs the migrations, and restarts. On a small server it takes a few
minutes.

## What it does, in order

1. **Dumps the database** and refuses to continue if the dump is empty. An
   update that cannot be undone is not one worth starting.
2. **Pulls the image** for the release your license is offered.
3. **Fetches your modules** at that same version. Modules and Core move
   together, because a module several versions behind its Core is a screen
   missing whatever changed. A Sentrello module your license no longer
   includes is removed. A module you added yourself is left alone.
4. **Starts the new version**, then runs the platform's migrations against it,
   then restarts the app so it picks up the schema it just got.
5. **Waits for the instance to answer**, and says so when it does.

A module brings its own tables, and those are built when the app starts rather
than by the updater — on the licence's say-so, so a module you have not bought
never has its schema touch your database. Which means they are built twice
during an update: once when the new version comes up in step 4, and again on the
restart at the end of it.

That is worth knowing because of what you may see in between. A module whose
tables need something the platform's own migration has not added yet fails the
first time and succeeds on the restart, and in that window `sentrello logs` says
the module did not load. Seconds, and it clears itself. If it is still saying so
after step 5, it is real.

The order matters if something goes wrong, so it is worth being plain about
it: the new image is running before the migrations do. Migrations are
additive, so the schema itself is never left half-formed — but between `up`
and the end of the migration step, what is serving is the new release against
the old schema. That window is seconds long, and the way out of it is
`sentrello rollback` — which is what the update itself tells you if the
migration step fails, and what the section below is about. Not waiting, and not
the backup: the backup is for the case where you want the *data* back as it
was, which a rollback deliberately does not do.

## Checking it worked

```bash
sudo sentrello status
```

The version it reports must be the one you expected. Ask the instance rather
than looking inside the container. An updater that pulled a new image and
started the old one reports success either way, and that is exactly the failure
this catches.

## Going back

```bash
sudo sentrello rollback
```

Back to the previous version, with the bundles that shipped with it. **Your
data is not changed.** A rollback undoes the code, not the records.

If the new version migrated something you need undone as well, restore the
backup the update took:

```bash
sudo sentrello restore backups/sentrello-pre-update-<stamp>.sql.gz
```

:::tip[Exercise it before you need it]
Update, check the version, roll back, check again. Ten minutes once is worth
more than any amount of confidence. A rollback that has never been run is a
plan, not a capability.
:::

## Updating from the application

**Settings → License and updates** offers the same thing from a screen, for people who
would rather not open a terminal. Same code path.

## If an update fails

**Go back, rather than waiting it out.**

```bash
sudo sentrello rollback
```

The rollback target is recorded before the new version is started, and the
database dump from step 1 is on disk, so both halves of the way back exist
before anything you are running has changed. Use them.

The reason to go back rather than retry in place: the new image is already
running by the time migrations run, so a failed migration leaves the new
release serving against a schema it does not expect. That is not a version
quietly carrying on — it is a version that will behave oddly until it is
either migrated or replaced. `sentrello rollback` puts the previous one back.

Then read `sentrello logs`, fix what it names, and run the update again.
Updates are safe to repeat.

One thing in those logs is not a failure: a module reported as not loading
*during* the update, for the reason in step 4. Trust what the update says when it
finishes over the log as it scrolls past. It asks the instance which of the
modules you pay for are actually running, and names any that are not — so a
module that sorted itself out on the restart is not mentioned, and one that did
not is.
