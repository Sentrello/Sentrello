CREATE TABLE "archive_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"set_id" text NOT NULL,
	"period_from" timestamp NOT NULL,
	"period_to" timestamp NOT NULL,
	"archive_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"destination_id" text NOT NULL,
	"locator" text NOT NULL,
	"status" text DEFAULT 'written' NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"removed_rows" jsonb,
	"carried_forward" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"verified_at" timestamp,
	"removed_at" timestamp,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "archive_runs_org_idx" ON "archive_runs" USING btree ("organization_id","created_at");