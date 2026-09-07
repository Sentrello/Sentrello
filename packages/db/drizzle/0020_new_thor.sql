CREATE TABLE "billable_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"unit" text DEFAULT 'piece' NOT NULL,
	"kind" text DEFAULT 'service' NOT NULL,
	"tax_definition_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_taxes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"document_type" text NOT NULL,
	"document_id" uuid NOT NULL,
	"tax_definition_id" uuid,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"category_code" text DEFAULT 'S' NOT NULL,
	"taxable_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"html" text NOT NULL,
	"css" text,
	"applies_to" text DEFAULT 'invoice' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quote_instalments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"quote_id" uuid NOT NULL,
	"invoice_id" uuid,
	"seq" integer NOT NULL,
	"share_bp" integer NOT NULL,
	"label" text NOT NULL,
	"due_date" timestamp
);
--> statement-breakpoint
CREATE TABLE "reminder_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"invoice_id" uuid NOT NULL,
	"rule_id" uuid,
	"sent_at" timestamp DEFAULT now() NOT NULL,
	"sent_to" text
);
--> statement-breakpoint
CREATE TABLE "reminder_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"days_offset" integer NOT NULL,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tax_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"rate_bp" integer NOT NULL,
	"category_code" text DEFAULT 'S' NOT NULL,
	"description" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recurring_profiles" ALTER COLUMN "template_json" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "billable_item_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "quantity_milli" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "unit" text DEFAULT 'piece' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "tax_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_lines" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "kind" text DEFAULT 'invoice' NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "reference_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_type" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "payment_terms" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "first_viewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "last_viewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "late_fee_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "late_fee_applied_at" timestamp;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "created_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "billable_item_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "quantity_milli" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "unit" text DEFAULT 'piece' NOT NULL;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "tax_definition_id" uuid;--> statement-breakpoint
ALTER TABLE "quote_lines" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "issue_date" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "valid_until" timestamp;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "discount_type" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "discount_value" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "discount_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "share_token" text;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "published" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "first_viewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "last_viewed_at" timestamp;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "view_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "template_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "converted_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "quotes" ADD COLUMN "deleted_at" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "name" text;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "interval_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "ends_on" timestamp;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "template_invoice_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "auto_send" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "generated_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "last_generated_at" timestamp;--> statement-breakpoint
CREATE INDEX "billable_items_org_idx" ON "billable_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "document_taxes_doc_idx" ON "document_taxes" USING btree ("document_type","document_id");--> statement-breakpoint
CREATE INDEX "document_taxes_org_idx" ON "document_taxes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "document_templates_org_idx" ON "document_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "quote_instalments_quote_idx" ON "quote_instalments" USING btree ("quote_id");--> statement-breakpoint
CREATE INDEX "reminder_log_invoice_idx" ON "reminder_log" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reminder_log_once_idx" ON "reminder_log" USING btree ("invoice_id","rule_id");--> statement-breakpoint
CREATE INDEX "reminder_rules_org_idx" ON "reminder_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tax_definitions_org_idx" ON "tax_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_share_token_idx" ON "invoices" USING btree ("share_token");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_share_token_idx" ON "quotes" USING btree ("share_token");--> statement-breakpoint
-- Existing lines carry their quantity in the whole-number column. The new
-- thousandths column defaults to 1000, so without this every line already on
-- an invoice would silently become a quantity of one — a three-day job billed
-- as one day, on documents a business has already sent.
UPDATE "invoice_lines" SET "quantity_milli" = "quantity" * 1000;--> statement-breakpoint
UPDATE "quote_lines" SET "quantity_milli" = "quantity" * 1000;
