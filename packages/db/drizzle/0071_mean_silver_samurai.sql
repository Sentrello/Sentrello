ALTER TABLE "invoice_lines" ADD COLUMN "taxes" jsonb;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "taxes" jsonb;