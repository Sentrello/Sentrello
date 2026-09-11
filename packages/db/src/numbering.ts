import { and, eq, sql } from "drizzle-orm";
import { type db, schema } from "./index";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The next number in a per-org sequence, taken safely.
 *
 * The counter row is locked FOR UPDATE inside the caller's transaction, so two
 * things numbered at the same moment can never take the same number. That is
 * the whole point of it, and the reason a number must never be worked out by
 * reading the last row and adding one: two concurrent requests both read the
 * same last row.
 *
 * `startAt` is consulted only when the counter is created, and exists for a
 * sequence that already has history behind it — a shop with four thousand
 * orders numbered before this counter existed must not begin again at one.
 */
export async function nextSequenceNumber(
  tx: Tx,
  orgId: string,
  kind: string,
  format: (n: number) => string,
  startAt?: () => Promise<number>,
): Promise<string> {
  /*
   * The common path: a counter that already exists, bumped in one statement.
   * No read-then-write, so there is no gap for a second request to sit in.
   */
  const [bumped] = await tx
    .update(schema.documentCounters)
    .set({ lastNumber: sql`${schema.documentCounters.lastNumber} + 1` })
    .where(
      and(
        eq(schema.documentCounters.organizationId, orgId),
        eq(schema.documentCounters.kind, kind),
      ),
    )
    .returning();
  if (bumped) return format(bumped.lastNumber);

  /*
   * And the first one ever, which is the case that used to race: two requests
   * both found no counter and both made one. An upsert against the unique index
   * settles it — whichever arrives second updates rather than inserts, and
   * takes the next number instead of the same one.
   */
  const from = startAt ? await startAt() : 0;
  const [created] = await tx
    .insert(schema.documentCounters)
    .values({ organizationId: orgId, kind, lastNumber: from + 1 })
    .onConflictDoUpdate({
      target: [
        schema.documentCounters.organizationId,
        schema.documentCounters.kind,
      ],
      set: { lastNumber: sql`${schema.documentCounters.lastNumber} + 1` },
    })
    .returning();
  if (!created) throw new Error("could not create document counter");
  return format(created.lastNumber);
}

/**
 * Per-org sequential document number ("INV-0001"). The counter row is locked
 * FOR UPDATE inside the caller's transaction, so two concurrent invoices can
 * never take the same number.
 */
export async function nextDocumentNumber(
  tx: Tx,
  orgId: string,
  kind: "invoice" | "quote",
): Promise<string> {
  const prefix = kind === "invoice" ? "INV" : "QUO";
  return nextSequenceNumber(
    tx,
    orgId,
    kind,
    (n) => `${prefix}-${String(n).padStart(4, "0")}`,
  );
}
