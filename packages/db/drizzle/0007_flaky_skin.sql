CREATE TABLE "organization_role" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"role" text NOT NULL,
	"permission" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "organization_role_org_idx" ON "organization_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "organization_role_name_idx" ON "organization_role" USING btree ("role");