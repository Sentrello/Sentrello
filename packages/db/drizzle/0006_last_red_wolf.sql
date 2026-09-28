-- The old pipeline's rows are discarded here, deliberately.
--
-- They are a different model: one contact, a title, a value. The replacement
-- has a company, several contacts, a category, a close date and an ordering,
-- and there is no honest way to derive those from what was there.
--
-- It also has to happen before the ALTERs below. "ADD COLUMN name text NOT
-- NULL" with no default is rejected outright by Postgres on a table that has
-- rows, so this migration would have passed on an empty development database
-- and failed on every instance that had ever created a deal.
DELETE FROM "deals";--> statement-breakpoint
CREATE TABLE "notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"text" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb,
	"author_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deals" ALTER COLUMN "stage" SET DEFAULT 'opportunity';--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "sector" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "size" integer;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "address" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "city" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "state" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "postcode" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "country" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "revenue" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_name" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_name" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "linkedin_url" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "owner_id" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "emails" jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phones" jsonb;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "contact_ids" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "category" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "amount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "expected_close_on" date;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
ALTER TABLE "deals" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "color" text DEFAULT '#94a3b8' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "contact_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "deal_id" uuid;--> statement-breakpoint
CREATE INDEX "notes_org_idx" ON "notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notes_entity_idx" ON "notes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "deals_stage_idx" ON "deals" USING btree ("organization_id","stage");--> statement-breakpoint
ALTER TABLE "deals" DROP COLUMN "contact_id";--> statement-breakpoint
ALTER TABLE "deals" DROP COLUMN "title";--> statement-breakpoint
ALTER TABLE "deals" DROP COLUMN "value_cents";