CREATE TABLE "recurring_bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"vendor_id" uuid,
	"name" text,
	"interval" text NOT NULL,
	"interval_count" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp NOT NULL,
	"ends_on" timestamp,
	"template_bill_id" uuid NOT NULL,
	"generated_count" integer DEFAULT 0 NOT NULL,
	"last_generated_at" timestamp,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "recurring_bills_org_idx" ON "recurring_bills" USING btree ("organization_id");