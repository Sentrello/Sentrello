ALTER TABLE "invoices" ADD COLUMN "early_discount_type" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "early_discount_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "early_discount_days" integer;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "early_discount_taken_cents" integer DEFAULT 0 NOT NULL;