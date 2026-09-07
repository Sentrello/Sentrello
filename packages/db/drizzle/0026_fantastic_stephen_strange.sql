CREATE TABLE "bill_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bill_id" uuid NOT NULL,
	"description" text NOT NULL,
	"quantity_milli" integer DEFAULT 1000 NOT NULL,
	"unit_price_cents" integer NOT NULL,
	"account_id" uuid,
	"tax_definition_id" uuid,
	"tax_rate_bp" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bill_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"bill_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"paid_at" timestamp DEFAULT now() NOT NULL,
	"method" text,
	"reference" text,
	"paid_through_account_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"vendor_id" uuid,
	"number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"bill_date" timestamp DEFAULT now() NOT NULL,
	"due_date" timestamp,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"receipt_file_key" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"deleted_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "budget_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"budget_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"month" integer DEFAULT 0 NOT NULL,
	"amount_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"year" integer NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "exchange_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"code" text NOT NULL,
	"rate_micro" integer NOT NULL,
	"as_of" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "is_bank" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "bank_account_last4" text;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "applies_to" text DEFAULT 'both' NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "compound" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "withholding" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "regime" text;--> statement-breakpoint
ALTER TABLE "tax_definitions" ADD COLUMN "jurisdiction" text;--> statement-breakpoint
CREATE INDEX "bill_lines_bill_idx" ON "bill_lines" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "bill_payments_org_idx" ON "bill_payments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bill_payments_bill_idx" ON "bill_payments" USING btree ("bill_id");--> statement-breakpoint
CREATE INDEX "bills_org_idx" ON "bills" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bills_vendor_idx" ON "bills" USING btree ("vendor_id");--> statement-breakpoint
CREATE INDEX "budget_lines_budget_idx" ON "budget_lines" USING btree ("budget_id");--> statement-breakpoint
CREATE INDEX "budgets_org_idx" ON "budgets" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "exchange_rates_org_code_idx" ON "exchange_rates" USING btree ("organization_id","code");