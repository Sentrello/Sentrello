ALTER TABLE "bill_payments" ADD COLUMN "withheld_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "recoverable" boolean DEFAULT true NOT NULL;