---
title: When something is wrong
sidebar_position: 4
description: The three things to check, and what the common failures actually mean.
tags: [operations, support]
---

# When something is wrong

## Start here

```bash
sentrello status          # version, tier, modules, licence
sentrello logs            # what the application is actually saying
curl -s localhost:3000/healthz
```

Most problems announce themselves in one of those three.

## Reading `/healthz`

```json
{
  "status": "ok",
  "database": "ok",
  "version": "0.16.0",
  "tier": "pro",
  "license_valid": true,
  "modules_loaded": ["dashboard", "crm", "invoicing"],
  "modules_failed": []
}
```

The field people miss is **`modules_failed`**. An instance can be perfectly
healthy and still have a module that did not load: the application answers,
`status` says `ok`, and the screen is just not there. If that list is not
empty, the log says why.

## A module is missing from the sidebar

In order:

1. **`modules_failed` in `/healthz`.** If it is named there, the log explains
   it.
2. **Settings → Licence.** A module that is not entitled does not load, and
   does not complain. That is the design.
3. **`sentrello status`.** Confirms which tier the instance believes it is.

A module can also be entitled and not downloaded yet, which an update fixes.

## Sign-in is refused, and mentions the origin

`SENTRELLO_BASE_URL` does not match the address in the browser. If it says
`http://localhost` while people reach `https://example.com`, every sign-in is
refused, correctly. That check is what stops another site posting your login
form.

Fix the value in `secrets/.env` and restart.

## Somebody signs in and sees almost nothing

Their policy grants less than you think. Open them in **Users → People** and
read the **Access** tab, which says what they may actually do and where each
part of it came from. **Users → Policies** shows what each policy allows, read
from the same rules the routes enforce rather than from a second list that
could disagree.

Remember that permissions add up. Somebody holds their own policy plus every
policy carried by a group they are in.

## Nobody can sign in, and there is nobody to ask

Two different problems with the same feel. Both have an answer from the server
itself, and neither needs email configured, which a self-hosted instance may
not have.

**A forgotten password**, when no reset email can be sent:

```bash
sentrello reset-password you@yourbusiness.com
```

It prints a password once, ends every session that account had open, and clears
a lockout if there was one.

**A lockout, when the password is fine.** From **0.18**, which is when the lock
and `sentrello unlock` both arrive. Five wrong passwords in a row lock an
address for fifteen minutes by default. That is deliberate, and it is what
stops guessing running forever. It also means somebody who keeps trying a
half-remembered password locks themselves out, and on a small business that
person is often the only administrator:

```bash
sentrello unlock you@yourbusiness.com
```

Both are recorded in **Users → Events**, the same as if an administrator had
done it from the screen. Anyone who can run them already has shell on the
machine holding your database, so they grant nothing that was not already
available. What they save is doing it by hand with a SQL client.

If the lock keeps coming back for everybody at once, the lock is not your
problem. Your reverse proxy is not passing the visitor's address, so every
attempt looks like it comes from the same place. **Users → Authentication**
shows which header is trusted and what the current request resolved to.

## Email does not arrive

Send a test from **Settings → Email**. If it reports success and nothing
arrives, the message left Sentrello, and the problem is between your provider
and the recipient. Usually SPF or DKIM on your domain.

Send the test to an address at a different provider from your own. A message
that reaches your own domain proves much less than one that survives somebody
else's spam filter.

## The licence says the server cannot be reached

The instance keeps working on its last good token through a grace period, then
falls back to Free. It does not stop.

Check the server can reach `sentrello.com` over HTTPS. If it can and the
message persists, check the key itself in Settings → Licence. A key that is set
but malformed reports as a network problem, which sends people looking in the
wrong place entirely.

## Everything is slow

Look at memory first, and give it more room than feels necessary. Sentrello
idles at roughly 250MB, and a few screens — the journal, a long activities
list, a trial balance over several years — read what they are reporting on
into memory before they answer, so a single request on a business with years
of history can want several times that for a few seconds. On a 1GB server
that is what runs out, and the way it shows is the whole instance restarting
with nothing on screen to say why.

Swap is the cheap insurance: 2GB of it turns an out-of-memory kill into a
slow page. Past a few hundred orders a month, 2GB of memory is the honest
recommendation rather than the minimum.

PostgreSQL is a separate matter and is sized at install time from the machine
it found. Give the server less memory afterwards, or add other things to it,
and the database is working from numbers that no longer describe the machine.

## One page says a query took too long

Something like *"that took longer than this instance allows a single query to
run"*. It is not a fault, and trying again rarely helps: a single database
query hit the ceiling this instance puts on one, which is sixty seconds.

Nothing in Sentrello comes close to that on ordinary data — every report, list
and dashboard answers in well under a second on ten thousand customers — so
one query alone at a minute means either a great deal of history or a machine
working harder than it should be. Look at memory first, as above.

If the job really is that big, raise the ceiling:

```
SENTRELLO_DB_STATEMENT_TIMEOUT=180
```

Seconds, and `0` turns it off entirely. The ceiling exists because a query
that runs for ever holds one of ten database connections while it does, and
ten of those is an instance that answers nothing at all — so turning it off
trades one slow page for the chance of a silent stop.

## The page loads but a section is empty

Almost always permissions rather than data. Open the same page as an
administrator. If the data is there, what you are looking at is what that
person's policy allows.

## Nothing here helped

`sentrello status`, the relevant lines from `sentrello logs`, and what you
expected instead. Send those to **support@sentrello.com** and that is almost
always enough to answer without a second exchange.

None of those outputs contains your customers' data. If you are ever asked for
something that does, ask why.
