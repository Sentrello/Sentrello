CREATE TABLE "crm_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"deal_stages" jsonb,
	"task_types" jsonb,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crm_settings_organization_id_unique" UNIQUE("organization_id")
);
