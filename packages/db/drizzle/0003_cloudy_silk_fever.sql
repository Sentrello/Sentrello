CREATE TABLE "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"form_id" uuid NOT NULL,
	"contact_id" uuid,
	"quote_id" uuid,
	"payload" jsonb NOT NULL,
	"origin" text,
	"user_agent" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'contact' NOT NULL,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"redirect_url" text,
	"notify_email" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "forms_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE INDEX "form_submissions_org_idx" ON "form_submissions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");--> statement-breakpoint
CREATE INDEX "forms_org_idx" ON "forms" USING btree ("organization_id");