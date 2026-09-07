import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, gte, ilike, lte, schema, sql } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  alreadyReversed,
  ensureAccount,
  postJournalEntry,
  reverseJournalEntries,
} from "@sentrello/db/ledger";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import type { AccountType } from "./chart";
import { isUuid, ownedAccount, ownedAccountOfType } from "./chart";
import { accountingValues } from "./custom-fields";
import { taggingFrom } from "./dimensions";

/**
 * Money in and money out, where no invoice was involved.
 *
 * A row here is what somebody typed; the journal entry it posts is what the
 * books say. Both exist because they answer different questions — "what did I
 * record on Tuesday" and "what do I owe" — and because a receipt has to hang
 * off something a person recognises.
 *
 * Every write goes through the ledger. A transaction that failed to post would
 * be money that appears on this screen and in no report, which is the worst
 * kind of wrong: it looks recorded.
 */

export const TRANSACTION_KINDS = ["income", "expense"] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

/**
 * The two lines an amount becomes.
 *
 * Money out debits what it was spent on and credits the account it left;
 * money in debits the account it arrived in and credits what earned it. Kept
 * as a pure function so the direction can be tested without a database — it is
 * the one thing here that being wrong would silently invert a business's
 * profit.
 */
export function postingsFor(
  kind: TransactionKind,
  categoryAccountId: string,
  paidThroughAccountId: string,
  amountCents: number,
  /**
   * Which part of the business it belongs to.
   *
   * On the income or expense line only, never on the bank side. A job did not
   * receive the cash — the business did — and tagging the bank line would make
   * every class's balance sheet claim a share of one bank account.
   */
  tagging: { classId: string | null; locationId: string | null } = {
    classId: null,
    locationId: null,
  },
): {
  accountId: string;
  debitCents?: number;
  creditCents?: number;
  classId?: string | null;
  locationId?: string | null;
}[] {
  return kind === "expense"
    ? [
        { accountId: categoryAccountId, debitCents: amountCents, ...tagging },
        { accountId: paidThroughAccountId, creditCents: amountCents },
      ]
    : [
        { accountId: paidThroughAccountId, debitCents: amountCents },
        { accountId: categoryAccountId, creditCents: amountCents, ...tagging },
      ];
}

/** What the journal calls this transaction, so a correction can find it. */
export function sourceOf(kind: TransactionKind, id: string): string {
  // `expense:` rather than `transaction:` because expenses recorded before
  // this module existed are already in the ledger under that name, and a
  // correction has to find those too.
  return `${kind}:${id}`;
}

/** A date the caller supplied, or now. Rejects nonsense rather than storing it. */
export function parseDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return new Date();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

async function defaultCategory(
  orgId: string,
  kind: TransactionKind,
): Promise<string> {
  return ensureAccount(
    orgId,
    kind === "expense"
      ? CORE_ACCOUNTS.generalExpense
      : { code: "4200", name: "Other Income", type: "income" },
  );
}

/**
 * The kind of account each side of the ledger is categorised to.
 *
 * `defaultCategory` above has always chosen correctly when the caller names no
 * account. This is the same rule for the case where they do.
 */
const CATEGORY_TYPE = {
  expense: "expense",
  income: "income",
} as const satisfies Record<TransactionKind, AccountType>;

/**
 * Said in the words of the thing being recorded rather than the ledger's.
 *
 * "unknown account" is what an id from another business gets, and it would be
 * a lie here: the account exists and is theirs. Somebody categorising a
 * courier fee to Cash needs to be told which drawer it belongs in, not that
 * the drawer is missing.
 */
const CATEGORY_ERROR = {
  expense: "money out must be categorised to an expense account",
  income: "money in must be categorised to an income account",
} as const satisfies Record<TransactionKind, string>;

/** Which contact it was with, if the caller named one this business owns. */
async function ownedContact(
  orgId: string,
  contactId: unknown,
): Promise<string | null> {
  if (!contactId || !isUuid(String(contactId))) return null;
  const [row] = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.id, String(contactId)),
        eq(schema.contacts.organizationId, orgId),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/**
 * Recording money moving, once, for every caller that can do it.
 *
 * Both endpoints below land here rather than each doing their own insert and
 * their own posting: two paths that write the books are two chances for one of
 * them to skip the journal, and a transaction that never reached the ledger
 * shows on the screen and in no report.
 */
