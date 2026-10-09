-- Stored roles stop naming modules that no longer exist.
--
-- `hr`, `inventory`, `make-deal` and `time` have left the access-control
-- statement: nothing in any Sentrello module guards them. A role saved while
-- they were still listed keeps working without this, because a permission
-- check ignores a key nobody asks about. Editing that role does not: the
-- policy editor sends the whole stored permission back, and Better Auth
-- refuses an update naming a resource the statement does not have, so the
-- role could never be changed again. Copying it would fail the same way.
--
-- Only those four keys are removed; every live grant stays as it was.
UPDATE "organization_role"
SET "permission" = (
  "permission"::jsonb - ARRAY['hr', 'inventory', 'make-deal', 'time']
)::text
WHERE "permission"::jsonb ?| ARRAY['hr', 'inventory', 'make-deal', 'time'];
