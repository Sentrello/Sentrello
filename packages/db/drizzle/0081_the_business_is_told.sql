CREATE TABLE "crm_webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"webhook_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_status" integer,
	"last_error" text,
	"next_attempt_at" timestamp NOT NULL,
	"delivered_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "crm_webhook_deliveries_once" UNIQUE("webhook_id","event_id")
);
--> statement-breakpoint
CREATE TABLE "crm_webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"url" text NOT NULL,
	"secret" text NOT NULL,
	"entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_insecure" boolean DEFAULT false NOT NULL,
	"cursor_at" timestamp DEFAULT now() NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crm_webhook_deliveries_due_idx" ON "crm_webhook_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "crm_webhook_deliveries_hook_idx" ON "crm_webhook_deliveries" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "crm_webhooks_org_idx" ON "crm_webhooks" USING btree ("organization_id");