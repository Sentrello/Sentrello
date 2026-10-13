-- The email a note was filed from, so a provider's retry of one message
-- files nothing the second time. Empty on every note already here, and on
-- every note somebody types: NULLs never collide in a unique index.
ALTER TABLE "notes" ADD COLUMN "inbound_message_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "notes_inbound_message_uidx" ON "notes" USING btree ("organization_id","inbound_message_id");