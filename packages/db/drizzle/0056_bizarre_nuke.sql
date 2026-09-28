CREATE TABLE "contractor_tax_details" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid NOT NULL,
	"reportable" boolean DEFAULT true NOT NULL,
	"legal_name" text,
	"entity_type" text,
	"tax_id" text,
	"tax_id_last4" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" text,
	"country" text DEFAULT 'US' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contractor_tax_details_contact" UNIQUE("organization_id","contact_id")
);
--> statement-breakpoint
CREATE INDEX "contractor_tax_details_org_idx" ON "contractor_tax_details" USING btree ("organization_id");