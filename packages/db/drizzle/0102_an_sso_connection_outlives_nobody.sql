-- The one `organization_id` the last pass did not key.
--
-- Yesterday's migration gave every organization-scoped table a foreign key
-- to `organizations`, and missed this one because the column is nullable —
-- null here is an instance-wide provider and stays legal. A connection left
-- behind by a deleted business is not litter: sign-in matches an address to
-- a provider on `domain`, so a stranded row still routes somebody's login
-- to an identity provider for a business that is gone.

DELETE FROM "sso_provider" WHERE "organization_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "organizations" o WHERE o.id = "sso_provider"."organization_id");--> statement-breakpoint
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;