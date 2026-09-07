ALTER TABLE "security_events" ALTER COLUMN "actor_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_events" ALTER COLUMN "actor_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "security_policy" ADD COLUMN "lockout_after_attempts" integer DEFAULT 5 NOT NULL;--> statement-breakpoint
ALTER TABLE "security_policy" ADD COLUMN "lockout_minutes" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "security_policy" ADD COLUMN "event_retention_days" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "member" ADD COLUMN "disabled_at" timestamp;--> statement-breakpoint
CREATE INDEX "security_events_org_action_at_idx" ON "security_events" USING btree ("organization_id","action","at");