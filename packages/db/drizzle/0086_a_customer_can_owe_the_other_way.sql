CREATE TABLE "customer_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"cents" integer NOT NULL,
	"payment_id" uuid,
	"invoice_id" uuid,
	"reason" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoicing_settings" ADD COLUMN "overpayment_policy" text DEFAULT 'refuse' NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_credits_org_idx" ON "customer_credits" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customer_credits_contact_idx" ON "customer_credits" USING btree ("contact_id");