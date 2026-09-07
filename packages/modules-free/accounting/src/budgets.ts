import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, schema } from "@sentrello/db";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { isUuid, ownedAccount } from "./chart";
import { ledgerRows, totalsByAccount } from "./reports";

/**
 * A budget, and how the year is actually going against it.
 *
 * A figure per account, either for the whole year or month by month. Kept apart
 * from the ledger entirely — a budget is what somebody intends, and the ledger
 * is what happened, and the moment those two live in the same table one of them
 * starts changing the other.
 */

export interface BudgetLine {
  accountId: string;
  month: number;
  amountCents: number;
}

/** What a budget allows for one account, over a whole year or a month of it. */
export function budgetedFor(
  lines: BudgetLine[],
  accountId: string,
  month?: number,
): number {
  return lines
    .filter((line) => line.accountId === accountId)
    .filter((line) =>
      month === undefined
        ? true
        : // A figure set for the whole year is spread evenly when a single
          // month is asked for: a business that budgets 12,000 for rent has
          // budgeted 1,000 for March whether or not it said so.
          line.month === month || line.month === 0,
    )
    .reduce((sum, line) => {
      if (month !== undefined && line.month === 0) {
        return sum + Math.round(line.amountCents / 12);
      }
      return sum + line.amountCents;
    }, 0);
}

/**
 * The figures beside what actually happened, account by account.
 *
 * `month` narrows both halves to one month of the year. Left off, it is the
 * year — which is how most small businesses budget, and why it is the default
 * rather than a mode.
 */
export function compare(
  lines: BudgetLine[],
  actuals: {
    accountId: string;
    code: string;
    name: string;
    balanceCents: number;
  }[],
  month?: number,
): {
  accountId: string;
  code: string;
  name: string;
  budgetedCents: number;
  actualCents: number;
  varianceCents: number;
}[] {
  const accounts = new Map<
    string,
    { code: string; name: string; actualCents: number }
  >();
  for (const actual of actuals) {
    accounts.set(actual.accountId, {
      code: actual.code,
      name: actual.name,
      actualCents: actual.balanceCents,
    });
  }
  // An account that was budgeted for and never used still belongs in the
  // report: "we set aside 5,000 for training and spent nothing" is the most
  // useful line on it.
  for (const line of lines) {
    if (!accounts.has(line.accountId)) {
      accounts.set(line.accountId, { code: "", name: "", actualCents: 0 });
    }
  }

  return [...accounts.entries()]
    .map(([accountId, account]) => {
      const budgetedCents = budgetedFor(lines, accountId, month);
      return {
        accountId,
        code: account.code,
        name: account.name,
        budgetedCents,
        actualCents: account.actualCents,
        // Positive means under budget, which is the direction a business wants
        // to read as good news on an expense line.
        varianceCents: budgetedCents - account.actualCents,
      };
    })
    .filter((row) => row.budgetedCents !== 0 || row.actualCents !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}

export function registerBudgets(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/budgets",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.budgets)
        .where(eq(schema.budgets.organizationId, orgId))
        .orderBy(schema.budgets.year);
      return c.json({ budgets: rows });
    },
  );

  ctx.app.post(
    "/api/budgets",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const name = String(body.name ?? "").trim();
      const year = Number(body.year);
      if (!name) return c.json({ error: "a name" }, 400);
      if (!Number.isInteger(year) || year < 1970 || year > 2200) {
        return c.json({ error: "a year" }, 400);
      }
      const [row] = await db
        .insert(schema.budgets)
        .values({ organizationId: orgId, name, year })
        .returning();
      return c.json({ budget: row }, 201);
    },
  );

  /**
   * Setting the figures, all at once.
   *
   * The whole set is replaced rather than patched line by line: a budget is
   * edited as a grid, and a half-applied grid is a budget that adds up to
   * something nobody typed.
   */
  ctx.app.put(
    "/api/budgets/:id/lines",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);
      const [budget] = await db
        .select()
        .from(schema.budgets)
        .where(
          and(
            eq(schema.budgets.id, id),
            eq(schema.budgets.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!budget) return c.json({ error: "not found" }, 404);

      const body = await c.req.json();
      if (!Array.isArray(body.lines)) {
        return c.json({ error: "lines" }, 400);
      }
      const lines: BudgetLine[] = [];
      for (const [i, raw] of body.lines.entries()) {
        const accountId = String(raw?.accountId ?? "");
        const month = Number(raw?.month ?? 0);
        const amountCents = Number(raw?.amountCents ?? 0);
        if (!(await ownedAccount(orgId, accountId))) {
          return c.json({ error: `line ${i + 1}: unknown account` }, 400);
        }
        if (!Number.isInteger(month) || month < 0 || month > 12) {
          return c.json({ error: `line ${i + 1}: month must be 0 to 12` }, 400);
        }
        if (!Number.isInteger(amountCents)) {
          return c.json(
            { error: `line ${i + 1}: amountCents must be whole cents` },
            400,
          );
        }
        lines.push({ accountId, month, amountCents });
      }

      await db.transaction(async (tx) => {
        await tx
          .delete(schema.budgetLines)
          .where(eq(schema.budgetLines.budgetId, budget.id));
        if (lines.length > 0) {
          await tx
            .insert(schema.budgetLines)
            .values(lines.map((line) => ({ budgetId: budget.id, ...line })));
        }
      });
      return c.json({ lines: lines.length });
    },
  );

  /** The budget against what the ledger says actually happened. */
  ctx.app.get(
    "/api/budgets/:id/actuals",
    requireSession(),
    requirePermission({ reports: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);
      const [budget] = await db
        .select()
        .from(schema.budgets)
        .where(
          and(
            eq(schema.budgets.id, id),
            eq(schema.budgets.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!budget) return c.json({ error: "not found" }, 404);

      /**
       * One month of the year, or the whole of it.
       *
       * Anything that is not a month is the year rather than an error: the
       * screen sends what a person picked from a list, and a report is a poor
       * place to refuse somebody over a query string.
       */
      const asked = Number(c.req.query("month"));
      const month =
        Number.isInteger(asked) && asked >= 1 && asked <= 12
          ? asked
          : undefined;

      const lines = await db
        .select({
          accountId: schema.budgetLines.accountId,
          month: schema.budgetLines.month,
          amountCents: schema.budgetLines.amountCents,
        })
        .from(schema.budgetLines)
        .where(eq(schema.budgetLines.budgetId, budget.id));

      const from = month
        ? new Date(Date.UTC(budget.year, month - 1, 1))
        : new Date(Date.UTC(budget.year, 0, 1));
      const to = month
        ? new Date(Date.UTC(budget.year, month, 0, 23, 59, 59))
        : new Date(Date.UTC(budget.year, 11, 31, 23, 59, 59));

      const rows = await ledgerRows(orgId, { from, to });
      const actuals = [
        ...totalsByAccount(rows, "expense"),
        ...totalsByAccount(rows, "income"),
      ];

      return c.json({
        budget,
        month: month ?? null,
        // The stored figures as they are, so the screen can edit one month
        // without sending back a year it has not seen.
        lines,
        rows: compare(lines, actuals, month),
      });
    },
  );
}
