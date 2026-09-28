CREATE TABLE "onboarding_dismissals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"guide_id" text NOT NULL,
	"dismissed_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "onboarding_dismissals_org_idx" ON "onboarding_dismissals" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "onboarding_dismissals_unique_idx" ON "onboarding_dismissals" USING btree ("organization_id","guide_id");