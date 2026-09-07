import { and, eq, sql } from "drizzle-orm";
import { type db, schema } from "./index";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

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

  const locked = await tx
    .select({ id: schema.documentCounters.id })
    .from(schema.documentCounters)
    .where(
      and(
        eq(schema.documentCounters.organizationId, orgId),
        eq(schema.documentCounters.kind, kind),
      ),
    )
    .for("update")
    .limit(1);

  if (locked.length === 0) {
    const [created] = await tx
      .insert(schema.documentCounters)
      .values({ organizationId: orgId, kind, lastNumber: 1 })
      .returning();
    if (!created) throw new Error("could not create document counter");
    return `${prefix}-${String(created.lastNumber).padStart(4, "0")}`;
  }

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
  if (!bumped) throw new Error("could not bump document counter");
  return `${prefix}-${String(bumped.lastNumber).padStart(4, "0")}`;
}
