import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, isNull, lte, schema } from "@sentrello/db";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { ownedAccount } from "./chart";

/**
 * Adding up what the bank says and refusing to accept a difference.
 *
 * Matching a statement line against an invoice says the money has been
 * recorded. It does not say the account is right. A business finds out it is
 * wrong the way every business does — a payment that never arrived, a fee
 * nobody recorded, a transaction entered twice — and the only thing that
 * catches all three is this: what the statement closed at, what the books say
 * about the same lines, and a difference of nothing.
 *
 * It is the one place in the module that will not take "close enough".
 */
export function registerReconciliation(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/reconciliations",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.bankReconciliations)
        .where(eq(schema.bankReconciliations.organizationId, orgId))
        .orderBy(desc(schema.bankReconciliations.statementDate));
      return c.json({ reconciliations: rows });
    },
  );

  /**
   * Starting one: the statement in front of somebody, typed in.
   *
   * Two figures from the piece of paper — the date it closes and the balance
   * it closes at — and nothing else. Everything after this is the machine
   * doing the adding up, which is the half people get wrong.
   */
  ctx.app.post(
    "/api/reconciliations",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const accountId = String(body.accountId ?? "");
      if (!(await ownedAccount(orgId, accountId))) {
        return c.json({ error: "that is not an account of yours" }, 404);
      }

      const statementDate = new Date(String(body.statementDate ?? ""));
      if (Number.isNaN(statementDate.getTime())) {
        return c.json({ error: "the date the statement closes" }, 400);
      }

      const statementBalanceCents = body.statementBalanceCents;
      if (
        typeof statementBalanceCents !== "number" ||
        !Number.isInteger(statementBalanceCents)
      ) {
        /**
         * Negative is allowed and zero is allowed.
         *
         * An overdrawn account closes below nothing, and refusing that would
         * make the feature useless to exactly the business that needs it.
         */
        return c.json(
          { error: "the balance it closes at, in whole pennies" },
          400,
        );
      }

      const [open] = await db
        .select({ id: schema.bankReconciliations.id })
        .from(schema.bankReconciliations)
        .where(
          and(
            eq(schema.bankReconciliations.organizationId, orgId),
            eq(schema.bankReconciliations.accountId, accountId),
            isNull(schema.bankReconciliations.completedAt),
          ),
        )
        .limit(1);
      if (open) {
        // Two at once on one account means two people ticking the same lines
        // and both arriving at zero, having each counted half of them.
        return c.json(
          { error: "that account already has a reconciliation on the go" },
          409,
        );
      }

      const openingBalanceCents = await closingBalance(
        orgId,
        accountId,
        statementDate,
      );

      const [reconciliation] = await db
        .insert(schema.bankReconciliations)
        .values({
          organizationId: orgId,
          accountId,
          statementDate,
          statementBalanceCents,
          openingBalanceCents,
        })
        .returning();
      return c.json({ reconciliation }, 201);
    },
  );

  /**
   * Where it stands: what has been ticked, and what is still out.
   *
   * The figure that matters is the last one — the difference. Everything else
   * on this response exists so somebody can see why it is not zero.
   */
  ctx.app.get(
    "/api/reconciliations/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const found = await reconciliationOf(orgId, c.req.param("id") ?? "");
      if (!found) return c.json({ error: "not found" }, 404);

      const progress = await progressOf(orgId, found);
      return c.json({ reconciliation: found, ...progress });
    },
  );

  /**
   * Ticking a line off the statement, or un-ticking it.
   *
   * Only lines on this account, only lines the statement could contain, and
   * never a line inside a reconciliation somebody has already finished — that
   * month was signed off and moving a line out of it would change a figure two
   * people agreed on.
   */
  ctx.app.post(
    "/api/reconciliations/:id/lines/:lineId",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const found = await reconciliationOf(orgId, c.req.param("id") ?? "");
      if (!found) return c.json({ error: "not found" }, 404);
      if (found.completedAt) {
        return c.json({ error: "that reconciliation is finished" }, 409);
      }

      const lineId = c.req.param("lineId") ?? "";
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const cleared = body.cleared !== false;

      const [line] = await db
        .select()
        .from(schema.bankTransactions)
        .where(
          and(
            eq(schema.bankTransactions.id, lineId),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!line) return c.json({ error: "not found" }, 404);
      if (line.reconciliationId && line.reconciliationId !== found.id) {
        return c.json(
          { error: "that line was settled in an earlier reconciliation" },
          409,
        );
      }
      if (line.bankAccountId && line.bankAccountId !== found.accountId) {
        return c.json(
          { error: "that line came out of a different account" },
          409,
        );
      }

      await db
        .update(schema.bankTransactions)
        .set({ reconciliationId: cleared ? found.id : null })
        .where(
          and(
            eq(schema.bankTransactions.id, line.id),
            eq(schema.bankTransactions.organizationId, orgId),
          ),
        );

      return c.json({ cleared });
    },
  );

  /**
   * Finishing it, which only happens at zero.
   *
   * The refusal is the feature. Everything else in this module tries to be
   * helpful about a mistake; this one says the bank and the books do not
   * agree, by how much, and declines — because a reconciliation that can be
   * finished while it is out is a reconciliation that tells a business its
   * accounts are right when they are not.
   */
  ctx.app.post(
    "/api/reconciliations/:id/finish",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const found = await reconciliationOf(orgId, c.req.param("id") ?? "");
      if (!found) return c.json({ error: "not found" }, 404);
      if (found.completedAt) {
        return c.json({ error: "that reconciliation is finished" }, 409);
      }

      const { lines, differenceCents } = await progressOf(orgId, found);

      if (differenceCents !== 0) {
        return c.json(
          {
            error: `the bank and your books are ${money(Math.abs(differenceCents))} apart`,
            differenceCents,
          },
          409,
        );
      }

      const [done] = await db
        .update(schema.bankReconciliations)
        .set({
          completedAt: new Date(),
          completedBy: c.get("session").user.id,
        })
        .where(
          and(
            eq(schema.bankReconciliations.id, found.id),
            eq(schema.bankReconciliations.organizationId, orgId),
            // Only from unfinished, so two people pressing at once finish it
            // once between them rather than twice.
            isNull(schema.bankReconciliations.completedAt),
          ),
        )
        .returning();
      if (!done) {
        return c.json({ error: "that reconciliation is finished" }, 409);
      }

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "bank.reconciled",
        detail: {
          statementDate: found.statementDate.toISOString().slice(0, 10),
          statementBalanceCents: found.statementBalanceCents,
          lines: lines.filter((line) => line.cleared).length,
        },
      });

      return c.json({ reconciliation: done });
    },
  );

  /**
   * Abandoning one that was started by mistake.
   *
   * Deletes the reconciliation and lets go of every line it was holding.
   * Never a finished one: that is a month two people agreed on, and the way
   * out of a wrong figure inside it is an adjusting entry, not deleting the
   * evidence.
   */
  ctx.app.delete(
    "/api/reconciliations/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["delete"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const found = await reconciliationOf(orgId, c.req.param("id") ?? "");
      if (!found) return c.json({ error: "not found" }, 404);
      if (found.completedAt) {
        return c.json(
          { error: "a finished reconciliation is not deleted" },
          409,
        );
      }

      await db
        .update(schema.bankTransactions)
        .set({ reconciliationId: null })
        .where(
          and(
            eq(schema.bankTransactions.organizationId, orgId),
            eq(schema.bankTransactions.reconciliationId, found.id),
          ),
        );
      await db
        .delete(schema.bankReconciliations)
        .where(
          and(
            eq(schema.bankReconciliations.id, found.id),
            eq(schema.bankReconciliations.organizationId, orgId),
          ),
        );
      return c.json({ ok: true });
    },
  );
}

