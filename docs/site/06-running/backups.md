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
sudo sentrello backup
```

That writes `backups/sentrello-<stamp>.sql.gz` in your installation
directory. If anybody has uploaded files, a `-files.tar.gz` lands beside it,
named after the same moment so putting back last Tuesday's database brings
back last Tuesday's documents with it. Moved Storage off the data directory?
Then a `-storage.tar.gz` joins them, with the same stamp.

Sentrello also takes one for you before anything that could go wrong:
`update`, `rollback` and `restore` each begin with a backup and refuse to
continue without one. Those are labeled `pre-update`, `pre-rollback` and
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
`sentrello-backup.timer`, which runs `sentrello backup scheduled` once a day,
at a random moment in the hour after midnight on the server's clock, and keeps
the last fourteen. You do not have to arrange
that part, and the installer says so as it finishes.

**It also takes the first one there and then**, so you can see where they land
and so a timer that cannot run says so while you are still watching. If that
first run fails, the installer says so in red and gives you the command that
shows why. The nightly one would have failed the same way, quietly.

```bash
systemctl status sentrello-backup.timer
systemctl list-timers sentrello-backup.timer
```

**And you can see it without leaving the product.** The dashboard's *This
server* panel has a Backups line: how many are being kept when the last one
worked, the reason when it did not, and how long ago when the timer has stopped.
"none reported" means nothing has ever told the application a backup was taken —
which is what an instance installed some other way looks like, and what a timer
that was never enabled looks like too.

If you installed some other way, or the timer failed to enable — the
installer prints a line in red when it does — the cron equivalent is the same
one command, in root's crontab (`sudo crontab -e`), with the full path because
cron's own PATH leaves `/usr/local/bin` out:

```bash
15 2 * * * cd /opt/sentrello && /usr/local/bin/sentrello backup scheduled
```

**Two instances on one machine** get a timer each: the second one's units are
named after its directory, so `/opt/sentrello-demo` gets
`sentrello-backup-demo.timer`, and neither can take over the other's schedule. The plain names belong to an instance
at `/opt/sentrello`, which is where the installer puts one unless you say
otherwise.

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
sudo sentrello restore backups/sentrello-<stamp>.sql.gz
```

This stops the app, clears the database, puts the backup in its place, and
restores the files archives that sit beside the dump. Storage's archive goes
back to wherever Storage keeps its files now. It is deliberately loud
about that, and it takes a backup of what is there now before it starts.

:::warning[Restore onto a spare server first]
At least once, before you need to. It tells you how long a restore takes, that
the file works, and that you know the steps. None of the three is something you
want to be learning on the day.
:::

## What is not in the database

**Uploaded files** live on disk in the data directory: documents, receipts,
logos, product images, files people sent through a form. `sentrello backup`
archives every folder under `data` beside the dump.

Storage can live somewhere else. Set `SENTRELLO_FILES_DIR` in
`secrets/.env` to a path inside the container, mount a folder of the server's
there in `docker-compose.yml`, and the backup follows it: it reads the mount to
find the folder on the server and archives that as `-storage.tar.gz`. If it
can't find one, because nothing is mounted at that path, the backup still
takes the dump and tells you those files are not in it.

## Moving to another server

A backup and a restore is most of the move. Two of these steps are the ones
people skip, and they are steps 1 and 4.

1. **Stop the old instance, then take a fresh backup of it.** `sentrello stop`,
   then `sentrello backup`. Restoring last night's dump instead will lose every
   order, invoice and payment taken since it ran, and nothing in the restore
   will tell you they are gone.
2. Install Sentrello on the new machine.
3. Copy the backup, its files archive, and the data directory across.
4. **Carry two values over from the old `secrets/.env`.** Open both files and
   copy these lines from the old one into the new one, leaving everything else
   in the new file alone:

   - `BETTER_AUTH_SECRET` — the key every credential in the database is
     encrypted with. Skip it and the database restores perfectly while every
     credential in it becomes unreadable: your payment processor, your mail
     provider, a Peppol access point. Nothing is lost that cannot be pasted in
     again, but you will be pasting all of it, and the audit log will read as
     though somebody had altered it.
   - `SENTRELLO_SECRET_KEY`, if you ever set one. It takes the place of
     `BETTER_AUTH_SECRET` for the credentials, so the same thing happens
     without it.
   - `SENTRELLO_INSTANCE_ID` — how your license knows this is the same install
     rather than a second one. Carry it and step 7 is already done.

   Not the whole file. The new install generated its own database password and
   its own address, and both of those belong to the new machine.
5. Restore the dump you took in step 1.
6. Point your domain at the new address.
7. **If you did not carry `SENTRELLO_INSTANCE_ID` over, release the old
   install.** To your license the new machine is a second install, and a license
   allows a set number. Open [the license page](https://sentrello.com/license),
   paste your key, release the install you no longer run, then `sentrello
   activate` on the new server. Until you do, the new instance runs as Free and
   Settings → License and updates says why.

Leave the old instance stopped rather than deleted until you are satisfied. Two
instances writing to one database is the one arrangement to avoid.

### Changing domain at the same time

Set `SENTRELLO_BASE_URL` in the new `secrets/.env` to the address people will
type. It is what signing in is checked against, so an old address left in there
refuses every sign-in — correctly, and with a message saying so.
