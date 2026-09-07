CREATE TABLE "invoicing_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"default_due_days" integer DEFAULT 30 NOT NULL,
	"default_payment_terms" text,
	"default_template_id" uuid,
	"late_fee_type" text,
	"late_fee_value" integer DEFAULT 0 NOT NULL,
	"late_fee_grace_days" integer DEFAULT 7 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "invoicing_settings_organization_id_unique" UNIQUE("organization_id")
);
