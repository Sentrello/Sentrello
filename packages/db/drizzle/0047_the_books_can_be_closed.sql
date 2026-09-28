CREATE TABLE "ledger_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"closed_through" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_settings_organization_id_unique" UNIQUE("organization_id")
);
