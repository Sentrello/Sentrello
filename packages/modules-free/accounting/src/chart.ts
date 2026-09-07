import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, eq, inArray, isNull, schema } from "@sentrello/db";
import { ensureAccount } from "@sentrello/db/ledger";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";

/**
 * The chart of accounts — the list of buckets every figure lands in.
 *
 * Everything else in the module posts against a row here, which is why this is
 * the part a business is asked about first. It is a tree: an account may sit
 * under another, because "Utilities" under "Premises" is how somebody thinks
 * about it even when the numbering already implies it.
 */

export const ACCOUNT_TYPES = [
  "asset",
  "liability",
  "equity",
  "income",
  "expense",
] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];

/**
 * A chart a small business can start on the day it opens.
 *
 * Deliberately short. A standard chart with two hundred accounts is a chart
 * nobody codes anything to correctly — the point of offering one at all is that
 * somebody who has never kept books can record their first expense without
 * inventing a numbering scheme first. The codes follow the convention every
 * accountant expects: 1000s assets, 2000s liabilities, 3000s equity, 4000s
 * income, 5000s cost of sales, 6000s overheads.
 */
export const STANDARD_CHART: {
  code: string;
  name: string;
  type: AccountType;
  description?: string;
}[] = [
  { code: "1000", name: "Cash", type: "asset" },
  { code: "1010", name: "Bank Account", type: "asset" },
  {
    code: "1100",
    name: "Accounts Receivable",
    type: "asset",
    description: "Invoiced and not yet paid",
  },
  { code: "1400", name: "Equipment", type: "asset" },
  {
    code: "2000",
    name: "Accounts Payable",
    type: "liability",
    description: "Billed by suppliers and not yet paid",
  },
  {
    code: "2200",
    name: "Tax Payable",
    type: "liability",
    description: "Collected on sales and owed to the tax authority",
  },
  { code: "3000", name: "Owner's Equity", type: "equity" },
  { code: "3100", name: "Drawings", type: "equity" },
  { code: "4000", name: "Sales Income", type: "income" },
  { code: "4200", name: "Other Income", type: "income" },
  {
    code: "4100",
    name: "Sales Discounts",
    type: "expense",
    description: "What was given away, kept apart from what was never earned",
  },
  { code: "5000", name: "Cost of Sales", type: "expense" },
  { code: "6000", name: "General Expenses", type: "expense" },
  { code: "6100", name: "Rent", type: "expense" },
  { code: "6200", name: "Utilities", type: "expense" },
  { code: "6300", name: "Wages and Salaries", type: "expense" },
  { code: "6400", name: "Office Supplies", type: "expense" },
  { code: "6500", name: "Software and Subscriptions", type: "expense" },
  { code: "6600", name: "Travel", type: "expense" },
  { code: "6700", name: "Professional Fees", type: "expense" },
  { code: "6800", name: "Bank Charges", type: "expense" },
  {
    code: "6850",
    name: "Payment Processing Fees",
    type: "expense",
    description: "What a card or wallet processor kept out of a sale",
  },
];

/**
 * A shape check before the database sees it.
 *
 * Postgres rejects a malformed uuid with an error rather than an empty result,
 * so an id typed into a URL by hand would otherwise be a 500 rather than the
 * 404 it is.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}

/** Accounts an organization already has, by code. */
async function codesInUse(orgId: string): Promise<Set<string>> {
  const rows = await db
    .select({ code: schema.accounts.code })
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, orgId));
  return new Set(rows.map((row) => row.code));
}

/**
 * Whether making `parentId` the parent of `accountId` would close a loop.
 *
 * Walks up rather than trusting the immediate answer: A under B under C under
 * A passes every check that only looks one level, and produces a chart that
 * never finishes rendering.
 */
export async function wouldCycle(
  orgId: string,
  accountId: string,
  parentId: string,
): Promise<boolean> {
  if (accountId === parentId) return true;
  let cursor: string | null = isUuid(parentId) ? parentId : null;
  // A chart deep enough to hit this is already a mistake; the bound is here so
  // corrupted data cannot hang the request.
  for (let depth = 0; cursor && depth < 50; depth += 1) {
    const [row] = await db
      .select({ parentId: schema.accounts.parentId })
      .from(schema.accounts)
      .where(
        and(
          eq(schema.accounts.id, cursor),
          eq(schema.accounts.organizationId, orgId),
        ),
      )
      .limit(1);
    cursor = row?.parentId ?? null;
    if (cursor === accountId) return true;
  }
  return false;
}

