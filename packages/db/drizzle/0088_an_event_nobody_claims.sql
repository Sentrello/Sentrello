CREATE TABLE "payment_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"claimed_by" text,
	"received_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "payment_webhook_events_org_idx" ON "payment_webhook_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_webhook_events_once_idx" ON "payment_webhook_events" USING btree ("organization_id","provider","event_id");