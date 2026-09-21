ALTER TABLE "payment_accounts" ADD COLUMN "webhook_rejected_at" timestamp;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "webhook_rejected_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_accounts" ADD COLUMN "webhook_accepted_at" timestamp;