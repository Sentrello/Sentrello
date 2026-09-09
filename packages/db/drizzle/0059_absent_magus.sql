CREATE TABLE "compliance_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"hipaa" boolean DEFAULT false NOT NULL,
	"idle_timeout_minutes" integer DEFAULT 15 NOT NULL,
	"log_reads" boolean DEFAULT true NOT NULL,
	"require_two_factor" boolean DEFAULT true NOT NULL,
	"risk_assessment_on" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "compliance_settings_organization_id_unique" UNIQUE("organization_id")
);
