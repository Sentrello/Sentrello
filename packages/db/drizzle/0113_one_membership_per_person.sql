-- One membership per person per business. Better Auth's accept never asked
-- whether the person was already a member, so two invitations to one address
-- made them a member twice. Any such pair already here keeps its first row,
-- the one every reader ordered by joining date already treated as theirs.
DELETE FROM "member" AS later USING "member" AS first
WHERE later."organization_id" = first."organization_id"
  AND later."user_id" = first."user_id"
  AND (later."created_at", later."id") > (first."created_at", first."id");--> statement-breakpoint
CREATE UNIQUE INDEX "member_org_user_uidx" ON "member" USING btree ("organization_id","user_id");