export async function createTransaction(
  orgId: string,
  body: Record<string, unknown>,
): Promise<
  { transaction: typeof schema.transactions.$inferSelect } | { error: string }
> {
  const kind = String(body.kind ?? "expense") as TransactionKind;
  if (!(TRANSACTION_KINDS as readonly string[]).includes(kind)) {
    return { error: "kind must be income or expense" };
  }
  const amountCents = body.amountCents;
  if (!Number.isInteger(amountCents) || (amountCents as number) <= 0) {
    return { error: "amountCents must be a positive whole number of cents" };
  }
  const occurredAt = parseDate(body.occurredAt ?? body.spentAt);
  if (!occurredAt) return { error: "unreadable date" };

  /**
   * Both accounts are ids the caller supplied, so both are checked against
   * this business before a single line is posted: an id belonging to another
   * tenant must never become a journal line here.
   *
   * The category is also checked for *kind*. Money out is categorised to an
   * expense account and money in to an income account; anything else balances
   * and then vanishes from the profit and loss, which reports those two types
   * and no others. See `ownedAccountOfType`.
   */
  if (
    body.accountId &&
    !(await ownedAccountOfType(orgId, String(body.accountId), [
      CATEGORY_TYPE[kind],
    ]))
  ) {
    return { error: CATEGORY_ERROR[kind] };
  }
  if (
    body.paidThroughAccountId &&
    !(await ownedAccount(orgId, String(body.paidThroughAccountId)))
  ) {
    return { error: "unknown account" };
  }

  /**
   * The class and location, both checked before anything is written.
   *
   * Refused as a pair: a request naming a location that is not this business's
   * should not quietly post with the class it did get right.
   */
  const tags = await taggingFrom(orgId, body);
  if ("error" in tags) return { error: tags.error };
  const tagging = tags;

  const [categoryAccountId, paidThroughAccountId] = await Promise.all([
    body.accountId
      ? Promise.resolve(String(body.accountId))
      : defaultCategory(orgId, kind),
    body.paidThroughAccountId
      ? Promise.resolve(String(body.paidThroughAccountId))
      : ensureAccount(orgId, CORE_ACCOUNTS.cash),
  ]);

  const [row] = await db
    .insert(schema.transactions)
    .values({
      organizationId: orgId,
      kind,
      accountId: categoryAccountId,
      paidThroughAccountId,
      contactId: await ownedContact(orgId, body.contactId),
      amountCents: amountCents as number,
      currency: typeof body.currency === "string" ? body.currency : "USD",
      occurredAt,
      reference: (body.reference as string) ?? null,
      method: (body.method as string) ?? null,
      description: ((body.description ?? body.vendor) as string) ?? null,
      receiptFileKey: (body.receiptFileKey as string) ?? null,
      // Only against fields this business defined; anything else is dropped
      // rather than written onto the record for ever.
      customValues: await accountingValues(orgId, "transaction", body.custom),
    })
    .returning();
  if (!row) throw new Error("transaction insert returned no row");

  await postJournalEntry(
    orgId,
    memoFor(kind, row.description),
    sourceOf(kind, row.id),
    postingsFor(
      kind,
      categoryAccountId,
      paidThroughAccountId,
      row.amountCents,
      tagging,
    ),
    occurredAt,
  );
  return { transaction: row };
}

/** What the entry is called in the journal. */
export function memoFor(
  kind: TransactionKind,
  description: string | null,
): string {
  const label = kind === "expense" ? "Expense" : "Income";
  return description ? `${label} — ${description}` : label;
}

