ALTER TABLE "companies" ADD COLUMN "tax_identifier_valid" boolean;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tax_identifier_checked_at" timestamp;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "tax_identifier_checked_name" text;