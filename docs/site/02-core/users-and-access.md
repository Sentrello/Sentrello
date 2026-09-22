---
title: Users and access
sidebar_position: 1
description: One set of accounts, one set of permissions, used by every module.
tags: [core, security]
---

:::info[New in 0.18]
The Users console described here arrives in **0.18**: seven screens, the audit
log, lockout and suspension. On **0.17** the same accounts and the same
policies exist under **Settings → Users**, as a single screen.
`sentrello status` tells you which version you are running, and
`sentrello update` moves you.
:::

# Users and access

Every module uses these accounts. Nothing in Sentrello keeps a separate list of
logins, so connect a new module and your existing colleagues can use it
straight away, with the access they already have.

**Users** is its own section in the sidebar, with seven screens: People,
Groups, Policies, Sessions, Authentication, Providers and Events.

![Users → Policies: four roles against what each may open, with the Customer role able to see its own invoices and nothing else](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/roles.png)

The **Customer** row is the one worth looking at twice. It is how you hand
somebody outside the business a login without handing them the business: it
sees its own invoices, and there is no setting that widens it.

## People

**Users → People** lists everybody with access. Invite somebody by email; they
set their own password from the link. Nobody types a password for somebody
else.

Open a person and you get their whole record: their details, their
credentials, what they can actually do, which groups they are in, the devices
they are signed in on, and everything that has happened to their account.

An invitation that is never accepted expires.

## Somebody who leaves

**Suspend** an account instead of removing it. Sign-in stops immediately and
every session they have open ends, while the invoices they raised and the notes
they wrote keep their author. Remove them and that history goes with them.

Two things are refused, on purpose: you cannot suspend yourself, and you
cannot suspend or remove the last administrator. An instance with no
administrator cannot be recovered from the browser at all.

## What somebody can actually do

The **Access** tab on a person answers that question directly, resource by
resource. For each thing they may do, it also names **where that came from**.

That matters more than it sounds. Somebody can hold the same permission twice,
once from their own policy and once through a group. Take them out of the group
and nothing changes, because the other route is still open. A screen showing
only one of the two would have you remove the wrong thing.

A resource nobody granted is shown saying so rather than being left out, so
"why can't they do that" has an answer on the same screen.

## Policies and groups

What somebody can do is decided by the **policies** attached to them. A policy
grants specific permissions on specific modules: read invoices, create
contacts, update settings.

Five are set up for you and cover most businesses:

| Policy | Roughly |
|---|---|
| **Admins** | Everything, including settings and other people's access |
| **Executives** | Everything operational; reads the money screens |
| **Managers** | Their team's work, and the customers behind it |
| **Staff** | Day-to-day work; no settings, no books |
| **Customers** | The customer portal only |

**Groups** do the same job for a department: Sales, Marketing, Accounting,
Customer Service. A new joiner gets the right access by being put in the right
group, rather than by somebody remembering fourteen switches. A group has its
own Access tab, which answers the same question about the policies it carries.

Every one of these is yours to change, copy or delete. They are data, not
something compiled into the product.

## Signing in

**Users → Authentication** holds the rules.

**Two-factor authentication** can be turned on by anybody from their own
profile, and required by policy. Per role, that is, rather than for everybody:
the person who can move money is not the person clocking in on a shared
tablet, and a business forced to require both will require neither. Recovery
codes are shown once, at the moment it is enabled.

:::warning[Recovery codes are shown once]
Store them somewhere other than the machine you sign in from. Losing both the
device and the codes means an administrator has to reset the account.
:::

:::info[New in 0.19]
Requiring confirmed email addresses arrives in **0.19**. Everything else on
this page is in 0.18.
:::

**Email addresses can be required to be confirmed** before their owner can
sign in. It is off by default, and it cannot be switched on until you have
configured email; otherwise nobody could confirm an address, yourself included.
Switching it back off is always allowed. Your own address counts as confirmed
from the moment you claim the instance, since you read the setup token off the
server, and that proves rather more than a link in an inbox does.

**Repeated wrong passwords lock an address.** Five in a row by default, for
fifteen minutes. The lock lifts itself. An administrator can clear it from the
person's Credentials tab, and issuing a new password clears it too. Set the
attempt count to zero to turn locking off entirely.

If the locked-out person is your only administrator, there is a way back in
from the server itself that needs no sign-in first. See
**Running it → When something is wrong**, which covers the password and the
lock both.

That screen also tells you two things about your own deployment that stay
invisible until they bite: which header your proxy uses for a visitor's real
address, and whether your address is `https`. Get the header wrong and every
sign-in appears to come from the same place, which means one person guessing
passwords locks out everybody.

## Sessions

**Users → Sessions** shows every device signed in across the business, who it
belongs to and when it was last used. Sign out one, or all of them. A person's
own record has the same list for just them.

## What has happened

**Users → Events** is the audit log: who did what, to whom, and when.
Administrative actions are recorded (invitations, role changes, suspensions,
password resets, group membership) along with sign-in attempts, successful and
failed.

Search it by person, by kind of action, or by a window of time. It is also
what the lock is worked out from, rather than a separate counter that could
disagree with it.

Old entries are pruned to whatever you choose to keep, a year by default. The
prune records itself, because history that could vanish without a trace would
not be much of an audit log.

## How permissions are enforced

Twice, deliberately.

A module only loads if the licence entitles it. Every route inside it then
checks the permission again before doing anything. A screen showing or hiding a
button is a convenience rather than the enforcement: a request made straight to
the API is checked exactly the same way.
