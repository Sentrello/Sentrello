ALTER TABLE "journal_entries" ADD COLUMN "posted_on" date;--> statement-breakpoint
-- Entries already in the books that were certainly dated by a day.
--
-- `posted_on` says an entry stands for a whole day, so a report reads it on
-- that day wherever the business is. New entries get it from
-- `postJournalEntry`; this marks the old ones where nothing is in doubt:
--
-- - posted at exactly midnight UTC, to the microsecond — an entry stamped
--   with the moment it happened is never that, and a typed day always is;
-- - and from a kind that is only ever dated by a day: an invoice raised, an
--   income or expense recorded, a bill, depreciation, a year end, a currency
--   revaluation, a fixed asset bought or disposed of, a bank line categorised,
--   paid out or moved, a project cost.
--
-- Left alone: payments and manual journals, which are dated by a day or by a
-- moment depending on who typed what, and every entry not at midnight. Those
-- keep being read as instants, exactly as before.
UPDATE "journal_entries"
SET "posted_on" = "posted_at"::date
WHERE "posted_on" IS NULL
  AND "posted_at" = date_trunc('day', "posted_at")
  AND (
    "source" LIKE 'invoice:%'
    OR "source" LIKE 'income:%'
    OR "source" LIKE 'expense:%'
    OR "source" LIKE 'bill:%'
    OR "source" LIKE 'depreciation:%'
    OR "source" LIKE 'year-end:%'
    OR "source" LIKE 'year-end-reopened:%'
    OR "source" IN ('fx-revaluation', 'fx-revaluation-reversal')
    OR "source" LIKE 'asset-purchase:%'
    OR "source" LIKE 'asset-disposal:%'
    OR "source" LIKE 'bank-rule:%'
    OR "source" LIKE 'bank-category:%'
    OR "source" LIKE 'bank-payout:%'
    OR "source" LIKE 'bank-rehome:%'
    OR "source" LIKE 'project-cost:%'
  );
