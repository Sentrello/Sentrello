CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"token_hash" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"expires_on" timestamp,
	"revoked_at" timestamp,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_token_hash_idx" ON "api_keys" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");