type Reconciliation = typeof schema.bankReconciliations.$inferSelect;

interface Progress {
  lines: CandidateLine[];
  clearedCents: number;
  /**
   * Opening, plus everything ticked, against what the statement says.
   *
   * Zero or it does not finish. Worked out in one place because the screen
   * showing somebody the figure and the route refusing to finish on it have to
   * be the same arithmetic: two copies is a screen that says zero beside a
   * button that says otherwise, and the person believes the screen.
   *
   * A number rather than a boolean, because "out by 12.50" sends somebody
   * looking for a transaction of 12.50 and half the time they find it in a
   * minute.
   */
  differenceCents: number;
}

async function progressOf(
  organizationId: string,
  reconciliation: Reconciliation,
): Promise<Progress> {
  const lines = await candidateLines(organizationId, reconciliation);
  const clearedCents = lines
    .filter((line) => line.cleared)
    .reduce((sum, line) => sum + line.amountCents, 0);
  return {
    lines,
    clearedCents,
    differenceCents:
      reconciliation.openingBalanceCents +
      clearedCents -
      reconciliation.statementBalanceCents,
  };
}

async function reconciliationOf(
  organizationId: string,
  id: string,
): Promise<Reconciliation | undefined> {
  const [row] = await db
    .select()
    .from(schema.bankReconciliations)
    .where(
      and(
        eq(schema.bankReconciliations.id, id),
        eq(schema.bankReconciliations.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * What the last finished reconciliation of this account closed at.
 *
 * Before this statement's date, not simply the newest: a business reconciling
 * March in May needs February's figure, and handing it April's would put it
 * two months out with no way to see why.
 */
async function closingBalance(
  organizationId: string,
  accountId: string,
  before: Date,
): Promise<number> {
  const [previous] = await db
    .select({ balance: schema.bankReconciliations.statementBalanceCents })
    .from(schema.bankReconciliations)
    .where(
      and(
        eq(schema.bankReconciliations.organizationId, organizationId),
        eq(schema.bankReconciliations.accountId, accountId),
        lte(schema.bankReconciliations.statementDate, before),
      ),
    )
    .orderBy(desc(schema.bankReconciliations.statementDate))
    .limit(1);
  return previous?.balance ?? 0;
}

interface CandidateLine {
  id: string;
  date: Date;
  description: string | null;
  amountCents: number;
  cleared: boolean;
  /** Whether the ledger has this line posted at all. */
  posted: boolean;
}

/**
 * Everything this statement could plausibly contain.
 *
 * Lines on this account, up to the statement's date, that no earlier
 * reconciliation has settled. Lines dated after it are deliberately absent:
 * they are on next month's statement, and offering them is offering somebody a
 * way to make the difference come to zero with a transaction the bank has not
 * told them about yet.
 */
async function candidateLines(
  organizationId: string,
  reconciliation: Reconciliation,
): Promise<CandidateLine[]> {
  const rows = await db
    .select()
    .from(schema.bankTransactions)
    .where(
      and(
        eq(schema.bankTransactions.organizationId, organizationId),
        lte(
          schema.bankTransactions.date,
          endOfDay(reconciliation.statementDate),
        ),
      ),
    )
    .orderBy(schema.bankTransactions.date);

  return rows
    .filter((row) => {
      // A line that names a different account is not on this statement. One
      // that names none is from an upload that did not say, and a business
      // with a single bank account has nothing else it could be.
      if (row.bankAccountId && row.bankAccountId !== reconciliation.accountId) {
        return false;
      }
      // Settled in an earlier month, and not up for ticking again.
      return (
        !row.reconciliationId || row.reconciliationId === reconciliation.id
      );
    })
    .map((row) => ({
      id: row.id,
      date: row.date,
      description: row.description,
      amountCents: row.amountCents,
      cleared: row.reconciliationId === reconciliation.id,
      posted: Boolean(row.matchedEntryId),
    }));
}

/** The last instant of a day, so a statement's own date is included. */
function endOfDay(date: Date): Date {
  const end = new Date(date);
  end.setUTCHours(23, 59, 59, 999);
  return end;
}

/** A difference, said the way somebody would say it out loud. */
function money(cents: number): string {
  return (cents / 100).toFixed(2);
}
