CREATE TABLE "payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"mode" text DEFAULT 'test' NOT NULL,
	"public_key" text,
	"secret_key" text,
	"webhook_secret" text,
	"secret_hint" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp,
	"last_test_ok" boolean,
	"last_test_message" text,
	"account_label" text,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_unique" UNIQUE("organization_id","provider","mode")
);
--> statement-breakpoint
CREATE INDEX "payment_accounts_org_idx" ON "payment_accounts" USING btree ("organization_id");