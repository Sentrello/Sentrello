import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, inArray, isNull, schema } from "@sentrello/db";
import {
  CORE_ACCOUNTS,
  alreadyReversed,
  ensureAccount,
  postJournalEntry,
  reverseJournalEntries,
} from "@sentrello/db/ledger";
import { documentTotals, invoiceStatus } from "@sentrello/db/money";
import type { ModuleContext, RouteContext } from "@sentrello/module-sdk";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { isUuid, ownedAccount } from "./chart";
import { baseCurrency, exchangeAccount, rateOn, toBaseCents } from "./currency";
import { accountingValues } from "./custom-fields";

/**
 * Bills — somebody asking this business for money.
 *
 * The mirror of invoicing, and deliberately a separate document rather than an
 * invoice with the sign flipped: a bill arrives with the supplier's own number
 * on it, ages into a different report, and is settled from a bank account
 * rather than into one. One table with a direction flag would put a supplier's
 * demand one wrong query away from a customer's statement.
 *
 * A vendor is a CRM contact of kind `supplier`. Nothing here keeps a second
 * list of the people a business buys from.
 */

/** What a bill's lines come to, using the same arithmetic invoices use. */
export function billTotals(
  lines: { quantityMilli: number; unitPriceCents: number; taxRateBp: number }[],
) {
  return documentTotals(
    lines.map((line) => ({
      quantity: line.quantityMilli / 1000,
      unitPrice: line.unitPriceCents,
      taxRateBp: line.taxRateBp,
    })),
  );
}

/**
 * How much of a bill is still owed.
 *
 * Shares `invoiceStatus` with the sales side: "paid when the payments reach the
 * total, partial when they are between" is the same rule whichever direction
 * the money goes, and two implementations of it would eventually disagree.
 */
export function billStatus(totalCents: number, paidCents: number) {
  return invoiceStatus(totalCents, paidCents);
}

/** A line as it will be stored, once what arrived has been checked. */
export type StoredLine = {
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxRateBp: number;
  accountId: string | null;
  taxDefinitionId: string | null;
  /** Which part of the business this line is for, if any. */
  classId: string | null;
  locationId: string | null;
};

/**
 * Lines as they will be stored, or the reason they cannot be.
 *
 * Every figure is checked here rather than at the database: a quantity that
 * arrives as "2" and a price that arrives as 19.99 both look fine until the
 * total is a fraction of a cent, and money in this product is whole cents or
 * it is refused.
 */
export function readLines(
  input: unknown,
): { lines: StoredLine[] } | { error: string } {
  if (!Array.isArray(input) || input.length === 0) {
    return { error: "a bill needs at least one line" };
  }
  const lines: StoredLine[] = [];
  for (const [i, raw] of input.entries()) {
    const description = String(raw?.description ?? "").trim();
    if (!description) return { error: `line ${i + 1}: a description` };
    const quantityMilli = Number(raw?.quantityMilli ?? 1000);
    const unitPriceCents = Number(raw?.unitPriceCents);
    const taxRateBp = Number(raw?.taxRateBp ?? 0);
    if (!Number.isInteger(quantityMilli) || quantityMilli <= 0) {
      return { error: `line ${i + 1}: quantity` };
    }
    if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
      return { error: `line ${i + 1}: unitPriceCents must be whole cents` };
    }
    if (!Number.isInteger(taxRateBp) || taxRateBp < 0) {
      return { error: `line ${i + 1}: taxRateBp must be basis points` };
    }
    lines.push({
      description,
      quantityMilli,
      unitPriceCents,
      taxRateBp,
      accountId: raw?.accountId ? String(raw.accountId) : null,
      taxDefinitionId: raw?.taxDefinitionId
        ? String(raw.taxDefinitionId)
        : null,
      classId: raw?.classId ? String(raw.classId) : null,
      locationId: raw?.locationId ? String(raw.locationId) : null,
    });
  }
  return { lines };
}

