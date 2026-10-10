-- A portal link is looked up by its hash, not by comparing every customer's
-- token in turn. Stored and generated, so adding it fills every existing row
-- and no writer can leave it describing an old token. The `replace` makes the
-- bytea cast read the token as its own bytes rather than as escapes.
ALTER TABLE "contacts" ADD COLUMN "portal_token_hash" text GENERATED ALWAYS AS (encode(sha256(replace("portal_token", '\', '\\')::bytea), 'hex')) STORED;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_portal_token_hash_idx" ON "contacts" USING btree ("portal_token_hash");