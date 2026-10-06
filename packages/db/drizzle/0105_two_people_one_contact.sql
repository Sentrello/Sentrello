ALTER TABLE "companies" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "notes" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "updated_at" timestamp DEFAULT now() NOT NULL;--> statement-breakpoint
-- A row that existed before this migration was last changed at some point
-- nobody recorded. Its creation date is the only honest answer we have, and
-- it is a better one than the moment of the upgrade: without this, every
-- contact in the business reads as edited the day the instance updated.
-- `tasks` had no creation date either, so there it stays as the default.
UPDATE "companies" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "contacts" SET "updated_at" = "created_at";--> statement-breakpoint
UPDATE "notes" SET "updated_at" = "created_at";--> statement-breakpoint
-- Stamped by the database, not by the code that writes the row.
--
-- The alternative was `updatedAt: new Date()` in every writer, which is how
-- invoicing does it — twenty hand-written copies of one rule. The CRM has more
-- writers than that (the CRUD generator, the public form, inbound email, the
-- importer, the pipeline board, the task actions) and will grow more, and a
-- writer that forgets the stamp does not fail: it leaves the row claiming an
-- older version, so the save guard refuses an edit nobody else touched. A
-- trigger cannot be forgotten by a writer that has not been written yet.
--
-- On every table of ours that keeps the column, not only the ones a guard reads
-- today, because the rule is about what `updated_at` means rather than about
-- which screen happens to check it. Two writes in invoicing used to leave it
-- describing the insert — recording a payment and applying a credit both change
-- an invoice's status and neither stamped it — so an invoice paid last week
-- still said it was last changed the day it was drafted.
--
-- Better Auth's four tables are left alone. They belong to the library, it
-- maintains them itself, and nothing of ours decides anything from them.
CREATE OR REPLACE FUNCTION stamp_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
DO $$
DECLARE t text;
BEGIN
  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.column_name = 'updated_at'
      AND c.table_name NOT IN ('account', 'session', 'user', 'verification')
  LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE ON %I '
      'FOR EACH ROW EXECUTE FUNCTION stamp_updated_at()',
      t || '_stamp_updated_at', t
    );
  END LOOP;
END $$;
