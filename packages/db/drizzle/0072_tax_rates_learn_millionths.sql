ALTER TABLE "bill_lines" ADD COLUMN "tax_rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "document_taxes" ADD COLUMN "rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "tax_rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "tax_rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "rate_ppm" integer;--> statement-breakpoint
-- Lossless backfill: a basis point is exactly 100 millionths, so every stored
-- rate reads back as the identical rate, and every document written before
-- this migration totals to the same cent it always did. Rows written by code
-- that predates the column stay null and are read as rate_bp × 100.
UPDATE "tax_definitions" SET "rate_ppm" = "rate_bp" * 100 WHERE "rate_ppm" IS NULL;--> statement-breakpoint
UPDATE "document_taxes" SET "rate_ppm" = "rate_bp" * 100 WHERE "rate_ppm" IS NULL;--> statement-breakpoint
UPDATE "invoice_lines" SET "tax_rate_ppm" = "tax_rate_bp" * 100 WHERE "tax_rate_ppm" IS NULL;--> statement-breakpoint
UPDATE "quote_lines" SET "tax_rate_ppm" = "tax_rate_bp" * 100 WHERE "tax_rate_ppm" IS NULL;--> statement-breakpoint
UPDATE "bill_lines" SET "tax_rate_ppm" = "tax_rate_bp" * 100 WHERE "tax_rate_ppm" IS NULL;--> statement-breakpoint
UPDATE "recurring_profiles" SET "tax_rate_ppm" = "tax_rate_bp" * 100 WHERE "tax_rate_ppm" IS NULL;
