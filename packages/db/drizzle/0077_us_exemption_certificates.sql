CREATE TABLE "exemption_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"state" text NOT NULL,
	"reason" text DEFAULT 'resale' NOT NULL,
	"notes" text,
	"expires_at" timestamp,
	"document_path" text,
	"revoked_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "exemption_certificate_id" uuid;--> statement-breakpoint
CREATE INDEX "exemption_certificates_org_idx" ON "exemption_certificates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "exemption_certificates_company_idx" ON "exemption_certificates" USING btree ("company_id");