CREATE TABLE "bank_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"match_type" text DEFAULT 'contains' NOT NULL,
	"match_text" text NOT NULL,
	"direction" text DEFAULT 'any' NOT NULL,
	"min_cents" integer,
	"max_cents" integer,
	"account_id" uuid NOT NULL,
	"priority" integer DEFAULT 100 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"times_applied" integer DEFAULT 0 NOT NULL,
	"last_applied_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "bank_provider_reference" text;--> statement-breakpoint
CREATE INDEX "bank_rules_org_idx" ON "bank_rules" USING btree ("organization_id");