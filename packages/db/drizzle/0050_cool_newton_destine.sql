CREATE TABLE "fixed_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"cost_cents" integer NOT NULL,
	"salvage_cents" integer DEFAULT 0 NOT NULL,
	"acquired_on" timestamp NOT NULL,
	"method" text DEFAULT 'straight-line' NOT NULL,
	"life_months" integer NOT NULL,
	"rate_bp" integer,
	"asset_account_id" uuid NOT NULL,
	"expense_account_id" uuid NOT NULL,
	"accumulated_account_id" uuid NOT NULL,
	"depreciated_through" timestamp,
	"disposed_on" timestamp,
	"disposal_proceeds_cents" integer,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "fixed_assets_org_idx" ON "fixed_assets" USING btree ("organization_id");