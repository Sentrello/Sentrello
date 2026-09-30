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
   missing whatever changed.
4. **Starts the new version**, then runs migrations against it, then restarts
   the app so it picks up the schema it just got.
5. **Waits for the instance to answer**, and says so when it does.

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

The rollback target is recorded before anything is pulled, and the database
dump from step 1 is on disk, so both halves of the way back exist from the
first second of the update. Use them.

The reason to go back rather than retry in place: the new image is already
running by the time migrations run, so a failed migration leaves the new
release serving against a schema it does not expect. That is not a version
quietly carrying on — it is a version that will behave oddly until it is
either migrated or replaced. `sentrello rollback` puts the previous one back.

Then read `sentrello logs`, fix what it names, and run the update again.
Updates are safe to repeat.
