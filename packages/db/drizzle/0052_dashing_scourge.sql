CREATE TABLE "vendor_credit_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"credit_id" uuid NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"applied_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vendor_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"vendor_id" uuid,
	"number" text,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"amount_cents" integer NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"notes" text,
	"voided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "vendor_credit_applications_org_idx" ON "vendor_credit_applications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "vendor_credit_applications_bill_idx" ON "vendor_credit_applications" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "vendor_credits_org_idx" ON "vendor_credits" USING btree ("organization_id");