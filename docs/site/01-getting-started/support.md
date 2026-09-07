---
title: Getting help
sidebar_position: 4
description: Where to look, and what to send us when you write.
tags: [support]
---

# Getting help

## Look here first

```bash
sentrello status      # version, tier, modules, licence state
sentrello logs        # what the application is actually saying
curl -s localhost:3000/healthz
```

Most problems announce themselves in one of those three.

## Common situations

The fuller list, with what each failure actually means, is on
[When something is wrong](/running/troubleshooting).

**A module is missing from the sidebar.** Check `modules_failed` in `/healthz`,
then Settings → Licence. A module that is not entitled does not load, and a
module that failed to load says so in the log.

**Sign-in is refused with a message about the origin.** `SENTRELLO_BASE_URL`
does not match the address in the browser. That check is deliberate; correct
the value and restart.

**Email does not arrive.** Send a test from Settings → Email. If it reports
success but nothing arrives, the message left Sentrello and the problem is
between your mail provider and the recipient.

**The licence says it cannot reach the server.** The instance keeps working on
its last good token through a grace period. Check the server can reach
`sentrello.com` over HTTPS.

## When you write to us

Include the output of `sentrello status`, the relevant lines from
`sentrello logs`, and what you expected to happen instead. That is almost
always enough to answer without a second exchange.

Nothing in those outputs contains your customers' data. If you are asked for
anything that does, ask us why.

## Reporting something that looks like a security problem

Write to **security@sentrello.com** rather than opening a public issue, and
give us a reasonable window to fix it before saying anything publicly. We would
much rather hear from you than from somebody else.
