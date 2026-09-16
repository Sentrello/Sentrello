ALTER TABLE "ledger_settings" ADD COLUMN "vat_scheme" text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_settings" ADD COLUMN "vat_flat_rate_ppm" integer;--> statement-breakpoint
ALTER TABLE "ledger_settings" ADD COLUMN "vat_basis" text DEFAULT 'accrual' NOT NULL;