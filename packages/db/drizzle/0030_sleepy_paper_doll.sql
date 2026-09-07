ALTER TABLE "billable_items" ADD COLUMN "billing_interval" text;--> statement-breakpoint
ALTER TABLE "billable_items" ADD COLUMN "billing_interval_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "kind" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "plan_item_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "quantity" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "unit_price_cents" integer;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "tax_rate_bp" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "tax_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "started_at" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "trial_ends_at" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "cancel_at" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "cancelled_at" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "external_ref" text;