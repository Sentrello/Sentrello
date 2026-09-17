---
title: Archiving old data
sidebar_position: 3
description: Take years of old records off your server, keep them safe, and put them back if you ever need to.
tags: [operations]
---

# Archiving old data

After a few years your disk fills up. Change history, webhook logs, old
invoices and old journal entries all keep growing and none of them is doing
anything for you today.

**Settings → Archive and storage** writes those records to a file you can keep
somewhere else, and then removes them from this server. The file is an ordinary
zip. It needs nothing from us to read, now or in ten years.

:::warning This is not a backup
A backup is everything, taken every night, restored whole after a disaster. An
archive is one period of one kind of record, taken once, and removed on
purpose. You need both. See [Backups](/running/backups).
:::

## Nothing is deleted until the archive has been proved readable

This is the part worth understanding, because it is what makes the feature safe
to use:

1. Sentrello works out what the period holds and whether it may be removed.
2. It writes the archive to wherever you have said archives go.
3. **It reads the archive back from there** — not from memory — and checks
   every file inside against its own checksum, and every record count against
   the database.
4. Only then does it remove the local records, and only exactly the records the
   archive was proved to hold.

If anything fails at any point, **nothing is deleted** and the screen tells you
what went wrong in plain words. An archive that cannot be read back is an
archive you still have the originals for.

## Records you are not allowed to delete yet

Invoices, payments and journal entries have to be kept, by law, for years:

| Where you trade | How long |
| --- | --- |
| United Kingdom | 6 years |
| Canada | 6 years |
| United States | 7 years |
| European Union | 10 years |
| Anywhere else, or not set | 10 years |

Sentrello reads this from the country on your business's details
(**Settings → Business**). If you ask to archive-and-delete something inside
that window, it refuses and says why.

**It never refuses the export.** You can take a checksummed copy of any period
at any time and keep every local record — which is often exactly what you want,
for an accountant or for off-site safekeeping.

## What can and cannot be archived

Three kinds of record, chosen in the **Records** box:

- **Change history and webhook deliveries** — every field that changed on every
  record, and every webhook sent about it. Usually the largest thing on your
  disk, and not a statutory record, so no retention window applies.
- **Invoices, credit notes, quotes and payments** — the documents, their lines,
  their tax and the payments against them. Statutory.
- **A closed period's journal** — the ledger entries of a period you have
  closed in **Accounting → Summary**. Statutory, and the books must be closed
  through the whole period before it can be removed.

**Anything a live record still points at is refused.** If a credit note from
last year refers to an invoice from the period you are archiving, or a webhook
delivery still carries a change event, the screen tells you how many records
are holding it and what they are. Take a copy instead, or archive a period that
includes them.

Contacts, companies, products and settings are never archived. A live invoice
must always be able to name its customer.

## Your reports do not change

Archiving a closed period **does not move your trial balance, your profit and
loss, or your balance sheet.** When the detail goes, Sentrello posts one
balanced summary entry per account per month in its place, so every report over
that period reads exactly as it did before.

Nothing is unposted or reversed — the summaries are ordinary journal entries,
and they balance. This is why a period has to be **whole calendar months**: a
report boundary in the middle of an archived month would have no detail left to
answer with.

## Where archives go

**Settings → Archive and storage → Where archives go.** Out of the box, an
archive is written to this instance's own data directory and you download it
from the Archives written list. That frees nothing until you clear the file, so
the usual sequence is: archive, download, check you have it, then **Clear
file**.

If you have storage mounted on the server — a NAS, an external disk, a network
share — put its path in and press **Test connection**. Sentrello writes a test
file there and reads it back before it will trust the folder with anything.

Other destinations appear in the same list as they become available, are
configured on this same screen, and are proved with the same button. You never
edit a file on the server to connect storage.

## Putting an archive back

**Settings → Archive and storage → Put one back.**

- **Check this file** reads the archive and reports what is in it, without
  writing anything anywhere. Use this first, especially on an old file.
- **Restore it** puts the records back into the live tables, under their
  original ids. A restored invoice *is* the invoice: it shows on the customer's
  account, it is found by search, it appears in reports.

Restoring is safe to repeat. Anything already present is left exactly as it is,
so nothing you have edited since can be overwritten. Restoring a closed
period's journal also removes the summary entries that stood in for it, so the
figures are not counted twice.

An archive can only be restored into the business that wrote it.

## What is in the file

Open the zip and you will find:

- `manifest.json` — which business, which period, which version of Sentrello
  wrote it, how many records, and a SHA-256 of every other file.
- `data/*.jsonl` — the records. One JSON object per line, one file per table.
  Any text editor opens them; any programming language reads them.
- `README.txt` — the same, in short, for whoever opens it without this page.

Money is whole cents as an integer: `1234` means 12.34. Dates are UTC.

## Who can do this

Four separate permissions, because they are four different decisions:

| Permission | What it allows |
| --- | --- |
| `archive:read` | See what could be archived, and what has been |
| `archive:create` | Write an archive. Deletes nothing |
| `archive:delete` | **Remove local records** once an archive is verified |
| `archive:connect` | Choose where archives are sent |

Only the owner's role holds `delete` and `connect` by default. Give a
bookkeeper `read` and `create` if you want them taking copies off-site; think
carefully before giving anybody `delete`.
