CREATE TABLE "record_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"changed" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"actor_id" text,
	"caused_by_run_id" uuid,
	"at" timestamp DEFAULT now() NOT NULL,
	"handled_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "record_events_org_idx" ON "record_events" USING btree ("organization_id","at");--> statement-breakpoint
CREATE INDEX "record_events_unhandled_idx" ON "record_events" USING btree ("handled_at","at");--> statement-breakpoint
CREATE INDEX "record_events_entity_idx" ON "record_events" USING btree ("entity","entity_id");