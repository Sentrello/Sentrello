-- The day of the month a recurring invoice or bill falls on. Its next run
-- alone cannot say it: a schedule on the 31st is clamped to the 28th in
-- February, and stepped from there it stayed on the 28th for good. Empty on
-- every schedule already here, which steps from its next run as before.
ALTER TABLE "recurring_bills" ADD COLUMN "anchor_day" smallint;--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD COLUMN "anchor_day" smallint;--> statement-breakpoint
ALTER TABLE "recurring_bills" ADD CONSTRAINT "recurring_bills_anchor_day_check" CHECK ("recurring_bills"."anchor_day" BETWEEN 1 AND 31);--> statement-breakpoint
ALTER TABLE "recurring_profiles" ADD CONSTRAINT "recurring_profiles_anchor_day_check" CHECK ("recurring_profiles"."anchor_day" BETWEEN 1 AND 31);