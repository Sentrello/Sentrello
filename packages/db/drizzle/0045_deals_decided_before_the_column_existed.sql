-- Deals decided before `decided_at` existed.
--
-- The column was added empty, and the won-and-lost chart reads it — so every
-- business upgrading would have opened its CRM dashboard to six blank months
-- and a pipeline that had apparently never won anything. Seen on a dev
-- database with real deals in it, not reasoned about.
--
-- `updated_at` is the best evidence there is of when a decided deal was
-- decided. It is what the chart used to read, so this reproduces exactly the
-- history the business saw yesterday rather than inventing a better one.
--
-- Only rows already in a decided stage, and only where the column is still
-- empty, so running this twice changes nothing.
UPDATE "deals"
SET "decided_at" = "updated_at"
WHERE "decided_at" IS NULL
  AND "stage" IN (
    SELECT jsonb_array_elements_text(
      COALESCE("crm_settings"."won_stages", '["won"]'::jsonb)
    )
    FROM "crm_settings"
    WHERE "crm_settings"."organization_id" = "deals"."organization_id"
    UNION
    SELECT jsonb_array_elements_text(
      COALESCE("crm_settings"."lost_stages", '["lost"]'::jsonb)
    )
    FROM "crm_settings"
    WHERE "crm_settings"."organization_id" = "deals"."organization_id"
    UNION
    -- A business that never opened CRM Settings has no row there at all, and
    -- its deals still use the shipped defaults.
    SELECT unnest(ARRAY['won', 'lost'])
    WHERE NOT EXISTS (
      SELECT 1 FROM "crm_settings"
      WHERE "crm_settings"."organization_id" = "deals"."organization_id"
    )
  );
