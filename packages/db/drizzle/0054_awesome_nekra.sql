CREATE TABLE "dimensions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"code" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "class_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "location_id" uuid;--> statement-breakpoint
CREATE INDEX "dimensions_org_idx" ON "dimensions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "journal_lines_class_idx" ON "journal_lines" USING btree ("class_id");--> statement-breakpoint
CREATE INDEX "journal_lines_location_idx" ON "journal_lines" USING btree ("location_id");