export function registerTransactions(ctx: ModuleContext) {
  ctx.app.get(
    "/api/transactions",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const kind = c.req.query("kind");
      const from = parseDate(c.req.query("from") ?? null);
      const to = parseDate(c.req.query("to") ?? null);

      // By what it says on the line: "Screwfix", "diesel", the reference off a
      // statement. Searching in the browser means fetching a year of entries
      // to look through them.
      const q = (c.req.query("q") ?? "").trim();

      const where = and(
        eq(schema.transactions.organizationId, orgId),
        ...(kind && (TRANSACTION_KINDS as readonly string[]).includes(kind)
          ? [eq(schema.transactions.kind, kind)]
          : []),
        ...(c.req.query("from") && from
          ? [gte(schema.transactions.occurredAt, from)]
          : []),
        ...(c.req.query("to") && to
          ? [lte(schema.transactions.occurredAt, to)]
          : []),
        ...(q ? [ilike(schema.transactions.description, `%${q}%`)] : []),
      );

      const rows = await db
        .select()
        .from(schema.transactions)
        .where(where)
        .orderBy(desc(schema.transactions.occurredAt));

      /**
       * What the rows on screen come to.
       *
       * The figure somebody is actually after when they filter to "fuel, this
       * quarter" — and adding it up by hand off the screen is how a business
       * gets a different answer every time it asks.
       */
      const [totals] = await db
        .select({
          inCents: sql<number>`coalesce(sum(
            case when ${schema.transactions.kind} = 'income'
              and ${schema.transactions.reversedAt} is null
              then ${schema.transactions.amountCents} else 0 end
          ), 0)::int`,
          outCents: sql<number>`coalesce(sum(
            case when ${schema.transactions.kind} = 'expense'
              and ${schema.transactions.reversedAt} is null
              then ${schema.transactions.amountCents} else 0 end
          ), 0)::int`,
        })
        .from(schema.transactions)
        .where(where);

      return c.json({
        transactions: rows,
        totals: {
          inCents: totals?.inCents ?? 0,
          outCents: totals?.outCents ?? 0,
          netCents: (totals?.inCents ?? 0) - (totals?.outCents ?? 0),
        },
      });
    },
  );

  ctx.app.post(
    "/api/transactions",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const result = await createTransaction(orgId, await c.req.json());
      return "error" in result
        ? c.json({ error: result.error }, 400)
        : c.json({ transaction: result.transaction }, 201);
    },
  );

  /**
   * Recording an expense, under the name the rest of the product calls it.
   *
   * The same store and the same posting as a transaction of kind expense —
   * this endpoint predates the module and is what a customer's own scripts
   * call, so it keeps working rather than being a second way to write the
   * books.
   */
  ctx.app.post(
    "/api/expenses",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const result = await createTransaction(orgId, {
        ...(await c.req.json()),
        kind: "expense",
      });
      if ("error" in result) return c.json({ error: result.error }, 400);
      const row = result.transaction;
      return c.json(
        {
          expense: {
            id: row.id,
            accountId: row.accountId,
            amountCents: row.amountCents,
            vendor: row.description,
            receiptFileKey: row.receiptFileKey,
            spentAt: row.occurredAt,
            // A field the business defined and the response never returned is
            // a field nobody can see they filled in.
            customValues: row.customValues,
          },
        },
        201,
      );
    },
  );

  /**
   * Editing one is undoing it and recording it again.
   *
   * Anything that changes what the books say — the amount, either account, the
   * date — is a correction, and a correction in double-entry is a reversal
   * followed by the new entry. Wording, references and receipts change in
   * place, because none of them is a figure.
   */
  ctx.app.patch(
    "/api/transactions/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);

      const [existing] = await db
        .select()
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!existing) return c.json({ error: "not found" }, 404);
      if (existing.reversedAt) {
        return c.json({ error: "this transaction was undone" }, 409);
      }

      const body = await c.req.json();
      if (
        body.amountCents !== undefined &&
        (!Number.isInteger(body.amountCents) || body.amountCents <= 0)
      ) {
        return c.json(
          { error: "amountCents must be a positive whole number of cents" },
          400,
        );
      }
      // Recategorising has the same rule as categorising: an expense moved
      // onto an asset account would balance and then disappear from the
      // profit and loss. The kind is the row's own and cannot be edited.
      const kind = existing.kind as TransactionKind;
      if (
        body.accountId &&
        !(await ownedAccountOfType(orgId, body.accountId, [
          CATEGORY_TYPE[kind],
        ]))
      ) {
        return c.json({ error: CATEGORY_ERROR[kind] }, 400);
      }
      if (
        body.paidThroughAccountId &&
        !(await ownedAccount(orgId, body.paidThroughAccountId))
      ) {
        return c.json({ error: "unknown account" }, 400);
      }
      const occurredAt =
        body.occurredAt === undefined
          ? existing.occurredAt
          : parseDate(body.occurredAt);
      if (!occurredAt) return c.json({ error: "unreadable date" }, 400);

      const amountCents = body.amountCents ?? existing.amountCents;
      const accountId = body.accountId
        ? String(body.accountId)
        : existing.accountId;
      const paidThroughAccountId = body.paidThroughAccountId
        ? String(body.paidThroughAccountId)
        : existing.paidThroughAccountId;

      const figuresChanged =
        amountCents !== existing.amountCents ||
        accountId !== existing.accountId ||
        paidThroughAccountId !== existing.paidThroughAccountId ||
        occurredAt.getTime() !== existing.occurredAt.getTime();

      const [row] = await db
        .update(schema.transactions)
        .set({
          amountCents,
          accountId,
          paidThroughAccountId,
          occurredAt,
          ...(body.contactId !== undefined
            ? { contactId: await ownedContact(orgId, body.contactId) }
            : {}),
          ...(body.reference !== undefined
            ? { reference: body.reference || null }
            : {}),
          ...(body.method !== undefined ? { method: body.method || null } : {}),
          ...(body.description !== undefined
            ? { description: body.description || null }
            : {}),
          ...(body.receiptFileKey !== undefined
            ? { receiptFileKey: body.receiptFileKey || null }
            : {}),
        })
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.organizationId, orgId),
          ),
        )
        .returning();
      if (!row) throw new Error("transaction update returned no row");

      if (figuresChanged && accountId && paidThroughAccountId) {
        const kind = existing.kind as TransactionKind;
        await reverseJournalEntries(
          orgId,
          sourceOf(kind, id),
          `Correction — ${row.description ?? kind}`,
        );
        await postJournalEntry(
          orgId,
          memoFor(kind, row.description),
          sourceOf(kind, id),
          postingsFor(kind, accountId, paidThroughAccountId, amountCents),
          occurredAt,
        );
      }

      return c.json({ transaction: row });
    },
  );

  /**
   * Undoing one, which is not the same as removing it.
   *
   * The row stays and the ledger gains the opposite entry. A business that
   * printed a report last week can still explain the figure on it, which is
   * the entire reason the books are append-only.
   */
  ctx.app.delete(
    "/api/transactions/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["delete"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const id = c.req.param("id") ?? "";
      if (!isUuid(id)) return c.json({ error: "not found" }, 404);

      const [existing] = await db
        .select()
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.organizationId, orgId),
          ),
        )
        .limit(1);
      if (!existing) return c.json({ error: "not found" }, 404);
      if (existing.reversedAt) return c.json({ reversed: true });

      const kind = existing.kind as TransactionKind;
      const source = sourceOf(kind, id);
      /**
       * A second press must not post the correction twice. The stamp on the row
       * is the usual guard, but two requests arriving together both read it as
       * absent, so the ledger itself is asked as well.
       */
      if (!(await alreadyReversed(orgId, source))) {
        await reverseJournalEntries(
          orgId,
          source,
          `Undone — ${existing.description ?? kind}`,
        );
      }
      await db
        .update(schema.transactions)
        .set({ reversedAt: new Date() })
        .where(
          and(
            eq(schema.transactions.id, id),
            eq(schema.transactions.organizationId, orgId),
          ),
        );
      return c.json({ reversed: true });
    },
  );

  /**
   * The expenses endpoint the rest of the product already calls.
   *
   * Projects links a cost to a job through this, and it predates the module —
   * so it keeps working and keeps its shape, over the same rows the
   * transactions screen writes. One store, two names, rather than two stores.
   */
  ctx.app.get(
    "/api/expenses",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.transactions)
        .where(
          and(
            eq(schema.transactions.organizationId, orgId),
            eq(schema.transactions.kind, "expense"),
          ),
        )
        .orderBy(desc(schema.transactions.occurredAt));
      return c.json({
        expenses: rows.map((row) => ({
          id: row.id,
          accountId: row.accountId,
          amountCents: row.amountCents,
          vendor: row.description,
          receiptFileKey: row.receiptFileKey,
          spentAt: row.occurredAt,
          reversedAt: row.reversedAt,
        })),
      });
    },
  );
}