/** How much of a bill's tax the business gets back, and how much it does not. */
export async function splitTax(
  orgId: string,
  lines: StoredLine[],
): Promise<{ recoverableCents: number; sunkCents: number }> {
  const ids = [
    ...new Set(
      lines.map((l) => l.taxDefinitionId).filter((id): id is string => !!id),
    ),
  ];
  const definitions = ids.length
    ? await db
        .select({
          id: schema.taxDefinitions.id,
          recoverable: schema.taxDefinitions.recoverable,
        })
        .from(schema.taxDefinitions)
        .where(
          and(
            eq(schema.taxDefinitions.organizationId, orgId),
            inArray(schema.taxDefinitions.id, ids),
          ),
        )
    : [];
  const recoverableById = new Map(
    definitions.map((d) => [d.id, d.recoverable] as const),
  );

  let recoverableCents = 0;
  let sunkCents = 0;
  for (const line of lines) {
    const net = Math.round((line.quantityMilli / 1000) * line.unitPriceCents);
    const tax = Math.round((net * line.taxRateBp) / 10000);
    if (tax === 0) continue;
    /**
     * A line with no named rate is treated as recoverable, because every
     * regime that lets a rate be typed without naming it — VAT, GST — is one
     * where the tax comes back. US sales tax is picked from a definition, and
     * that definition says it does not.
     */
    const recoverable = line.taxDefinitionId
      ? (recoverableById.get(line.taxDefinitionId) ?? true)
      : true;
    if (recoverable) recoverableCents += tax;
    else sunkCents += tax;
  }
  return { recoverableCents, sunkCents };
}

/**
 * The entry a bill makes when it is approved.
 *
 * Dr each line's expense account with what it cost, Dr tax that comes back, and
 * credit Accounts Payable with the whole of it — because until it is paid, the
 * total is a debt the business owes.
 */
async function postBill(
  orgId: string,
  bill: { id: string; number: string | null; totalCents: number },
  lines: StoredLine[],
  billDate: Date,
  rateMicro: number,
): Promise<void> {
  const { recoverableCents, sunkCents } = await splitTax(orgId, lines);
  const payable = await ensureAccount(orgId, {
    code: "2000",
    name: "Accounts Payable",
    type: "liability",
  });
  const fallbackExpense = await ensureAccount(
    orgId,
    CORE_ACCOUNTS.generalExpense,
  );
  const taxAccount = await ensureAccount(orgId, CORE_ACCOUNTS.taxPayable);

  /**
   * Net per account, in the currency the books are kept in.
   *
   * Converted line by line and then reconciled to the document's converted
   * total below, because a bill in euros is a debt of euros: the total is what
   * the supplier will chase for, and the lines have to add up to it.
   */
  /**
   * Keyed by account *and* by what the line was for.
   *
   * Two lines on one bill against the same expense account but two different
   * jobs are two postings, not one: collapsing them by account alone would
   * lose exactly the split the business added the classes to see.
   */
  const byAccount = new Map<string, number>();
  const netTotal = lines.reduce(
    (sum, line) =>
      sum + Math.round((line.quantityMilli / 1000) * line.unitPriceCents),
    0,
  );
  for (const line of lines) {
    const key = postingKey(
      line.accountId ?? fallbackExpense,
      line.classId ?? null,
      line.locationId ?? null,
    );
    const net = Math.round((line.quantityMilli / 1000) * line.unitPriceCents);
    byAccount.set(key, (byAccount.get(key) ?? 0) + net);
  }
  if (sunkCents > 0) {
    /**
     * Sales tax that cannot be reclaimed is part of what the thing cost.
     *
     * Given to the largest line's account rather than spread, so the cents
     * always add up to the bill: a spread that rounds is a journal entry that
     * does not balance, and `postJournalEntry` would refuse it — correctly.
     */
    let biggest = postingKey(fallbackExpense, null, null);
    let most = -1;
    for (const [key, net] of byAccount) {
      if (net > most) {
        most = net;
        biggest = key;
      }
    }
    byAccount.set(biggest, (byAccount.get(biggest) ?? 0) + sunkCents);
  }

  const debits = netTotal + sunkCents + recoverableCents;
  if (debits !== bill.totalCents) {
    throw new Error(
      `bill ${bill.id}: lines come to ${debits} and the total says ${bill.totalCents}`,
    );
  }

  const postings = [...byAccount.entries()].map(([key, amount]) => ({
    ...readPostingKey(key),
    debitCents: toBaseCents(amount, rateMicro),
  }));
  if (recoverableCents > 0) {
    postings.push({
      accountId: taxAccount,
      debitCents: toBaseCents(recoverableCents, rateMicro),
      // Reclaimable tax belongs to the business, not to a job: it comes back
      // whichever part of the business incurred it.
      classId: null,
      locationId: null,
    });
  }

  /**
   * The rounding, given to the largest line.
   *
   * Each converted line rounds on its own, so their sum can be a cent or two
   * away from the converted total. The credit has to be the converted total —
   * that is the debt — so the difference goes somewhere rather than being left
   * to make the entry unbalanced, which `postJournalEntry` would refuse.
   */
  const credit = toBaseCents(bill.totalCents, rateMicro);
  const debited = postings.reduce(
    (sum, posting) => sum + posting.debitCents,
    0,
  );
  if (debited !== credit && postings.length > 0) {
    let biggest = 0;
    for (let i = 1; i < postings.length; i += 1) {
      if (
        (postings[i]?.debitCents ?? 0) > (postings[biggest]?.debitCents ?? 0)
      ) {
        biggest = i;
      }
    }
    const target = postings[biggest];
    if (target) target.debitCents += credit - debited;
  }

  await postJournalEntry(
    orgId,
    `Bill ${bill.number ?? bill.id.slice(0, 8)}`,
    `bill:${bill.id}`,
    [...postings, { accountId: payable, creditCents: credit }],
    billDate,
  );
}