/** Whether anything has ever been posted to an account. */
export async function hasPostings(accountId: string): Promise<boolean> {
  if (!isUuid(accountId)) return false;
  const [row] = await db
    .select({ id: schema.journalLines.id })
    .from(schema.journalLines)
    .where(eq(schema.journalLines.accountId, accountId))
    .limit(1);
  return Boolean(row);
}

export function registerChart(ctx: ModuleContext) {
  ctx.app.get(
    "/api/accounts",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const includeArchived = c.req.query("archived") === "1";
      const rows = await db
        .select()
        .from(schema.accounts)
        .where(
          includeArchived
            ? eq(schema.accounts.organizationId, orgId)
            : and(
                eq(schema.accounts.organizationId, orgId),
                isNull(schema.accounts.archivedAt),
              ),
        )
        .orderBy(schema.accounts.code);
      return c.json({ accounts: rows });
    },
  );

  ctx.app.post(
    "/api/accounts",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const code = String(body.code ?? "").trim();
      const name = String(body.name ?? "").trim();
      const type = String(body.type ?? "");

      if (!code || !name) return c.json({ error: "code and name" }, 400);
      if (!(ACCOUNT_TYPES as readonly string[]).includes(type)) {
        return c.json(
          { error: `type must be one of ${ACCOUNT_TYPES.join(", ")}` },
          400,
        );
      }
      /**
       * Codes are how an accountant refers to an account, and how an import
       * matches one. Two accounts sharing 6100 makes both meaningless.
       */
      if ((await codesInUse(orgId)).has(code)) {
        return c.json({ error: `account ${code} already exists` }, 409);
      }
      if (body.parentId && !(await ownedAccount(orgId, body.parentId))) {
        return c.json({ error: "unknown parent account" }, 400);
      }

      const [row] = await db
        .insert(schema.accounts)
        .values({
          organizationId: orgId,
          code,
          name,
          type,
          description: body.description ?? null,
          parentId: body.parentId ?? null,
        })
        .returning();
      return c.json({ account: row }, 201);
    },
  );

  ctx.app.patch(
    "/api/accounts/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!(await ownedAccount(orgId, id))) {
        return c.json({ error: "not found" }, 404);
      }
      const body = await c.req.json();

      if (body.code !== undefined) {
        const code = String(body.code).trim();
        if (!code) return c.json({ error: "code" }, 400);
        const [clash] = await db
          .select({ id: schema.accounts.id })
          .from(schema.accounts)
          .where(
            and(
              eq(schema.accounts.organizationId, orgId),
              eq(schema.accounts.code, code),
            ),
          )
          .limit(1);
        if (clash && clash.id !== id) {
          return c.json({ error: `account ${code} already exists` }, 409);
        }
      }

      if (body.parentId) {
        if (!(await ownedAccount(orgId, body.parentId))) {
          return c.json({ error: "unknown parent account" }, 400);
        }
        if (await wouldCycle(orgId, id, String(body.parentId))) {
          return c.json({ error: "an account cannot sit under itself" }, 400);
        }
      }

      /**
       * The type is not editable once anything is posted.
       *
       * Turning an expense account into an asset does not move the postings
       * that are already on it — it silently rewrites every report that has
       * ever been run, including ones a business has already filed.
       */
      if (
        body.type !== undefined &&
        !(ACCOUNT_TYPES as readonly string[]).includes(String(body.type))
      ) {
        return c.json({ error: "unknown type" }, 400);
      }
      if (body.type !== undefined && (await hasPostings(id))) {
        return c.json(
          { error: "an account with postings cannot change type" },
          409,
        );
      }

      const [row] = await db
        .update(schema.accounts)
        .set({
          ...(body.code !== undefined
            ? { code: String(body.code).trim() }
            : {}),
          ...(body.name !== undefined
            ? { name: String(body.name).trim() }
            : {}),
          ...(body.type !== undefined ? { type: String(body.type) } : {}),
          ...(body.description !== undefined
            ? { description: body.description || null }
            : {}),
          ...(body.parentId !== undefined
            ? { parentId: body.parentId || null }
            : {}),
          ...(body.archived !== undefined
            ? { archivedAt: body.archived ? new Date() : null }
            : {}),
        })
        .where(
          and(
            eq(schema.accounts.id, id),
            eq(schema.accounts.organizationId, orgId),
          ),
        )
        .returning();
      return c.json({ account: row });
    },
  );

  ctx.app.delete(
    "/api/accounts/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["delete"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!(await ownedAccount(orgId, id))) {
        return c.json({ error: "not found" }, 404);
      }
      /**
       * An account carrying history is archived, never removed: deleting it
       * would orphan journal lines, and a journal line without an account is a
       * report that no longer adds up.
       */
      if (await hasPostings(id)) {
        return c.json(
          {
            error:
              "this account has postings against it — archive it instead so the history stays",
          },
          409,
        );
      }
      const children = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(
          and(
            eq(schema.accounts.organizationId, orgId),
            eq(schema.accounts.parentId, id),
          ),
        );
      if (children.length > 0) {
        return c.json({ error: "this account has accounts under it" }, 409);
      }
      await db
        .delete(schema.accounts)
        .where(
          and(
            eq(schema.accounts.id, id),
            eq(schema.accounts.organizationId, orgId),
          ),
        );
      return c.json({ deleted: true });
    },
  );

  /**
   * Fills in the standard chart, adding only what is missing.
   *
   * Idempotent because a business that already recorded something has accounts
   * that things are posted to, and a second press must not produce a second
   * "Rent" for the next expense to be split across.
   */
  ctx.app.post(
    "/api/accounts/standard",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const existing = await codesInUse(orgId);
      const missing = STANDARD_CHART.filter(
        (account) => !existing.has(account.code),
      );
      for (const account of missing) {
        await ensureAccount(orgId, {
          code: account.code,
          name: account.name,
          type: account.type,
        });
        if (account.description) {
          await db
            .update(schema.accounts)
            .set({ description: account.description })
            .where(
              and(
                eq(schema.accounts.organizationId, orgId),
                eq(schema.accounts.code, account.code),
              ),
            );
        }
      }
      return c.json({ added: missing.length });
    },
  );

  /** Which accounts carry a balance, so the pickers can hide the rest. */
  ctx.app.get(
    "/api/accounts/balances",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const accounts = await db
        .select()
        .from(schema.accounts)
        .where(eq(schema.accounts.organizationId, orgId));
      if (accounts.length === 0) return c.json({ balances: [] });

      const lines = await db
        .select({
          accountId: schema.journalLines.accountId,
          debitCents: schema.journalLines.debitCents,
          creditCents: schema.journalLines.creditCents,
        })
        .from(schema.journalLines)
        .where(
          inArray(
            schema.journalLines.accountId,
            accounts.map((a) => a.id),
          ),
        );

      const debitPositive = new Set(["asset", "expense"]);
      const totals = new Map<string, number>();
      for (const line of lines) {
        totals.set(
          line.accountId,
          (totals.get(line.accountId) ?? 0) +
            line.debitCents -
            line.creditCents,
        );
      }
      return c.json({
        balances: accounts.map((account) => ({
          id: account.id,
          code: account.code,
          name: account.name,
          type: account.type,
          balanceCents: debitPositive.has(account.type)
            ? (totals.get(account.id) ?? 0)
            : -(totals.get(account.id) ?? 0),
        })),
      });
    },
  );
}

