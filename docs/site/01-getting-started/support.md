---
title: Getting help
sidebar_position: 5
description: Where to look, and what to send us when you write.
tags: [support]
---

# Getting help

## Look here first

```bash
sudo sentrello status      # version, tier, modules, licence state
sudo sentrello logs        # what the application is actually saying
curl -s localhost:3000/healthz
```

Most problems announce themselves in one of those three.

## Common situations

The fuller list, with what each failure actually means, is on
[When something is wrong](/running/troubleshooting).

**A module is missing from the sidebar.** Check `modules_failed` in `/healthz`,
then Settings → Licence and updates. Two different things look identical from the sidebar:
a module the licence does not cover never loads at all, while one that tried
and failed writes its reason to the log.

**Sign-in is refused with a message about the origin.** `SENTRELLO_BASE_URL`
does not match the address in the browser. That check is deliberate; correct
the value and restart.

**Email does not arrive.** Check **Settings → Connections** first: with no mail
server connected, nothing is sent and nothing is queued. If it says mail is
working, send an invoice to yourself at another provider — if Sentrello accepts
it and nothing arrives, the message left here and the problem is between your
mail provider and the recipient.

**The licence says it cannot reach the server.** The instance keeps working on
its last good token through a grace period. Check the server can reach
`sentrello.com` over HTTPS.

## When you cannot sign in at all

You own the machine, so there is always a way back in — and it does not require
signing in first, which is the point. Both of these run on the server.

```bash
sudo sentrello unlock <email>                 # repeated failures locked the address
sudo sentrello reset-password <email> [new]   # when no mail is configured to send a link
```

A self-hosted instance often has no mail server and exactly one administrator,
so the usual "email yourself a reset link" is not available and there is nobody
else to ask. Anyone who can run these already holds the machine the database is
on, which is why they exist and why they are not behind a password. An unlock is
recorded as having come from the host.

## After you buy something

```bash
sudo sentrello activate        # sync with whatever the subscription now covers
sudo sentrello add <module>    # fetch one module you have just bought
```

Pro's code is already in the image, so a Pro key needs nothing fetched. An
optional module is a bundle your instance downloads, and the Licence screen does
that itself where the update agent is installed. Where it is not, the screen
says so and names the command.

Either command finishes by asking your instance whether what you paid for is
actually running, and lists it if it is. If something was fetched and did not
start — the wrong build for your processor, a migration that failed on this
machine — it says which module and points you at `sentrello logs app`. That is
the case worth knowing about: the download can succeed, the restart can succeed,
and the feature can still not be there.

## When you write to us

Send the output of `sentrello status`, the relevant lines from
`sentrello logs`, and what you expected to happen instead. With those three we
can usually answer without a second exchange.

Nothing in those outputs contains your customers' data. If you are asked for
anything that does, ask us why.

## Reporting something that looks like a security problem

Write to **security@sentrello.com** rather than opening a public issue, and
give us a reasonable window to fix it before saying anything publicly. We would
much rather hear from you than from somebody else.
