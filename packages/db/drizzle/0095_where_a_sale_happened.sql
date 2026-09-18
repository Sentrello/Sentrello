CREATE TABLE "sale_places" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"source" text NOT NULL,
	"document_id" uuid,
	"country" text NOT NULL,
	"region" text,
	"basis" text NOT NULL,
	"evidence" jsonb,
	"customer_tax_id" text,
	"customer_tax_id_valid" boolean
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sale_places_source_idx" ON "sale_places" USING btree ("organization_id","source");--> statement-breakpoint
CREATE INDEX "sale_places_document_idx" ON "sale_places" USING btree ("organization_id","document_id");--> statement-breakpoint
-- Where every sale already in the books happened.
--
-- Until now a return worked the place out at reporting time, by joining an
-- invoice to its contact to that contact's company. Backfilling the same join
-- once means nothing that has been filed changes by a cent; doing it here
-- rather than leaving the join in the report is what lets a sale with no
-- company behind it — a consumer, or an order a storefront raised — be placed
-- at all.
--
-- A sale with no country on record gets no row, deliberately. It is a sale
-- nobody could place, the returns now say so with its figures beside it, and a
-- guess written into a tax record is worse than a gap somebody can see.
INSERT INTO "sale_places" (
  "organization_id", "source", "document_id", "country", "region", "basis",
  "evidence", "customer_tax_id", "customer_tax_id_valid")
SELECT i."organization_id",
       CASE WHEN i."kind" = 'credit_note' THEN 'credit-note:' ELSE 'invoice:' END
         || i."id",
       i."id",
       upper(btrim(co."country")),
       upper(nullif(btrim(coalesce(co."state", '')), '')),
       'customer-address',
       jsonb_build_array(jsonb_build_object(
         'kind', 'customer-address',
         'country', upper(btrim(co."country")),
         'region', upper(nullif(btrim(coalesce(co."state", '')), '')))),
       co."tax_identifier",
       co."tax_identifier_valid"
  FROM "invoices" i
  JOIN "contacts" c
    ON c."id" = i."contact_id" AND c."organization_id" = i."organization_id"
  JOIN "companies" co
    ON co."id" = c."company_id" AND co."organization_id" = i."organization_id"
 WHERE btrim(coalesce(co."country", '')) <> ''
ON CONFLICT ("organization_id", "source") DO NOTHING;