/** An id the caller supplied, confirmed to belong to this business. */
export async function ownedAccount(
  orgId: string,
  accountId: string,
): Promise<boolean> {
  if (!isUuid(String(accountId))) return false;
  const [row] = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, String(accountId)),
        eq(schema.accounts.organizationId, orgId),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * The same, and of a kind that makes sense where it is about to be used.
 *
 * Ownership is not the only thing wrong an account id can be. Categorising an
 * expense to `1000 Cash` is accepted by every ownership check in this module,
 * posts a journal entry that balances, and produces books nobody can read: the
 * money leaves the business and the profit and loss reports no expense at all,
 * because a profit and loss is built from income and expense accounts and Cash
 * is neither. The demo seed did exactly this for months — eight overheads on
 * the ledger and `Expenses $0.00` on the summary screen above them.
 *
 * So where a route already knows what kind of account belongs in a field, it
 * says so, and a request naming the wrong kind is refused rather than posted.
 */
export async function ownedAccountOfType(
  orgId: string,
  accountId: string,
  types: readonly AccountType[],
): Promise<boolean> {
  if (!isUuid(String(accountId))) return false;
  const [row] = await db
    .select({ type: schema.accounts.type })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, String(accountId)),
        eq(schema.accounts.organizationId, orgId),
      ),
    )
    .limit(1);
  return Boolean(row) && types.includes(row?.type as AccountType);
}
