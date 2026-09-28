/*
 * Any counters the old race left behind, folded into one.
 *
 * Creating a unique index over rows that are already duplicated fails, and this
 * is the exact table where duplicates were possible: the counter was created on
 * first use with a read and then a write, so two things numbered at the same
 * moment both found none and both made one. An instance that met that has two
 * rows here, and the migration that fixes the cause must not fall over on the
 * evidence.
 *
 * The highest number wins. Numbers already handed out are on documents people
 * are holding, so the counter must never move backwards — continuing past the
 * highest is the only answer that cannot issue a number twice.
 */
UPDATE "document_counters" c
   SET "last_number" = m.highest
  FROM (
        SELECT "organization_id", "kind", MAX("last_number") AS highest
          FROM "document_counters"
         GROUP BY "organization_id", "kind"
       ) m
 WHERE c."organization_id" = m."organization_id"
   AND c."kind" = m."kind";--> statement-breakpoint

DELETE FROM "document_counters" c
 USING "document_counters" other
 WHERE c."organization_id" = other."organization_id"
   AND c."kind" = other."kind"
   AND c."id" > other."id";--> statement-breakpoint

DROP INDEX "document_counters_org_kind_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "document_counters_org_kind_idx" ON "document_counters" USING btree ("organization_id","kind");
