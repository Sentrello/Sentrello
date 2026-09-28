ALTER TABLE "bills" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "ledger_settings" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb;