CREATE TABLE "transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"account_id" uuid,
	"paid_through_account_id" uuid,
	"contact_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"occurred_at" timestamp DEFAULT now() NOT NULL,
	"reference" text,
	"method" text,
	"description" text,
	"receipt_file_key" text,
	"reversed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "parent_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "archived_at" timestamp;--> statement-breakpoint
CREATE INDEX "transactions_org_date_idx" ON "transactions" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_account_idx" ON "transactions" USING btree ("account_id");--> statement-breakpoint
-- Expenses recorded before Accounting existed become transactions, keeping
-- their ids: the journal entry each one posted names it as `expense:<id>`, and
-- a correction has to be able to find that entry. The old table is left in
-- place and untouched, so a rollback still finds every row where it was.
INSERT INTO "transactions" (
  "id", "organization_id", "kind", "account_id", "amount_cents",
  "occurred_at", "description", "receipt_file_key", "created_at"
)
SELECT
  e."id", e."organization_id", 'expense', e."account_id", e."amount_cents",
  e."spent_at", e."vendor", e."receipt_file_key", e."spent_at"
FROM "expenses" e
WHERE NOT EXISTS (SELECT 1 FROM "transactions" t WHERE t."id" = e."id");
