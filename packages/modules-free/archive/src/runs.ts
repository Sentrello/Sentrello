import { createHash } from "node:crypto";
import { and, db, desc, eq, schema } from "@sentrello/db";
import {
  type ArchivePlan,
  type Verification,
  planArchive,
  removeArchived,
  verifyArchive,
  writeArchive,
} from "@sentrello/db/archive";
import { archiveDestination } from "@sentrello/module-sdk";
import { type StoredDestination, sizeOf } from "./destinations";

/**
 * Write it, prove it, and only then take anything away.
 *
 * The order in this file is the feature. Every step is separated from the next
 * by a fact that had to be established, and none of them is "we think it
 * worked":
 *
 *   1. **Plan.** Count what would go, and work out whether it may be removed at
 *      all — the retention window, the period lock, anything outside the period
 *      still pointing in. A refusal here refuses the *deletion*, never the
 *      export.
 *   2. **Write.** Stream the archive to the destination, a piece at a time,
 *      hashing as it goes. Nothing is deleted and nothing can be: this half
 *      only reads.
 *   3. **Verify — from the destination, not from memory.** Ask the destination
 *      for the file back and read it: every member against the CRC in its own
 *      zip header, every member against the SHA-256 the manifest states, every
 *      row count against the manifest and against the database. Verifying the
 *      buffer we still had in hand would prove nothing about what landed.
 *   4. **Remove**, in one transaction, exactly what the verified archive holds
 *      — and roll the whole thing back if the counts have moved underneath it.
 *
 * A failure at any point before step 4 leaves the database exactly as it was
 * and says so in the operator's own words. That is not a fallback path; it is
 * the ordinary outcome of the thing not working, and it is tested first.
 */

export type RunRow = typeof schema.archiveRuns.$inferSelect;

function filenameFor(plan: ArchivePlan, archiveId: string): string {
  const day = (date: Date) => date.toISOString().slice(0, 10);
  return `sentrello-${plan.set.id}-${day(plan.from)}-to-${day(plan.to)}-${archiveId.slice(0, 8)}.zip`;
}

export interface RunOutcome {
  run: RunRow;
  verification: Verification;
  /** Null when the operator asked only for a copy, or when the plan forbids it. */
  removed: { table: string; rows: number }[] | null;
}

export async function runArchive(
  orgId: string,
  plan: ArchivePlan,
  destination: StoredDestination,
  options: { remove: boolean; actor: string | null },
): Promise<RunOutcome> {
  const implementation = archiveDestination(destination.id);
  if (!implementation) {
    throw Object.assign(
      new Error(
        `the destination "${destination.id}" is not available on this instance`,
      ),
      { status: 400 },
    );
  }

  const archiveId = crypto.randomUUID();
  const filename = filenameFor(plan, archiveId);
  const whole = createHash("sha256");
  let bytes = 0;

  async function* body() {
    for await (const chunk of writeArchive(plan, archiveId)) {
      whole.update(chunk);
      bytes += chunk.length;
      yield chunk;
    }
  }

  const [run] = await db
    .insert(schema.archiveRuns)
    .values({
      organizationId: orgId,
      setId: plan.set.id,
      periodFrom: plan.from,
      periodTo: plan.to,
      archiveId,
      filename,
      destinationId: destination.id,
      locator: "",
      status: "written",
      rows: plan.counts,
      createdBy: options.actor,
    })
    .returning();
  if (!run) throw new Error("could not record the archive run");

  const fail = async (error: string) => {
    await db
      .update(schema.archiveRuns)
      .set({ status: "failed", error })
      .where(eq(schema.archiveRuns.id, run.id));
  };

  let locator: string;
  try {
    locator = await implementation.put(destination.config, filename, body());
  } catch (err) {
    // A destination that failed part-way may have left something behind. Say
    // so plainly rather than tidying up silently: an operator looking at a
    // half-written file needs to know it is one.
    await fail(`the archive could not be written: ${(err as Error).message}`);
    throw Object.assign(
      new Error(
        `the archive could not be written to ${implementation.label}: ${(err as Error).message}. Nothing has been deleted.`,
      ),
      { status: 502 },
    );
  }

  await db
    .update(schema.archiveRuns)
    .set({ locator, bytes, sha256: whole.digest("hex") })
    .where(eq(schema.archiveRuns.id, run.id));

  let verification: Verification;
  try {
    verification = await verifyArchive(
      implementation.get(destination.config, locator),
      plan.counts,
    );
  } catch (err) {
    await fail(`the archive could not be read back: ${(err as Error).message}`);
    throw Object.assign(
      new Error(
        `the archive was written but could not be read back and checked: ${(err as Error).message}. Nothing has been deleted.`,
      ),
      { status: 409 },
    );
  }

  await db
    .update(schema.archiveRuns)
    .set({ status: "verified", verifiedAt: new Date(), error: null })
    .where(eq(schema.archiveRuns.id, run.id));

  if (!options.remove || plan.blockers.length > 0) {
    return { run: await reload(run.id), verification, removed: null };
  }

  const removal = await removeArchived(plan, verification);
  await db
    .update(schema.archiveRuns)
    .set({
      status: "removed",
      removedAt: new Date(),
      removedRows: removal.counts,
      carriedForward: removal.carriedForward,
    })
    .where(eq(schema.archiveRuns.id, run.id));

  return { run: await reload(run.id), verification, removed: removal.counts };
}

async function reload(id: string): Promise<RunRow> {
  const [row] = await db
    .select()
    .from(schema.archiveRuns)
    .where(eq(schema.archiveRuns.id, id))
    .limit(1);
  if (!row) throw new Error("the archive run disappeared while it was running");
  return row;
}

export async function runsFor(orgId: string) {
  const rows = await db
    .select()
    .from(schema.archiveRuns)
    .where(eq(schema.archiveRuns.organizationId, orgId))
    .orderBy(desc(schema.archiveRuns.createdAt))
    .limit(100);

  return Promise.all(
    rows.map(async (row) => ({
      ...row,
      // Whether the file is still where it was put. An operator who downloaded
      // it and cleared the copy here should see that, not a download button
      // that answers 404.
      present: row.locator ? (await sizeOf(row.locator)) !== null : false,
    })),
  );
}

export async function runFor(
  orgId: string,
  id: string,
): Promise<RunRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.archiveRuns)
    .where(
      and(
        eq(schema.archiveRuns.organizationId, orgId),
        eq(schema.archiveRuns.id, id),
      ),
    )
    .limit(1);
  return row;
}

/** Nothing is ever deleted from the database here — only the copy at the destination. */
export async function forgetFile(
  orgId: string,
  run: RunRow,
  destination: StoredDestination,
) {
  const implementation =
    archiveDestination(run.destinationId) ?? archiveDestination(destination.id);
  if (implementation && run.locator) {
    await implementation.remove(destination.config, run.locator);
  }
  await db
    .update(schema.archiveRuns)
    .set({ locator: "" })
    .where(
      and(
        eq(schema.archiveRuns.organizationId, orgId),
        eq(schema.archiveRuns.id, run.id),
      ),
    );
}

export { planArchive };