/**
 * One posting is an account and what the spending was for.
 *
 * A composite key rather than nested maps: this is only ever built and read
 * back a few lines apart, and the pipe cannot appear in a uuid.
 */
function postingKey(
  accountId: string,
  classId: string | null,
  locationId: string | null,
): string {
  return `${accountId}|${classId ?? ""}|${locationId ?? ""}`;
}

function readPostingKey(key: string): {
  accountId: string;
  classId: string | null;
  locationId: string | null;
} {
  const [accountId = "", classId = "", locationId = ""] = key.split("|");
  return {
    accountId,
    classId: classId || null,
    locationId: locationId || null,
  };
}

async function ownedBill(orgId: string, id: string) {
  if (!isUuid(id)) return null;
  const [row] = await db
    .select()
    .from(schema.bills)
    .where(
      and(
        eq(schema.bills.id, id),
        eq(schema.bills.organizationId, orgId),
        isNull(schema.bills.deletedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * What has settled a bill, by any means.
 *
 * Money paid, and credits the supplier gave. A credit is not a payment — no
 * money moved and the bank statement will never show it — but it settles the
 * bill just as finally, and counting only the payments leaves a liability on
 * the balance sheet that will never be cleared and an aged-payables report
 * saying the business is behind on a bill it does not owe.
 *
 * One helper, because every caller that asks "how much is left" has to get the
 * same answer: the over-payment guard, the list, and the bill itself.
 */
export async function settledOn(billId: string): Promise<number> {
  const [payments, credits] = await Promise.all([
    db
      .select({ amountCents: schema.billPayments.amountCents })
      .from(schema.billPayments)
      .where(eq(schema.billPayments.billId, billId)),
    db
      .select({ amountCents: schema.vendorCreditApplications.amountCents })
      .from(schema.vendorCreditApplications)
      .where(eq(schema.vendorCreditApplications.billId, billId)),
  ]);
  return [...payments, ...credits].reduce(
    (sum, row) => sum + row.amountCents,
    0,
  );
}

export function registerPurchases(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  /** Suppliers, which is the CRM's contacts seen from the buying side. */
  ctx.app.get(
    "/api/bills/vendors",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select({
          id: schema.contacts.id,
          name: schema.contacts.name,
          email: schema.contacts.email,
          companyId: schema.contacts.companyId,
        })
        .from(schema.contacts)
        .where(
          and(
            eq(schema.contacts.organizationId, orgId),
            eq(schema.contacts.kind, "supplier"),
          ),
        )
        .orderBy(schema.contacts.name);
      return c.json({ vendors: rows });
    },
  );

  ctx.app.get(
    "/api/bills",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const status = c.req.query("status");
      const rows = await db
        .select()
        .from(schema.bills)
        .where(
          and(
            eq(schema.bills.organizationId, orgId),
            isNull(schema.bills.deletedAt),
            ...(status ? [eq(schema.bills.status, status)] : []),
          ),
        )
        .orderBy(desc(schema.bills.billDate));

      const payments = rows.length
        ? await db
            .select({
              billId: schema.billPayments.billId,
              amountCents: schema.billPayments.amountCents,
            })
            .from(schema.billPayments)
            .where(
              inArray(
                schema.billPayments.billId,
                rows.map((r) => r.id),
              ),
            )
        : [];

      const credits = rows.length
        ? await db
            .select({
              billId: schema.vendorCreditApplications.billId,
              amountCents: schema.vendorCreditApplications.amountCents,
            })
            .from(schema.vendorCreditApplications)
            .where(
              inArray(
                schema.vendorCreditApplications.billId,
                rows.map((r) => r.id),
              ),
            )
        : [];

      return c.json({
        bills: rows.map((bill) => {
          const of = (
            list: { billId: string; amountCents: number }[],
          ): number =>
            list
              .filter((row) => row.billId === bill.id)
              .reduce((sum, row) => sum + row.amountCents, 0);
          const paidCents = of(payments);
          // A credit settles a bill as finally as money does.
          const settledCents = paidCents + of(credits);
          return {
            ...bill,
            paidCents,
            settledCents,
            balanceDue: billStatus(bill.totalCents, settledCents).balanceDue,
          };
        }),
      });
    },
  );

  ctx.app.get(
    "/api/bills/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const bill = await ownedBill(orgId, c.req.param("id") ?? "");
      if (!bill) return c.json({ error: "not found" }, 404);
      const [lines, payments] = await Promise.all([
        db
          .select()
          .from(schema.billLines)
          .where(eq(schema.billLines.billId, bill.id))
          .orderBy(schema.billLines.sortOrder),
        db
          .select()
          .from(schema.billPayments)
          .where(eq(schema.billPayments.billId, bill.id)),
      ]);
      const paidCents = payments.reduce((sum, p) => sum + p.amountCents, 0);
      // Credits settle it too, and the balance has to say so.
      const settledCents = await settledOn(bill.id);
      return c.json({
        bill: {
          ...bill,
          paidCents,
          settledCents,
          balanceDue: billStatus(bill.totalCents, settledCents).balanceDue,
        },
        lines,
        payments,
      });
    },
  );

  ctx.app.post(
    "/api/bills",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = await c.req.json();
      const read = readLines(body.lines);
      if ("error" in read) return c.json({ error: read.error }, 400);
      const { lines } = read;

      for (const line of lines) {
        if (line.accountId && !(await ownedAccount(orgId, line.accountId))) {
          return c.json({ error: "unknown account" }, 400);
        }
      }

      const currency = String(body.currency ?? "")
        .trim()
        .toUpperCase();
      if (currency && !/^[A-Z]{3}$/.test(currency)) {
        return c.json({ error: "a three-letter currency code" }, 400);
      }

      const totals = billTotals(lines);
      const billDate = body.billDate ? new Date(body.billDate) : new Date();
      if (Number.isNaN(billDate.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }

      const bill = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(schema.bills)
          .values({
            organizationId: orgId,
            vendorId: body.vendorId ?? null,
            number: body.number ?? null,
            currency: currency || (await baseCurrency(orgId)),
            billDate,
            dueDate: body.dueDate ? new Date(body.dueDate) : null,
            subtotalCents: totals.subtotal,
            taxCents: totals.tax,
            totalCents: totals.total,
            notes: body.notes ?? null,
            receiptFileKey: body.receiptFileKey ?? null,
            // Only against fields this business defined; anything else is
            // dropped rather than written onto the record for ever.
            customValues: await accountingValues(orgId, "bill", body.custom),
          })
          .returning();
        if (!created) throw new Error("bill insert returned no row");
        await tx.insert(schema.billLines).values(
          lines.map((line, i) => ({
            billId: created.id,
            description: line.description,
            quantityMilli: line.quantityMilli,
            unitPriceCents: line.unitPriceCents,
            accountId: line.accountId,
            taxDefinitionId: line.taxDefinitionId,
            taxRateBp: line.taxRateBp,
            classId: line.classId,
            locationId: line.locationId,
            sortOrder: i,
          })),
        );
        return created;
      });

      return c.json({ bill }, 201);
    },
  );

  /**
   * Approving a bill is what puts it in the books.
   *
   * A draft is somebody typing; an approved bill is a debt the business admits
   * to, which is the moment it belongs in Accounts Payable and in the expense
   * accounts. Nothing posts before that, so a mistyped draft costs nothing to
   * throw away.
   */
  ctx.app.post(
    "/api/bills/:id/approve",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const bill = await ownedBill(orgId, c.req.param("id") ?? "");
      if (!bill) return c.json({ error: "not found" }, 404);
      if (bill.status !== "draft") {
        return c.json({ error: "this bill is already in the books" }, 409);
      }

      const lines = (await db
        .select()
        .from(schema.billLines)
        .where(eq(schema.billLines.billId, bill.id))) as StoredLine[];
      if (lines.length === 0) {
        return c.json({ error: "a bill needs at least one line" }, 400);
      }

      /**
       * What the currency was worth on the day of the bill.
       *
       * Refused rather than assumed when the business has never recorded a
       * rate: posting a foreign bill at 1:1 would put a plausible and wrong
       * number in the books, and nothing downstream would question it.
       */
      const rateMicro = await rateOn(orgId, bill.currency, bill.billDate);
      if (rateMicro === null) {
        return c.json(
          {
            error: `no exchange rate recorded for ${bill.currency} on or before that date`,
          },
          400,
        );
      }

      await postBill(orgId, bill, lines, bill.billDate, rateMicro);
      const [updated] = await db
        .update(schema.bills)
        .set({ status: "open", rateMicro, updatedAt: new Date() })
        .where(eq(schema.bills.id, bill.id))
        .returning();
      return c.json({ bill: updated });
    },
  );

  /**
   * Paying one, in full or in part.
   *
   * Dr Accounts Payable with what the supplier is no longer owed, Cr the
   * account the money left. Where tax is withheld, the supplier receives less
   * and the difference is credited to the tax account instead — the debt is
   * settled either way, which is why the debit is the full amount.
   */
  ctx.app.post(
    "/api/bills/:id/payments",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const bill = await ownedBill(orgId, c.req.param("id") ?? "");
      if (!bill) return c.json({ error: "not found" }, 404);
      if (bill.status === "draft") {
        return c.json({ error: "approve the bill before paying it" }, 409);
      }
      if (bill.status === "void") {
        return c.json({ error: "this bill was voided" }, 409);
      }

      const body = await c.req.json();
      const amountCents = body.amountCents;
      const withheldCents = body.withheldCents ?? 0;
      if (!Number.isInteger(amountCents) || amountCents <= 0) {
        return c.json(
          { error: "amountCents must be a positive whole number of cents" },
          400,
        );
      }
      if (!Number.isInteger(withheldCents) || withheldCents < 0) {
        return c.json({ error: "withheldCents must be whole cents" }, 400);
      }
      if (withheldCents > amountCents) {
        return c.json(
          { error: "more cannot be withheld than is being paid" },
          400,
        );
      }
      /**
       * Paying more than is owed is a typo, not generosity. Left as an error
       * rather than capped: the business has to decide whether the extra was a
       * different bill or a wrong figure.
       */
      const paidAlready = await settledOn(bill.id);
      if (paidAlready + amountCents > bill.totalCents) {
        return c.json(
          {
            error: `this bill has ${bill.totalCents - paidAlready} cents left to pay`,
          },
          400,
        );
      }
      if (
        body.paidThroughAccountId &&
        !(await ownedAccount(orgId, String(body.paidThroughAccountId)))
      ) {
        return c.json({ error: "unknown account" }, 400);
      }

      const paidAt = body.paidAt ? new Date(body.paidAt) : new Date();
      if (Number.isNaN(paidAt.getTime())) {
        return c.json({ error: "unreadable date" }, 400);
      }

      const [payment] = await db
        .insert(schema.billPayments)
        .values({
          organizationId: orgId,
          billId: bill.id,
          amountCents,
          withheldCents,
          paidAt,
          method: body.method ?? null,
          reference: body.reference ?? null,
          paidThroughAccountId: body.paidThroughAccountId ?? null,
        })
        .returning();
      if (!payment) throw new Error("bill payment insert returned no row");

      const [payable, cash, taxAccount] = await Promise.all([
        ensureAccount(orgId, {
          code: "2000",
          name: "Accounts Payable",
          type: "liability",
        }),
        body.paidThroughAccountId
          ? Promise.resolve(String(body.paidThroughAccountId))
          : ensureAccount(orgId, CORE_ACCOUNTS.cash),
        ensureAccount(orgId, CORE_ACCOUNTS.taxPayable),
      ]);

      /**
       * Two rates, and the difference between them.
       *
       * The liability was recorded at the rate on the day of the bill, so that
       * is the rate the debt is cleared at. The money actually left at today's
       * rate. The gap is neither a cost the business chose nor income it
       * earned — the rate moved — so it lands in its own account, and without
       * it the entry would simply not balance.
       */
      const paidRate =
        (await rateOn(orgId, bill.currency, paidAt)) ?? bill.rateMicro;
      const clearedCents = toBaseCents(amountCents, bill.rateMicro);
      const leftCents = toBaseCents(amountCents - withheldCents, paidRate);
      const withheldBaseCents = toBaseCents(withheldCents, paidRate);
      const difference = clearedCents - leftCents - withheldBaseCents;

      await postJournalEntry(
        orgId,
        `Paid bill ${bill.number ?? bill.id.slice(0, 8)}`,
        `bill-payment:${payment.id}`,
        [
          { accountId: payable, debitCents: clearedCents },
          { accountId: cash, creditCents: leftCents },
          ...(withheldBaseCents > 0
            ? [{ accountId: taxAccount, creditCents: withheldBaseCents }]
            : []),
          ...(difference !== 0
            ? [
                difference > 0
                  ? {
                      accountId: await exchangeAccount(orgId),
                      creditCents: difference,
                    }
                  : {
                      accountId: await exchangeAccount(orgId),
                      debitCents: -difference,
                    },
              ]
            : []),
        ],
        paidAt,
      );

      const paidCents = paidAlready + amountCents;
      const { status } = billStatus(bill.totalCents, paidCents);
      await db
        .update(schema.bills)
        .set({ status, updatedAt: new Date() })
        .where(eq(schema.bills.id, bill.id));

      return c.json({ payment, status, paidCents }, 201);
    },
  );

  /**
   * Voiding one, which reverses whatever it put in the books.
   *
   * A bill that was never approved is only a draft, so there is nothing to
   * reverse and it is simply filed away.
   */
  ctx.app.post(
    "/api/bills/:id/void",
    requireSession(),
    requirePermission({ bookkeeping: ["delete"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const bill = await ownedBill(orgId, c.req.param("id") ?? "");
      if (!bill) return c.json({ error: "not found" }, 404);
      if (bill.status === "void") return c.json({ bill });
      if ((await settledOn(bill.id)) > 0) {
        return c.json(
          { error: "this bill has been paid — undo the payment first" },
          409,
        );
      }

      if (
        bill.status !== "draft" &&
        !(await alreadyReversed(orgId, `bill:${bill.id}`))
      ) {
        await reverseJournalEntries(
          orgId,
          `bill:${bill.id}`,
          `Voided bill ${bill.number ?? bill.id.slice(0, 8)}`,
        );
      }
      const [updated] = await db
        .update(schema.bills)
        .set({ status: "void", updatedAt: new Date() })
        .where(eq(schema.bills.id, bill.id))
        .returning();
      return c.json({ bill: updated });
    },
  );
}
