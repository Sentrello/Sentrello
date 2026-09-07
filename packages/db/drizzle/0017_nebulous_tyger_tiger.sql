CREATE TABLE "security_policy" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"require_two_factor_for" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"session_days" integer,
	"min_password_length" integer DEFAULT 12 NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_group_members" (
	"group_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"added_by" text,
	CONSTRAINT "user_group_members_unique" UNIQUE("group_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_groups_unique_name" UNIQUE("organization_id","name")
);
--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "base_role" text;--> statement-breakpoint
CREATE INDEX "user_group_members_user_idx" ON "user_group_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX "user_groups_org_idx" ON "user_groups" USING btree ("organization_id");