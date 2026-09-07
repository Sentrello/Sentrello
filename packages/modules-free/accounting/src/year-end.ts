import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, like, schema } from "@sentrello/db";
import { ensureAccount, postJournalEntry } from "@sentrello/db/ledger";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { dayFrom } from "./period";
import { ledgerRows, totalsByAccount } from "./reports";

/**
 * Where a lifetime of profit ends up.
 *
 * Created on the first close rather than shipped in the standard chart: a
 * business that never closes a year never needs it, and an equity account with
 * nothing in it is one more line on a balance sheet nobody can explain.
 */
const RETAINED_EARNINGS = {
  code: "3200",
  name: "Retained Earnings",
  type: "equity",
} as const;

/**
 * Drawing a line under a year.
 *
 * Until this exists, "retained earnings" on the balance sheet is a figure
 * worked out on the spot — every penny of profit the business has ever made,
 * recomputed on every request. That is right, and it is also why a profit and
 * loss for this year has to be read by subtracting last year's from the total,
 * and why nothing in the books ever says a year is finished.
 *
 * Closing a year posts one entry that empties every income and expense account
 * into equity. Afterwards the profit and loss for the new year starts at zero
 * because its accounts do, the balance sheet still balances because the entry
 * balances, and what the business has kept over its lifetime is a real account
 * with a real balance rather than a subtraction.
 *
 * **It is an entry, not a flag.** A closed year that is a boolean somewhere is
 * a year whose figures can still move underneath it; a closed year that is a
 * journal entry moves the figures, and can be reversed if the accountant comes
 * back with a change.
 */
export function registerYearEnd(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/year-end",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const closes = await db
        .select()
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.organizationId, orgId),
            like(schema.journalEntries.source, "year-end:%"),
          ),
        )
        .orderBy(desc(schema.journalEntries.postedAt));

      // A reopened year is not a closed year, however many entries it has.
      const open = await closedYears(orgId);
      const years = [...open].sort();

      return c.json({
        closes: closes
          .filter((entry) =>
            open.has((entry.source ?? "").slice("year-end:".length)),
          )
          .map((entry) => ({
            id: entry.id,
            endsOn: (entry.source ?? "").slice("year-end:".length),
            postedAt: entry.postedAt,
            memo: entry.memo,
          })),
        /**
         * The last day already closed, so a screen can offer the next year
         * rather than asking somebody to remember.
         */
        lastClosedOn: years[years.length - 1] ?? null,
      });
    },
  );

  /**
   * What closing this year would do, before it does it.
   *
   * The figure that ends up in equity is the one an accountant checks against
   * their own working, and finding out by posting is the wrong order.
   */
  ctx.app.post(
    "/api/year-end/preview",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const closing = await plan(orgId, body.endsOn);
      if ("error" in closing) return c.json({ error: closing.error }, 400);
      return c.json({
        endsOn: closing.endsOn,
        income: closing.income,
        expenses: closing.expenses,
        retainedCents: closing.retainedCents,
      });
    },
  );

  ctx.app.post(
    "/api/year-end/close",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      /**
       * Asked first, before anything is worked out.
       *
       * A year already closed has nothing left in it and ends after the last
       * close, so planning it first answers "that is before the last year you
       * closed" — which is true, unhelpful, and not the reason.
       */
      const endsOn = String(body.endsOn ?? "");
      if (await closedYears(orgId).then((years) => years.has(endsOn))) {
        // Twice would empty accounts that are already empty and double what
        // equity says the business has kept.
        return c.json({ error: "that year is already closed" }, 409);
      }

      const closing = await plan(orgId, body.endsOn);
      if ("error" in closing) return c.json({ error: closing.error }, 400);

      const source = `year-end:${closing.endsOn}`;

      if (closing.lines.length === 0) {
        return c.json({ error: "there is nothing in that year to close" }, 400);
      }

      const retained = await ensureAccount(orgId, RETAINED_EARNINGS);

      /**
       * Every income and expense account, emptied into equity.
       *
       * An income account carries a credit balance, so it is debited to
       * nothing; an expense account is credited to nothing; and the difference
       * — the year's profit or loss — is what equity gains or gives up.
       */
      const entry = await postJournalEntry(
        orgId,
        `Closed the year to ${closing.endsOn}`,
        source,
        [
          ...closing.lines,
          closing.retainedCents >= 0
            ? { accountId: retained, creditCents: closing.retainedCents }
            : { accountId: retained, debitCents: -closing.retainedCents },
        ],
        // The last instant of the year, so it falls inside the year it closes
        // and not into the first day of the next one.
        endOfDay(closing.endsOn),
      );

      /**
       * And the year is locked, unless somebody says not to.
       *
       * A year closed into equity whose months can still be posted into is a
       * balance sheet that stops balancing the moment anybody does — the
       * closing entry emptied accounts that then quietly refill.
       */
      if (body.lock !== false) {
        await db
          .insert(schema.ledgerSettings)
          .values({
            organizationId: orgId,
            closedThrough: dayFrom(closing.endsOn),
          })
          .onConflictDoUpdate({
            target: schema.ledgerSettings.organizationId,
            set: {
              closedThrough: dayFrom(closing.endsOn),
              updatedAt: new Date(),
            },
          });
      }

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "year.closed",
        detail: {
          endsOn: closing.endsOn,
          retainedCents: closing.retainedCents,
          accounts: closing.lines.length,
        },
      });

      return c.json(
        {
          entryId: entry.id,
          endsOn: closing.endsOn,
          retainedCents: closing.retainedCents,
        },
        201,
      );
    },
  );

  /**
   * Reopening a year the accountant came back about.
   *
   * By reversal, like everything else. Deleting the closing entry would leave
   * a balance sheet that had been printed and signed disagreeing with the
   * books it came from, and nothing to explain the difference.
   */
  ctx.app.post(
    "/api/year-end/reopen",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const endsOn = String(body.endsOn ?? "");
      if (!dayFrom(endsOn)) return c.json({ error: "which year end" }, 400);

      const [entry] = await db
        .select()
        .from(schema.journalEntries)
        .where(
          and(
            eq(schema.journalEntries.organizationId, orgId),
            eq(schema.journalEntries.source, `year-end:${endsOn}`),
          ),
        )
        .limit(1);
      if (!entry) return c.json({ error: "that year is not closed" }, 404);

      // Already reopened is the same answer as never closed: there is nothing
      // to undo, and undoing twice would put the year's profit back twice.
      if (!(await closedYears(orgId)).has(endsOn)) {
        return c.json({ error: "that year is not closed" }, 404);
      }

      const lines = await db
        .select()
        .from(schema.journalLines)
        .where(eq(schema.journalLines.entryId, entry.id));

      /**
       * The lock comes off first.
       *
       * The reversal is dated inside the year it reopens, and the lock it just
       * set would refuse it — a year that could be closed and never reopened.
       */
      await db
        .update(schema.ledgerSettings)
        .set({ closedThrough: null, updatedAt: new Date() })
        .where(eq(schema.ledgerSettings.organizationId, orgId));

      await postJournalEntry(
        orgId,
        `Reopened the year to ${endsOn}`,
        `year-end-reopened:${endsOn}`,
        lines.map((line) => ({
          accountId: line.accountId,
          debitCents: line.creditCents,
          creditCents: line.debitCents,
        })),
        endOfDay(endsOn),
      );

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "year.reopened",
        detail: { endsOn },
      });

      return c.json({ ok: true });
    },
  );
}

