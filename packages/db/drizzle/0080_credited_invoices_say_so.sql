-- An invoice settled by credit note used to be stamped `paid`, which told the
-- customer money moved when none did. The status recompute now writes
-- `credited` for settlement that was entirely by credit; this brings every
-- row stamped before the word existed into line with it. Nothing here touches
-- the ledger — the journal entries those credits posted are already right.
UPDATE "invoices" i
SET "status" = 'credited'
WHERE i."kind" = 'invoice'
  AND i."status" = 'paid'
  AND i."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "payments" p WHERE p."invoice_id" = i."id"
  )
  AND COALESCE((
    SELECT SUM(c."total_cents") FROM "invoices" c
    WHERE c."reference_invoice_id" = i."id"
      AND c."organization_id" = i."organization_id"
      AND c."kind" = 'credit_note'
      AND c."status" != 'void'
      AND c."deleted_at" IS NULL
  ), 0) >= i."total_cents" - i."early_discount_taken_cents"
  AND EXISTS (
    SELECT 1 FROM "invoices" c
    WHERE c."reference_invoice_id" = i."id"
      AND c."organization_id" = i."organization_id"
      AND c."kind" = 'credit_note'
      AND c."status" != 'void'
      AND c."deleted_at" IS NULL
  );
