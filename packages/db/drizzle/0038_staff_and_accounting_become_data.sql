-- Staff and Accounting stop being compiled into the product.
--
-- Better Auth reserves the names of the roles passed to it, so while these two
-- were compiled a business could not edit them: the screen offered Copy where
-- every other default offered Edit. They are ordinary roles now, and this gives
-- the organizations that already exist the rows that a new one gets from the
-- seed.
--
-- Without it, everybody already holding `staff` or `accounting` would keep the
-- name and lose the permissions behind it the moment the compiled definition
-- went away — signing in to a product with nothing in it. That is the whole
-- reason this migration exists, and why it must land with the code that drops
-- them rather than after it.
--
-- Nothing here touches `member`: no one's role changes, only what the role is
-- allowed to do. A business that already made its own Staff keeps it — the
-- NOT EXISTS leaves any name that is taken alone.
INSERT INTO "organization_role" ("id", "organization_id", "role", "permission", "created_at")
SELECT gen_random_uuid()::text, o."id", v.role, v.permission, now()
FROM "organizations" o
CROSS JOIN (VALUES
  ('staff', '{"dashboard":["read"],"crm":["read","create","update"],"invoicing":["read"],"scheduling":["read","create","update"],"shop":["read"],"documents":["read","create","update"]}'),
  ('accounting', '{"dashboard":["read"],"crm":["read"],"invoicing":["read","create","update","delete","send"],"bookkeeping":["read","create","update","delete"],"reports":["read"],"settings":["read"],"scheduling":["read"],"shop":["read"],"documents":["read"]}')
) AS v(role, permission)
WHERE NOT EXISTS (
  SELECT 1 FROM "organization_role" r
  WHERE r."organization_id" = o."id" AND r."role" = v.role
);
