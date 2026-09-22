---
title: Check it works
sidebar_position: 4
description: What to try before you put a real business on it.
tags: [setup]
---

# Check it works

Before you rely on an installation, walk one job all the way through. Ten
minutes here is worth more than reading the rest of this site.

## The instance is healthy

```bash
curl -s https://example.com/healthz
```

```json
{
  "status": "ok",
  "database": "ok",
  "version": "0.14.3",
  "tier": "pro",
  "license_valid": true,
  "modules_loaded": ["dashboard", "crm", "invoicing", "accounting"],
  "modules_failed": []
}
```

The field to read is **`modules_failed`**. An instance can be perfectly healthy
and still be missing a module: the application answers, the screen is not
there. When that list is not empty, `sentrello logs` says why.

## Walk one job through

1. **Add a contact.** CRM → Contacts → New.
2. **Send them a quote.** Invoicing → Quotes. Add a line, save, send.
3. **Turn it into an invoice.** From the quote, convert it. The lines, tax and
   customer carry across.
4. **Record a payment.** Mark it paid, or part paid.
5. **Look at the ledger.** Accounting → Journal. There is an entry for the
   invoice and another for the payment, each balanced.

If step five shows what you expect, the parts that matter are working.

## Check email actually leaves

Settings → Email → **Send a test message**. Send it to an address at a
different provider from your own. A message that reaches your own domain proves
much less than one that gets past somebody else's spam filter.

## Check the backup

```bash
sentrello backup
```

Then confirm the file is a real dump rather than an error page in a gzip:

```bash
gzip -dc backups/sentrello-*.sql.gz | grep -c 'CREATE TABLE'
```

A number in the dozens is right. Zero means the backup is worthless, and now is
when you want to know that, not on the day you need it.

:::warning[A backup you have never restored is a hope, not a backup]
Restore one onto a spare server at least once. It is the only way to know how
long it takes and that it works.
:::

## Check the update path

```bash
sentrello update
sentrello status
```

`status` must report the new version. Then `sentrello rollback` and confirm it
reports the previous one. Knowing rollback works is worth more than any single
update.
