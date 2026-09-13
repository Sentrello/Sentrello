CREATE TABLE "recurring_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"profile_id" uuid NOT NULL,
	"period_start" timestamp NOT NULL,
	"period_end" timestamp NOT NULL,
	"invoice_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "recurring_periods_profile_start_uniq" UNIQUE("profile_id","period_start")
);
--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "billed_through_at" timestamp;--> statement-breakpoint
CREATE INDEX "recurring_periods_org_idx" ON "recurring_periods" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "recurring_periods_profile_idx" ON "recurring_periods" USING btree ("profile_id");