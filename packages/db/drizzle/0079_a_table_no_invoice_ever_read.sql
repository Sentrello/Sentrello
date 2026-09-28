-- The `credit_notes` table never had a reader. A credit note is, and always
-- was, an invoice row with `kind: "credit_note"` and a `referenceInvoiceId`;
-- every screen and report reads those. The one writer was a duplicate route
-- that also posted the real rows, so any rows here are copies of facts the
-- `invoices` table and the ledger still hold — dropping them loses nothing
-- anything could display.
DROP TABLE "credit_notes" CASCADE;
