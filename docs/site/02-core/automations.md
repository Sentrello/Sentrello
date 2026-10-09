---
title: Automations
sidebar_position: 6
description: Rules your business writes about its own records: when this happens, do that.
tags: [pro, crm, automations]
---

# Automations

**When a deal's stage becomes won: wait two days, put a task on somebody's list,
email the customer.** That is an automation. It is also the difference between
a business that remembers to follow up and one that means to.

Automations are part of **Pro**, under CRM → Automations.

![Writing a rule: when this happens, do this](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/crm-automation.png)

## The shape of a rule

Every automation is two halves.

**When this happens.** A record, what happens to it, and optionally which field
has to change and what has to be true.

**Do this.** Steps, in order. Each one runs only if the one before it did.

## Three kinds of rule

**Something changes.** A deal is won, a contact is created, a field moves.

**A time comes round.** Every day, every week on a day, every month on a date.

**An outside system calls.** Publishing the rule mints a secret address; a
request to it starts the rule with whatever was posted. For the shop cart on
somebody else's site, the form on a landing page, the tool nobody has an
integration for.

The second is the one people forget they need, and it covers the other half of
the work: a quote nobody answered, a deal gone quiet, a renewal three weeks out.
**Nothing changes when something fails to happen.** No event fires, so the
follow-up that matters most is precisely the one nothing can trigger.

![A rule that runs every Monday at nine](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/crm-automation-schedule.png)

A scheduled rule runs **once for each record that matches its conditions**:
"for each deal still sitting in proposal, chase it". The steps are the same
steps.

Four things worth knowing about schedules:

- **A missed one is not made up.** If the server was off all weekend, Monday
  morning runs Monday's chase, not Saturday's and Sunday's as well.
- **A month too short runs on its last day.** Setting the 31st means month-end,
  including February.
- **The time is your business's own**, set under Settings → Your business and
  filled in from your browser when the instance was claimed. Clear it and the
  server's clock is used instead, and a server rented in another country keeps
  that country's hours — Monday's chase then goes out on Sunday evening.
- **At most 200 records a firing.** If more matched, the run list says so rather
  than quietly doing fewer.

## Choosing what sets it off

| Setting | What it means |
|---|---|
| **Record** | Deal, Contact, Company or Task |
| **What happens to it** | Created, changed, deleted, or any of them |
| **Only when this field changes** | Narrows it to a real change in that field |
| **Conditions** | What must be true of the record |

**"Only when this field changes" is the setting that matters most**, and the one
people miss. Leave it empty and a rule saying "a deal whose stage is won" fires
again every time anybody edits that deal afterwards: the description, a note, a
phone number. Your customer gets the congratulations email once a week, for
ever.

With `stage` in that box, the rule only fires on a save that actually moved the
stage.

### Conditions

A condition is a field, a test, and a value. Two of the tests are about the
**change** rather than the state, and they are usually what you want:

- **changes to**: true once, on the save that made it so
- **changes from**: true once, on the save that moved it away

The rest ask about the record as it now stands: *is*, *is not*, *contains*,
*is empty*, *is not empty*, *is more than*, *is less than*.

You can reach into a record's shape with a dot: `address.city`.

## What a rule can do

| Step | What it does |
|---|---|
| **Only carry on if…** | Stops the whole rule unless the conditions hold |
| **Wait** | Days, hours or minutes. Survives a restart |
| **Put a task on somebody's list** | With a title and a due date |
| **Send an email** | To an address, or to the record's contact |
| **Change a field** | On the record the rule is about |
| **Take one path or another** | A choice, with steps under each answer |
| **Ask a person first** | Waits for a yes. A week by default, and silence is a no |
| **For each matching record** | Runs the steps under it once per record found |
| **Tell another system** | Calls a web address of yours with what happened |

### One rule that does two things

Each step has **Only do this step for some records**. Put a condition on it and
the step runs for the records that match and is skipped for the rest, while the
rule itself carries on.

That is how one rule handles both sides of something:

> When a deal changes stage
> → congratulate them, **only if** the stage is won
> → ask what happened, **only if** the stage is lost

**This is different from "Only carry on if…".** A filter stops the whole rule; a
condition on a step skips that step and moves to the next one. Both appear in the
run log, so a step that was not for this record says so rather than being
missing.

### Putting the record into what you write

Anywhere you type text, `{{record.name}}` becomes that record's name. The
record is the row itself, so the names are the ones the product stores: a
deal's amount is `{{record.amountCents}}`, its stage is `{{record.stage}}`, a
contact's address is `{{record.email}}`. A later step can read an earlier one:
`{{steps.chase.id}}`.

**Money is written as money.** `{{record.amountCents}}` produces `2,500.00`
rather than a count of cents — anything whose name ends in `Cents` is treated
as an amount, and that is every money column in the product. Say which
currency in your own words beside it; the automation does not guess.

A value that is not there leaves a blank rather than the word "undefined",
which means a placeholder naming a field the record does not have sends an
email with a hole in it and no complaint. Send yourself a test run before you
point one at a customer.

### Email and consent

**Marketing email is only sent to people who have agreed to it.** Sentrello
already records that agreement: the newsletter signup writes it, and the
contact screen shows it. An automation is checked against the same record.

