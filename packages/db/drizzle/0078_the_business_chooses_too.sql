CREATE TABLE "organization_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "organization_preferences_org_idx" ON "organization_preferences" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_preferences_unique_idx" ON "organization_preferences" USING btree ("organization_id","key");