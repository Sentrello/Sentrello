-- A quote remembers the deal it was raised for.
--
-- Nullable and unconstrained on purpose: most quotes are not raised from a
-- deal, and re-quoting one after the customer asks for a change is ordinary.
ALTER TABLE "quotes" ADD COLUMN "deal_id" uuid;
