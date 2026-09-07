CREATE TABLE "bank_payment_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"payee_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"from_account_reference" text NOT NULL,
	"from_ledger_account_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"description" text,
	"every" text NOT NULL,
	"starts_on" timestamp NOT NULL,
	"ends_on" timestamp,
	"provider_reference" text,
	"active" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"payee_id" uuid NOT NULL,
	"bill_id" uuid,
	"connection_id" uuid NOT NULL,
	"from_account_reference" text NOT NULL,
	"from_ledger_account_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"description" text,
	"idempotency_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_reference" text,
	"expected_at" timestamp,
	"last_error" text,
	"entry_id" uuid,
	"schedule_id" uuid,
	"created_by" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "bank_payments_idempotency" UNIQUE("organization_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "payees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"contact_id" uuid,
	"name" text NOT NULL,
	"kind" text DEFAULT 'business' NOT NULL,
	"account_number" text NOT NULL,
	"routing_number" text NOT NULL,
	"account_last4" text,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bank_payment_schedules_org_idx" ON "bank_payment_schedules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "bank_payments_org_idx" ON "bank_payments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "payees_org_idx" ON "payees" USING btree ("organization_id");