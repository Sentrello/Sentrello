---
title: Backups
sidebar_position: 2
description: What a backup contains, what it does not, and how to prove it works.
tags: [operations]
---

# Backups

Your business lives in one PostgreSQL database. Backing it up is the single
most valuable thing you will do as a self-hoster — and the part Sentrello
cannot do for you is the part that matters most.

## Taking one

```bash
sentrello backup
```

That writes `backups/sentrello-<stamp>.sql.gz` in your installation
directory. If you have uploaded files, a `-files.tar.gz` lands beside it,
named after the same moment so putting back last Tuesday's database does not
bring back today's documents.

Sentrello also takes one for you before anything that could go wrong:
`update`, `rollback` and `restore` each begin with a backup and refuse to
continue without one. Those are labelled `pre-update`, `pre-rollback` and
`pre-restore`, and only the last three of each are kept — the ones you took
deliberately are yours, and nothing here deletes them.

## What Sentrello does not do

:::danger[The dump is not encrypted, and it does not leave the machine]
`sentrello backup` writes a plain gzipped SQL file next to the instance it
came from. It holds every customer, every invoice and every email address
your business has. **Nothing copies it off the server and nothing encrypts
it.** A server that catches fire takes the database and every backup of it at
the same moment.

Getting it somewhere else is yours to arrange, and it is one cron line:

```
15 2 * * * cd /opt/sentrello && rclone copy backups remote:sentrello-backups
```

Anything that moves files will do — `rclone`, `restic`, `borg`, your
provider's object storage, a second machine. If what you use encrypts at
rest, so much the better; `restic` and `borg` do.
:::

## What runs on its own

The installer sets up a nightly backup and turns it on: a systemd timer,
`sentrello-backup.timer`, which runs `sentrello backup scheduled` once a day
at a randomised time and keeps the last fourteen. You do not have to arrange
that part, and the installer says so as it finishes.

```bash
systemctl status sentrello-backup.timer
systemctl list-timers sentrello-backup.timer
```

If you installed some other way, or the timer failed to enable — the
installer prints a line in red when it does — the cron equivalent is the same
one command:

```
15 2 * * * cd /opt/sentrello && ./sentrello backup scheduled
```

What still has nobody doing it for you is getting those files off the
machine. That is the paragraph above, and it is the one that matters on the
day the disk goes.

Your provider's nightly snapshot of the whole disk is a reasonable second
line, and it covers the uploaded files as well. It is not a substitute for a
dump you can read: a snapshot restores a machine, and what you usually want
is one database on a machine that is still running.

## Proving it is real

An error page compresses beautifully. A backup that failed silently looks
exactly like one that worked, right down to a plausible file size. So check:

```bash
gzip -dc backups/sentrello-*.sql.gz | grep -c 'CREATE TABLE'
```

A number in the dozens is right. **Zero means the file is worthless**, and the
time to discover that is now.

## Restoring

```bash
sentrello restore backups/sentrello-<stamp>.sql.gz
```

This stops the app, clears the database, puts the backup in its place, and
restores the files archive if it is beside the dump. It is deliberately loud
about that, and it takes a backup of what is there now before it starts.

:::warning[Restore onto a spare server first]
At least once, before you need to. It tells you how long a restore takes, that
the file works, and that you know the steps. None of the three is something you
want to be learning on the day.
:::

## What is not in the database

**Uploaded files** live on disk in the data directory. Documents, product
images, receipts. `sentrello backup` archives them beside the dump, but only
what is under `data/attachments` — if you point Sentrello's file storage
somewhere else, back that up yourself.

## Moving to another server

A backup and a restore is the whole move. The order matters, and step 1 is the
one people skip:

1. **Stop the old instance, then take a fresh backup of it.** `sentrello stop`,
   then `sentrello backup`. Restoring last night's dump instead will lose every
   order, invoice and payment taken since it ran, and nothing in the restore
   will tell you they are gone.
2. Install Sentrello on the new machine.
3. Copy the backup, its files archive, and the data directory across.
4. Restore the dump you took in step 1.
5. Point your domain at the new address.

Leave the old instance stopped rather than deleted until you are satisfied. Two
instances writing to one database is the one arrangement to avoid.
