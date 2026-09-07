ALTER TABLE "companies" ADD COLUMN "tax_identifier" text;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "context_links" jsonb DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "status" text DEFAULT 'cold' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "background" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "first_seen_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_seen_at" timestamp DEFAULT now();--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "has_newsletter" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "gender" text;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "won_stages" jsonb;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "lost_stages" jsonb;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "company_sectors" jsonb;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "deal_categories" jsonb;--> statement-breakpoint
ALTER TABLE "crm_settings" ADD COLUMN "contact_statuses" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "done_at" timestamp;--> statement-breakpoint
CREATE INDEX "contacts_last_seen_idx" ON "contacts" USING btree ("organization_id","last_seen_at");