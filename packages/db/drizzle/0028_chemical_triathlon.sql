ALTER TABLE "bills" ADD COLUMN "rate_micro" integer DEFAULT 1000000 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "base_currency" text DEFAULT 'USD' NOT NULL;