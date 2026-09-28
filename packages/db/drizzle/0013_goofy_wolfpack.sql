CREATE TABLE "module_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"module_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "module_state_org_idx" ON "module_state" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "module_state_unique_idx" ON "module_state" USING btree ("organization_id","module_id");