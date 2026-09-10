CREATE TABLE "consent_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_label" text,
	"purpose" text NOT NULL,
	"granted" boolean NOT NULL,
	"source" text NOT NULL,
	"wording" text,
	"evidence" jsonb,
	"actor_id" text,
	"actor_name" text,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "consent_records_subject_idx" ON "consent_records" USING btree ("organization_id","subject_kind","subject_id","at");--> statement-breakpoint
CREATE INDEX "consent_records_purpose_idx" ON "consent_records" USING btree ("organization_id","purpose","at");