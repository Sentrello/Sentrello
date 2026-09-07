import {
  activeOrganizationId,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, inArray, isNull, schema } from "@sentrello/db";
import { ensureAccount, postJournalEntry } from "@sentrello/db/ledger";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { ownedAccount } from "./chart";
import { settledOn } from "./purchases";

/**
 * The supplier's own credit note, which is not a payment.
 *
 * Goods went back, a bill was overcharged, a subscription was refunded part
 * way through. The business owes less than the bill says and nobody has moved
 * any money — so recording it as a payment makes the bank reconciliation wrong
 * for ever, and recording nothing leaves a liability that will never be
 * settled and an aged-payables report saying the business is behind on a bill
 * it does not owe.
 *
 * Two steps, deliberately. Issuing the credit reduces what is owed straight
 * away; handing it out against particular bills happens later, because a
 * supplier commonly issues a credit before anybody has decided which bill it
 * comes off, and holding one with nothing to put it against is ordinary.
 */
export function registerVendorCredits(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  ctx.app.get(
    "/api/vendor-credits",
    requireSession(),
    requirePermission({ bookkeeping: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const credits = await db
        .select()
        .from(schema.vendorCredits)
        .where(eq(schema.vendorCredits.organizationId, orgId))
        .orderBy(desc(schema.vendorCredits.issuedAt));

      const applications = await db
        .select()
        .from(schema.vendorCreditApplications)
        .where(eq(schema.vendorCreditApplications.organizationId, orgId));

      return c.json({
        credits: credits.map((credit) => {
          const used = applications
            .filter((row) => row.creditId === credit.id)
            .reduce((sum, row) => sum + row.amountCents, 0);
          return {
            ...credit,
            appliedCents: used,
            // What is still in hand, which is the only figure anybody asks of
            // a credit they are holding.
            remainingCents: credit.voidedAt ? 0 : credit.amountCents - used,
          };
        }),
        applications,
      });
    },
  );

  /**
   * Recording one, which takes the liability off immediately.
   *
   * Debit Accounts Payable, credit the expense it came back off. Waiting until
   * it is applied to a bill would leave the balance sheet claiming the
   * business owes money it has already been told it does not.
   */
  ctx.app.post(
    "/api/vendor-credits",
    requireSession(),
    requirePermission({ bookkeeping: ["create"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const amountCents = body.amountCents;
      if (
        typeof amountCents !== "number" ||
        !Number.isInteger(amountCents) ||
        amountCents <= 0
      ) {
        return c.json(
          { error: "what the credit is for, in whole pennies" },
          400,
        );
      }

      const expenseAccountId = String(body.expenseAccountId ?? "");
      if (!(await ownedAccount(orgId, expenseAccountId))) {
        /**
         * Which expense it comes back off, named rather than pooled.
         *
         * Every credit landing in one bucket leaves a business's fuel costs
         * overstated and a "supplier credits" line nobody can act on.
         */
        return c.json(
          { error: "say which expense the credit comes back off" },
          400,
        );
      }

      const issuedAt = body.issuedAt
        ? new Date(String(body.issuedAt))
        : new Date();
      if (Number.isNaN(issuedAt.getTime())) {
        return c.json({ error: "that is not a date" }, 400);
      }

      const [credit] = await db
        .insert(schema.vendorCredits)
        .values({
          organizationId: orgId,
          vendorId: body.vendorId ? String(body.vendorId) : null,
          number: body.number ? String(body.number).slice(0, 60) : null,
          issuedAt,
          amountCents,
          expenseAccountId,
          notes: body.notes ? String(body.notes).slice(0, 500) : null,
        })
        .returning();
      if (!credit) throw new Error("the credit was not written");

      const payable = await payableAccount(orgId);
      await postJournalEntry(
        orgId,
        `Credit from supplier${credit.number ? ` ${credit.number}` : ""}`,
        `vendor-credit:${credit.id}`,
        [
          { accountId: payable, debitCents: amountCents },
          { accountId: expenseAccountId, creditCents: amountCents },
        ],
        issuedAt,
      );

      return c.json({ credit }, 201);
    },
  );

  /**
   * Putting one, or part of one, against a bill.
   *
   * Nothing is posted here. The credit already took the liability off when it
   * was issued, and posting again would take it off twice — a payables balance
   * that goes negative and a supplier the books say owes the business money.
   * This says which bill stops being outstanding.
   */
  ctx.app.post(
    "/api/vendor-credits/:id/apply",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const credit = await creditOf(orgId, c.req.param("id") ?? "");
      if (!credit) return c.json({ error: "not found" }, 404);
      if (credit.voidedAt) {
        return c.json({ error: "that credit has been cancelled" }, 409);
      }

      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const billId = String(body.billId ?? "");
      const [bill] = await db
        .select()
        .from(schema.bills)
        .where(
          and(
            eq(schema.bills.id, billId),
            eq(schema.bills.organizationId, orgId),
            isNull(schema.bills.deletedAt),
          ),
        )
        .limit(1);
      if (!bill) return c.json({ error: "not found" }, 404);
      if (bill.status === "draft" || bill.status === "void") {
        // A draft is not in the books and a void one is out of them; putting a
        // credit against either settles nothing and hides the credit.
        return c.json(
          { error: "that bill is not one anybody owes money on" },
          409,
        );
      }

      const remaining = await remainingOn(orgId, credit);
      if (remaining <= 0) {
        // Said as what it is. Falling through to the amount check answers
        // "how much of it, in whole pennies" to somebody who asked for none
        // of it because there is none left.
        return c.json({ error: "none of that credit is left" }, 409);
      }

      const owing = bill.totalCents - (await settledOn(bill.id));
      if (owing <= 0) {
        return c.json({ error: "that bill has nothing left on it" }, 409);
      }
      const asked = body.amountCents;
      const amountCents =
        asked === undefined || asked === null
          ? // Nothing said means as much of it as the bill can take, which is
            // what somebody clicking "use this credit" means.
            Math.min(remaining, owing)
          : asked;

      if (
        typeof amountCents !== "number" ||
        !Number.isInteger(amountCents) ||
        amountCents <= 0
      ) {
        return c.json({ error: "how much of it, in whole pennies" }, 400);
      }
      if (amountCents > remaining) {
        return c.json(
          { error: `only ${money(remaining)} of that credit is left` },
          409,
        );
      }
      if (amountCents > owing) {
        /**
         * Never more than the bill owes.
         *
         * Over-applying makes a bill look overpaid and quietly loses the rest
         * of the credit, which is money the business is entitled to.
         */
        return c.json(
          { error: `that bill only has ${money(owing)} left on it` },
          409,
        );
      }

      const [application] = await db
        .insert(schema.vendorCreditApplications)
        .values({
          organizationId: orgId,
          creditId: credit.id,
          billId: bill.id,
          amountCents,
        })
        .returning();

      await restate(orgId, bill.id, bill.totalCents);

      return c.json({ application }, 201);
    },
  );

  /**
   * Taking one back off a bill.
   *
   * Applied to the wrong bill, which is the commonest mistake here and needs
   * to be an undo rather than a support call. The credit itself is untouched —
   * it was always the business's, and only where it sits changes.
   */
  ctx.app.delete(
    "/api/vendor-credits/applications/:id",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [gone] = await db
        .delete(schema.vendorCreditApplications)
        .where(
          and(
            eq(schema.vendorCreditApplications.id, c.req.param("id") ?? ""),
            eq(schema.vendorCreditApplications.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);

      const [bill] = await db
        .select()
        .from(schema.bills)
        .where(
          and(
            eq(schema.bills.id, gone.billId),
            eq(schema.bills.organizationId, orgId),
          ),
        )
        .limit(1);
      if (bill) await restate(orgId, bill.id, bill.totalCents);

      return c.json({ ok: true });
    },
  );

  /**
   * Cancelling a credit the supplier withdrew.
   *
   * Reversed rather than deleted, like everything else that has reached the
   * ledger, and refused once any of it has been used — that part has settled a
   * bill, and taking it back would make the bill outstanding again with no
   * record of why.
   */
  ctx.app.post(
    "/api/vendor-credits/:id/void",
    requireSession(),
    requirePermission({ bookkeeping: ["update"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const credit = await creditOf(orgId, c.req.param("id") ?? "");
      if (!credit) return c.json({ error: "not found" }, 404);
      if (credit.voidedAt) {
        return c.json({ error: "that credit has been cancelled" }, 409);
      }

      const used = credit.amountCents - (await remainingOn(orgId, credit));
      if (used > 0) {
        return c.json(
          {
            error: `${money(used)} of that credit has already settled a bill — take it off the bill first`,
          },
          409,
        );
      }

      const payable = await payableAccount(orgId);
      await postJournalEntry(
        orgId,
        `Cancelled credit from supplier${credit.number ? ` ${credit.number}` : ""}`,
        `vendor-credit-void:${credit.id}`,
        [
          {
            accountId: credit.expenseAccountId,
            debitCents: credit.amountCents,
          },
          { accountId: payable, creditCents: credit.amountCents },
        ],
      );

      const [voided] = await db
        .update(schema.vendorCredits)
        .set({ voidedAt: new Date() })
        .where(
          and(
            eq(schema.vendorCredits.id, credit.id),
            eq(schema.vendorCredits.organizationId, orgId),
            // Only from unvoided, so pressing twice cancels it once.
            isNull(schema.vendorCredits.voidedAt),
          ),
        )
        .returning();
      if (!voided) {
        return c.json({ error: "that credit has been cancelled" }, 409);
      }

      return c.json({ credit: voided });
    },
  );
}

type Credit = typeof schema.vendorCredits.$inferSelect;

async function creditOf(
  organizationId: string,
  id: string,
): Promise<Credit | undefined> {
  const [row] = await db
    .select()
    .from(schema.vendorCredits)
    .where(
      and(
        eq(schema.vendorCredits.id, id),
        eq(schema.vendorCredits.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row;
}

/** How much of a credit is still in hand. */
async function remainingOn(
  organizationId: string,
  credit: Credit,
): Promise<number> {
  const rows = await db
    .select({ amountCents: schema.vendorCreditApplications.amountCents })
    .from(schema.vendorCreditApplications)
    .where(
      and(
        eq(schema.vendorCreditApplications.creditId, credit.id),
        eq(schema.vendorCreditApplications.organizationId, organizationId),
      ),
    );
  return (
    credit.amountCents - rows.reduce((sum, row) => sum + row.amountCents, 0)
  );
}

/**
 * The bill's status, said again after a credit moved.
 *
 * A bill settled by a credit is paid, and one a credit came off again is open.
 * Leaving the status alone would show a paid bill on the payables report and
 * an unpaid one nobody chases.
 */
async function restate(
  organizationId: string,
  billId: string,
  totalCents: number,
): Promise<void> {
  const settled = await settledOn(billId);
  const status =
    settled <= 0 ? "open" : settled >= totalCents ? "paid" : "partial";
  await db
    .update(schema.bills)
    .set({ status })
    .where(
      and(
        eq(schema.bills.id, billId),
        eq(schema.bills.organizationId, organizationId),
        /**
         * Only a bill that is out for payment.
         *
         * A draft was never in the books and a void one is out of them. Either
         * would be silently reopened by a balance calculation that knows
         * nothing about why it is not open.
         */
        inArray(schema.bills.status, ["open", "partial", "paid"]),
      ),
    );
}

/** The one payables account every module posts to. */
async function payableAccount(organizationId: string): Promise<string> {
  return ensureAccount(organizationId, {
    code: "2000",
    name: "Accounts Payable",
    type: "liability",
  });
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}
