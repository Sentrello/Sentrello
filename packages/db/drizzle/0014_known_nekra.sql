CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"actor_name" text NOT NULL,
	"subject_id" text,
	"subject_name" text,
	"action" text NOT NULL,
	"detail" jsonb,
	"at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "security_events_org_idx" ON "security_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "security_events_at_idx" ON "security_events" USING btree ("at");