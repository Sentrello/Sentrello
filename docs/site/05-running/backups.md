---
title: Backups
sidebar_position: 2
description: What is backed up, where it goes, and how to prove it works.
tags: [operations]
---

# Backups

Your business lives in one PostgreSQL database. Backing it up is the single
most valuable thing you will do as a self-hoster, and it is already running.

## What happens automatically

A backup runs nightly. Each one is a full dump, **encrypted before it leaves
the machine**, and copied off the server if you have configured somewhere to
put it. Old ones are removed on a schedule so the disk does not fill.

The encryption key lives at `secrets/backup.key` in your installation
directory.

:::danger[Keep the key somewhere else]
A backup you cannot decrypt is not a backup. If the key only exists on the
machine the backup is protecting, a lost server takes both. Copy it somewhere
you would still have after a fire.
:::

## Taking one now

```bash
sentrello backup
```

## Proving it is real

An error page compresses beautifully, and a backup that fails silently looks
exactly like one that worked. Check:

```bash
gzip -dc backups/sentrello-*.sql.gz | grep -c 'CREATE TABLE'
```

A number in the dozens is right. **Zero means the file is worthless**, and the
time to discover that is now.

## Restoring

```bash
sentrello restore backups/sentrello-<stamp>.sql.gz
```

This clears the database and puts the backup in its place. It is deliberately
loud about that.

:::warning[Restore onto a spare server first]
At least once, before you need to. It tells you how long it takes, that the
file works, and that you know the steps — none of which you want to be learning
on the day something has gone wrong.
:::

## What is not in the database

**Uploaded files** — documents, product images, receipts — live on disk in the
data directory, not in the dump. If you use Documents or Shop, back that
directory up as well. Your provider's snapshots cover it; so does any ordinary
file backup.

## Moving to another server

A backup and a restore is the whole move:

1. Install Sentrello on the new machine.
2. Copy the data directory and `secrets/backup.key` across.
3. Restore the most recent dump.
4. Point your domain at the new address.

Keep the old instance stopped rather than deleted until you are satisfied. Two
instances writing to one database is the one arrangement to avoid.
