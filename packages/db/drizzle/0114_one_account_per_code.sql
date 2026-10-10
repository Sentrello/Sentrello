-- One account per code in a business. Created only where no business already
-- holds two accounts with one code: an index that cannot be built would fail
-- the migration and with it the whole update, over a duplicate an old race
-- left behind. A lock in ensureAccount stops new duplicates either way.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "accounts" GROUP BY "organization_id", "code" HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS "accounts_org_code_uidx" ON "accounts" USING btree ("organization_id","code");
  ELSE
    RAISE NOTICE 'accounts_org_code_uidx not created: a business holds two accounts with one code';
  END IF;
END $$;
