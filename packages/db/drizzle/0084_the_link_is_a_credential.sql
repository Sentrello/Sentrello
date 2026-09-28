ALTER TABLE "invitation" ADD COLUMN "token_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_token_hash_uidx" ON "invitation" USING btree ("token_hash");