CREATE TABLE "bank_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"institution_name" text,
	"access_token" text NOT NULL,
	"cursor" text,
	"test_mode" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_provider_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"client_id" text,
	"secret" text NOT NULL,
	"test_mode" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bank_provider_accounts_one_per_provider" UNIQUE("organization_id","provider")
);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "provider_reference" text;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "bank_account_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "category" text;--> statement-breakpoint
CREATE INDEX "bank_connections_org_idx" ON "bank_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_provider_accounts_org_idx" ON "bank_provider_accounts" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_provider_ref" UNIQUE("organization_id","provider_reference");