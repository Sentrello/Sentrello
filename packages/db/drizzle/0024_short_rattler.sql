ALTER TABLE "companies" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "custom_fields" jsonb;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "custom_values" jsonb DEFAULT '{}'::jsonb;