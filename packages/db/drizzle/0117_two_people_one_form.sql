ALTER TABLE "forms" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "user_groups" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- The version a save says it was editing. The form builder saves the fields
-- and the look whole, and a group saves its roles as one list, so two people
-- with the same one open each wrote over the other in silence.
--
-- A row already here was last changed at some point nobody recorded; its
-- creation date is the honest answer, as in 0105.
UPDATE "forms" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "user_groups" SET "updated_at" = "created_at";--> statement-breakpoint
-- Stamped by the database, like every other table of ours that keeps the
-- column (0105). That migration's loop ran once, over the tables that had the
-- column then, so these two are named here.
CREATE OR REPLACE TRIGGER "forms_stamp_updated_at" BEFORE UPDATE ON "forms" FOR EACH ROW EXECUTE FUNCTION stamp_updated_at();--> statement-breakpoint
CREATE OR REPLACE TRIGGER "user_groups_stamp_updated_at" BEFORE UPDATE ON "user_groups" FOR EACH ROW EXECUTE FUNCTION stamp_updated_at();
