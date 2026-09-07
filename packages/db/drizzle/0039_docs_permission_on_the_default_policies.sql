-- The Docs module's screens become reachable by the default policies.
--
-- `docs` was not in the access-control statement at all, so every route the
-- module guards answered 403 — including its own settings screen, which is the
-- only way to connect a repository. The resource exists now, and the compiled
-- `admin` grants it, which covers the owner of every instance.
--
-- The rest are rows, and rows that already exist do not change on their own.
-- This adds the grant to the shipped defaults on instances that already have
-- them, so a business whose marketing assistant is in the Marketing group can
-- open the documentation screens without somebody rebuilding the policy.
--
-- Only where the policy is still exactly what shipped. A business that has
-- edited one has said what it wants that role to do, and quietly widening it
-- afterwards is the opposite of a permission system. Those are left alone.
UPDATE "organization_role"
SET "permission" = (
  ("permission"::jsonb || jsonb_build_object('docs', v.allows::jsonb))::text
)
FROM (VALUES
  ('admins',     '["read","create","update","delete"]'),
  ('executives', '["read"]'),
  ('managers',   '["read","update"]'),
  ('staff',      '["read"]'),
  ('marketing',  '["read","create","update"]')
) AS v(role, allows)
WHERE "organization_role"."role" = v.role
  AND NOT ("permission"::jsonb ? 'docs');