/**
 * The years actually closed right now.
 *
 * A close that has been reopened does not count. Its entry is still in the
 * books beside its reversal — which is the point of reversing rather than
 * deleting — so reading the closes alone would say a reopened year is closed,
 * refuse to close it again, and start the next year from a line nobody drew.
 */
async function closedYears(organizationId: string): Promise<Set<string>> {
  const entries = await db
    .select({ source: schema.journalEntries.source })
    .from(schema.journalEntries)
    .where(
      and(
        eq(schema.journalEntries.organizationId, organizationId),
        like(schema.journalEntries.source, "year-end%"),
      ),
    );

  const closed = new Set<string>();
  const reopened = new Set<string>();
  for (const entry of entries) {
    const source = entry.source ?? "";
    if (source.startsWith("year-end-reopened:")) {
      reopened.add(source.slice("year-end-reopened:".length));
    } else if (source.startsWith("year-end:")) {
      closed.add(source.slice("year-end:".length));
    }
  }
  for (const year of reopened) closed.delete(year);
  return closed;
}

interface Closing {
  endsOn: string;
  income: {
    accountId: string;
    code: string;
    name: string;
    balanceCents: number;
  }[];
  expenses: {
    accountId: string;
    code: string;
    name: string;
    balanceCents: number;
  }[];
  /** What equity gains — negative for a year that lost money. */
  retainedCents: number;
  lines: { accountId: string; debitCents?: number; creditCents?: number }[];
}

/**
 * What closing a year comes to, worked out once.
 *
 * The preview and the close read the same function, because a preview that
 * disagrees with what then happens is worse than no preview: an accountant
 * checks the figure, presses the button, and gets a different one.
 */
async function plan(
  organizationId: string,
  endsOnRaw: unknown,
): Promise<Closing | { error: string }> {
  const endsOn = String(endsOnRaw ?? "");
  const day = dayFrom(endsOn);
  if (!day) return { error: "the last day of the year, as 2026-12-31" };

  /**
   * Everything since the last close, up to this year end.
   *
   * From the day after the previous year end, so a business closing its
   * second year does not sweep its first year's profit into equity twice.
   */
  const years = [...(await closedYears(organizationId))].sort();
  const lastEnd =
    years.length > 0 ? dayFrom(years[years.length - 1] ?? "") : null;
  const from = lastEnd
    ? new Date(lastEnd.getTime() + 24 * 60 * 60 * 1000)
    : undefined;

  const to = endOfDay(endsOn);
  if (from && from > to) {
    return { error: "that year end is before the last one you closed" };
  }

  const rows = await ledgerRows(organizationId, { from, to });
  const income = totalsByAccount(rows, "income");
  const expenses = totalsByAccount(rows, "expense");

  /**
   * Emptied in the direction each account is read.
   *
   * `totalsByAccount` already reports income as a positive credit balance and
   * expenses as a positive debit balance, so closing one is the other side of
   * the same figure. A balance that is already zero contributes no line — an
   * entry full of zeroes is noise in the journal for ever.
   */
  const lines = [
    ...income
      .filter((account) => account.balanceCents !== 0)
      .map((account) =>
        account.balanceCents > 0
          ? { accountId: account.accountId, debitCents: account.balanceCents }
          : {
              accountId: account.accountId,
              creditCents: -account.balanceCents,
            },
      ),
    ...expenses
      .filter((account) => account.balanceCents !== 0)
      .map((account) =>
        account.balanceCents > 0
          ? { accountId: account.accountId, creditCents: account.balanceCents }
          : { accountId: account.accountId, debitCents: -account.balanceCents },
      ),
  ];

  const retainedCents =
    income.reduce((sum, a) => sum + a.balanceCents, 0) -
    expenses.reduce((sum, a) => sum + a.balanceCents, 0);

  return { endsOn, income, expenses, retainedCents, lines };
}

/** The last instant of a day, so an entry falls inside the year it closes. */
function endOfDay(endsOn: string): Date {
  return new Date(`${endsOn}T23:59:59.000Z`);
}
