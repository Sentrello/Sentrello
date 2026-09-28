CREATE TABLE "bank_reconciliations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"account_id" uuid NOT NULL,
	"statement_date" timestamp NOT NULL,
	"statement_balance_cents" integer NOT NULL,
	"opening_balance_cents" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"completed_by" text
);
--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD COLUMN "reconciliation_id" uuid;--> statement-breakpoint
CREATE INDEX "bank_reconciliations_org_idx" ON "bank_reconciliations" USING btree ("organization_id");