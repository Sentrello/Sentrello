CREATE TABLE "contact_duplicate_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"first_id" uuid NOT NULL,
	"second_id" uuid NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "contact_duplicate_dismissals_pair" UNIQUE("organization_id","first_id","second_id")
);
--> statement-breakpoint
CREATE TABLE "contact_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kept_id" uuid NOT NULL,
	"merged_id" uuid NOT NULL,
	"merged_record" jsonb NOT NULL,
	"moved" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_id" text,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "contact_merges_org_idx" ON "contact_merges" USING btree ("organization_id");