If a contact has not agreed, the rule **stops and says so**: *that contact has
not agreed to marketing email*. It is recorded as the automation working
correctly, not as a failure, because it is.

**That holds however the address got there.** Leave the address blank and the
rule looks up the record's contact; type one in, and it is looked up among your
own contacts and held to the same rule. An address belonging to nobody here
stops too — there is no agreement on file to read, and marketing to a list this
instance cannot account for is the thing the rule exists to prevent. The run log
names the address and what to change.

Set **What kind of message** to *About something they bought* for messages that
are not marketing: "your invoice is attached", "your order has shipped". Those
need no consent and are never held back.

### Telling another system

Post to a chat channel, nudge a warehouse, call an app somebody wrote. Give it an
address, a method, and what to send, with the record in it:

```json
{"deal": "{{record.name}}", "worth": "{{record.amountCents}}"}
```

Two things it will refuse, and both are deliberate:

- **An address inside your own network.** `localhost`, `192.168.x.x`, `10.x.x.x`,
  and a cloud host's metadata service are all refused, including domains that
  point at them. The server making the call is *inside* your network, and an
  automation that could reach into it would be a way for anybody who can write
  rules to read the machine.
- **Plain http**, unless you say so explicitly. A webhook carrying your business
  data over http can be read by anything on the path.

If the other end answers with an error, the run **fails and says which error**.
An automation that reported success because a request was made would tell you it
had informed the warehouse every time the warehouse said no.

## Running one by hand

Open an automation and use **Run it on one record**. It earns its place twice
over: while you are deciding whether to trust a new rule, and long afterwards
for the cases a rule cannot describe. *Chase this one*, where the judgement is
yours and only the doing is automatic.

**It is not a preview.** It does everything the rule does: sends the emails,
writes the tasks. A rehearsal for a different performance would be worth nothing.

A paused automation cannot be run by hand either. Turn it back on first.

## Nothing runs until you turn it on

**Editing an automation never changes what is running.** Saving keeps a draft.
The version that is live stays live until you publish.

That is deliberate, and it is the thing people get wrong about automation
elsewhere: a half-finished rule firing on real customers, sending real email, is
the worst thing this feature can do. The screen tells you which version is
running and that what you are looking at is not it.

**Pause it** stops it without deleting anything, and it remembers which version
was running, which is usually the thing you want to look at next.

**Every version is kept, and any of them can be made live again.** The Versions
list shows when each was published and which is running; press *Go back to this*
on an older one. That is what you want at the worst moment this feature can
give you: a rule you published ten minutes ago doing something wrong to real
customers. Rewriting it from memory under that pressure is how the second
mistake happens.

## Seeing what it did

Every firing is kept, with each step, what it produced, and why anything
stopped — for ninety days. After that the detail is emptied and the line itself
stays for two years, which is what keeps "how often did this run" answerable
without holding on to everybody's data to answer it. Both windows are yours to
change on the Automations screen, and nought means for ever.

![A run, step by step](https://raw.githubusercontent.com/Sentrello/Sentrello/main/docs/images/crm-automation-run.png)

| Outcome | What it means |
|---|---|
| **done** | Every step ran |
| **stopped** | A filter did not pass, or a step declined — with the reason |
| **failed** | Something went wrong, with the reason |
| **waiting** | It is part-way through a wait |

An automation whose workings you cannot see is one nobody dares turn on. "It ran"
is not an answer to "so why did nothing happen".

### Running a firing again

A run that failed because the other end was down, or stopped on something you
have since fixed, can be sent through again. Open the run and press **Run it
again**. It works from the record as that run saw it, and through the version
of the automation that ran, not from the record as it looks now. A deal that
was won on Tuesday is still the deal that was won on Tuesday.

Like running one by hand, it does everything for real. It needs the run to
have finished, the automation to be turned on, and the permission to manage
automations.

## The safety rails

Worth knowing, because they are the things that go wrong with automation
everywhere else:

- **An automation acts as the person who published it.** It can never do more
  than they can, so writing a rule is not a way around your own permissions.
- **A rule's own work does not set off other rules**, unless you say it should.
  "On update, update" is the first automation anybody builds by accident.
- **Chains stop at five deep**, even when you do ask for them.
- **One change fires a rule once**, however many times the system notices it.
- **Publishing needs its own permission** (`manage` on the CRM). Somebody who can
  edit a deal can change one deal; somebody who can publish an automation can
  change every deal that ever matches it.

## How quickly it happens

Usually within a second. Guaranteed within a minute: changes are written down and
swept regularly, so a restart, a crash or a deploy costs a minute rather than the
automation.

A **wait** is exact to the minute it sweeps, not to the second.

Times are read in the timezone set under Settings → Your business, so nine o'clock
means nine where you are rather than where your server is.

## What is not here yet

- **Anything that pauses, inside a *for each*.** A wait, an approval, a choice
  or another loop inside a loop would need the rule's one resume marker to
  remember a place inside a place, so each is refused by name when you add it
  rather than failing halfway through a run. Everywhere else a choice inside a
  choice is fine.
- **Choosing your own times** beyond daily, weekly and monthly: the fourth
  Tuesday, or twice a day. Ask if you need one.

There is deliberately **no step that runs code**. Some tools offer one; inside a
server you host yourself, that is a security surface bought for a convenience,
and an HTTP step covers the same ground without it.
