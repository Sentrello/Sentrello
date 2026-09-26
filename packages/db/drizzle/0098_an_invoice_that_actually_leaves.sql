CREATE TABLE "peppol_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text DEFAULT 'storecove' NOT NULL,
	"api_key" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"sandbox" boolean DEFAULT true NOT NULL,
	"checked_at" timestamp,
	"last_error" text,
	"connected_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "peppol_connections_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "peppol_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider_ref" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"recipient" text,
	"detail" text,
	"sandbox" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "peppol_submissions_invoice_idx" ON "peppol_submissions" USING btree ("organization_id","invoice_id");