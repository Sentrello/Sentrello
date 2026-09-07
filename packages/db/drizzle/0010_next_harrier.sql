CREATE TABLE "user_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "user_preferences_org_idx" ON "user_preferences" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "user_preferences_unique_idx" ON "user_preferences" USING btree ("organization_id","user_id","key");