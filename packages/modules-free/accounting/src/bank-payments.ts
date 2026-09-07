import {
  activeOrganizationId,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";
import { and, db, desc, eq, gte, isNull, schema } from "@sentrello/db";
import { ensureAccount, postJournalEntry } from "@sentrello/db/ledger";
import { record } from "@sentrello/db/security-events";
import type {
  ModuleContext,
  RouteContext,
  SentrelloEnv,
} from "@sentrello/module-sdk";
import { banking, secrets } from "@sentrello/module-sdk";
import type { MiddlewareHandler } from "hono";
import { credentialsFor } from "./bank-feeds";
import { ownedAccount } from "./chart";

/**
 * Sending money, which is the one thing here that cannot be taken back.
 *
 * Everything else in this module can be corrected: a wrong entry is reversed,
 * a wrong rule is undone, a wrong reconciliation is abandoned. A payment that
 * has left the bank has left the bank, and the person pressing the button is
 * usually not the person who will find out it was wrong.
 *
 * So the rules here are stricter than anywhere else in the product:
 *
 *  - **Its own permission.** `payments.send` is not `bookkeeping.update`. A
 *    bookkeeper reconciles and categorises all day and never needs to move a
 *    penny, and the two being one permission is how a compromised bookkeeping
 *    login becomes a bank transfer.
 *  - **Written down before it is sent.** If the provider answers and the
 *    process dies, the record exists and the status can be asked for. A
 *    payment we cannot account for is worse than one that failed.
 *  - **One press is one payment.** Every attempt carries a key, unique per
 *    business, so a double-click finds the first attempt instead of sending a
 *    second.
 *  - **The books follow the money, never lead it.** The journal entry is
 *    posted after the provider has accepted, from what the provider said —
 *    books that record a payment the bank refused are books that disagree with
 *    the statement for ever.
 *  - **Nothing is offered that the provider cannot do.** A bank with no
 *    payments, or no repeating payments, says so, and the screen does not ask.
 */
export function registerBankPayments(
  ctx: ModuleContext,
  proOnly: MiddlewareHandler<SentrelloEnv>,
) {
  /**
   * Twice an hour, the ones that never reached the books.
   *
   * A payment is written down, sent, and then posted — and a process that dies
   * between the second and the third leaves money gone from the bank and
   * nothing in the ledger. This finds those and posts them.
   *
   * It does **not** ask the bank what became of a pending payment. Neither
   * provider adapter can be asked yet, and a job that pretended to would be
   * worse than one that says what it does: the status a payment carries is
   * what the provider said when it was sent, and the bank feed is what proves
   * the money actually moved.
   */
  ctx.registerJob({
    name: "bank-payments",
    cron: "9,39 * * * *",
    handler: async () => {
      if (!ctx.entitled({ tier: "pro" })) return { skipped: "not entitled" };
      return { checked: await settleOutstanding() };
    },
  });

  ctx.app.get(
    "/api/payees",
    requireSession(),
    requirePermission({ payments: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const rows = await db
        .select()
        .from(schema.payees)
        .where(
          and(
            eq(schema.payees.organizationId, orgId),
            isNull(schema.payees.archivedAt),
          ),
        );
      return c.json({
        payees: rows.map((row) => ({
          id: row.id,
          contactId: row.contactId,
          name: row.name,
          kind: row.kind,
          // The numbers themselves never leave the database: on their own they
          // are enough to take money out of an account.
          accountLast4: row.accountLast4,
        })),
        maySend: await mayAccess(c.req.raw.headers, { payments: ["send"] }),
      });
    },
  );

  ctx.app.post(
    "/api/payees",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const name = String(body.name ?? "")
        .trim()
        .slice(0, 120);
      if (!name) return c.json({ error: "who is being paid" }, 400);

      const accountNumber = String(body.accountNumber ?? "").replace(/\D/g, "");
      const routingNumber = String(body.routingNumber ?? "").replace(/\D/g, "");
      if (accountNumber.length < 4 || accountNumber.length > 17) {
        return c.json({ error: "that is not an account number" }, 400);
      }
      if (routingNumber.length !== 9) {
        // US routing numbers are nine digits and carry a check digit; both are
        // worth refusing on, because the money goes wherever the number says.
        return c.json({ error: "a routing number is nine digits" }, 400);
      }
      if (!validRouting(routingNumber)) {
        return c.json(
          { error: "that routing number does not check out — read it again" },
          400,
        );
      }

      const kind = String(body.kind ?? "business");
      if (kind !== "business" && kind !== "personal") {
        return c.json({ error: "a business or a person" }, 400);
      }

      const [payee] = await db
        .insert(schema.payees)
        .values({
          organizationId: orgId,
          contactId: body.contactId ? String(body.contactId) : null,
          name,
          kind,
          accountNumber: secrets.seal(accountNumber),
          routingNumber: secrets.seal(routingNumber),
          accountLast4: accountNumber.slice(-4),
        })
        .returning();

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "payee.added",
        detail: { name, last4: accountNumber.slice(-4) },
      });

      return c.json(
        {
          payee: {
            id: payee?.id,
            name,
            kind,
            accountLast4: accountNumber.slice(-4),
          },
        },
        201,
      );
    },
  );

  ctx.app.delete(
    "/api/payees/:id",
    requireSession(),
    requirePermission({ payments: ["connect"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [gone] = await db
        .update(schema.payees)
        .set({ archivedAt: new Date() })
        .where(
          and(
            eq(schema.payees.id, c.req.param("id") ?? ""),
            eq(schema.payees.organizationId, orgId),
          ),
        )
        .returning();
      if (!gone) return c.json({ error: "not found" }, 404);
      // Retired rather than deleted: payments already sent point at it, and a
      // payment whose payee has vanished cannot be explained to anybody.
      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "payee.removed",
        detail: { name: gone.name },
      });
      return c.json({ ok: true });
    },
  );

  ctx.app.get(
    "/api/bank-payments",
    requireSession(),
    requirePermission({ payments: ["read"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [payments, schedules] = await Promise.all([
        db
          .select()
          .from(schema.bankPayments)
          .where(eq(schema.bankPayments.organizationId, orgId))
          .orderBy(desc(schema.bankPayments.createdAt))
          .limit(200),
        db
          .select()
          .from(schema.bankPaymentSchedules)
          .where(eq(schema.bankPaymentSchedules.organizationId, orgId)),
      ]);
      return c.json({ payments, schedules });
    },
  );

  /**
   * Sending one.
   *
   * `payments.send`, and nothing else in the product uses it.
   */
  ctx.app.post(
    "/api/bank-payments",
    requireSession(),
    requirePermission({ payments: ["send"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const prepared = await prepare(orgId, body);
      if ("error" in prepared) {
        return c.json({ error: prepared.error }, prepared.status);
      }

      /**
       * The same key twice is the same payment.
       *
       * Answered before anything is sent, and again by the unique constraint
       * underneath — two requests arriving together both pass this check, and
       * only one of them gets a row.
       */
      const key = String(body.idempotencyKey ?? "").slice(0, 100);
      if (!key) {
        return c.json(
          { error: "a payment needs a key so it cannot be sent twice" },
          400,
        );
      }
      const [seen] = await db
        .select()
        .from(schema.bankPayments)
        .where(
          and(
            eq(schema.bankPayments.organizationId, orgId),
            eq(schema.bankPayments.idempotencyKey, key),
          ),
        )
        .limit(1);
      if (seen) return c.json({ payment: seen, repeated: true });

      if (!prepared.provider.pay) {
        return c.json(
          {
            error: `${prepared.provider.capabilities().name} cannot send payments`,
          },
          409,
        );
      }

      /**
       * Written down before it is sent, and only then sent.
       *
       * If the provider answers and this process dies, the row exists and its
       * state can be asked for. A payment nobody can account for is worse than
       * one that failed loudly.
       */
      let payment: typeof schema.bankPayments.$inferSelect | undefined;
      try {
        [payment] = await db
          .insert(schema.bankPayments)
          .values({
            organizationId: orgId,
            payeeId: prepared.payee.id,
            billId: prepared.billId,
            connectionId: prepared.connection.id,
            fromAccountReference: prepared.fromAccountReference,
            fromLedgerAccountId: prepared.fromLedgerAccountId,
            amountCents: prepared.amountCents,
            currency: prepared.currency,
            description: prepared.description,
            idempotencyKey: key,
            status: "draft",
            createdBy: c.get("session").user.id,
          })
          .returning();
      } catch {
        // The unique constraint: two presses arriving together.
        const [other] = await db
          .select()
          .from(schema.bankPayments)
          .where(
            and(
              eq(schema.bankPayments.organizationId, orgId),
              eq(schema.bankPayments.idempotencyKey, key),
            ),
          )
          .limit(1);
        if (other) return c.json({ payment: other, repeated: true });
        throw new Error("the payment could not be recorded");
      }
      if (!payment) throw new Error("the payment could not be recorded");

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "payment.sent",
        detail: {
          payee: prepared.payee.name,
          amountCents: prepared.amountCents,
          last4: prepared.payee.accountLast4,
        },
      });

      let result: banking.PaymentResult;
      try {
        result = await prepared.provider.pay(
          prepared.credentials,
          secrets.open(prepared.connection.accessToken),
          {
            fromAccountReference: prepared.fromAccountReference,
            amountCents: prepared.amountCents,
            currency: prepared.currency,
            description: prepared.description,
            payee: prepared.payeeDetails,
          },
        );
      } catch (err) {
        const message = (err as Error).message;
        await db
          .update(schema.bankPayments)
          .set({ status: "failed", lastError: message, updatedAt: new Date() })
          .where(eq(schema.bankPayments.id, payment.id));
        // The refusal, in the bank's own words: "insufficient funds" is
        // something a person can act on and "payment failed" is not.
        return c.json({ error: message, paymentId: payment.id }, 502);
      }

      const [sent] = await db
        .update(schema.bankPayments)
        .set({
          status: result.status,
          providerReference: result.reference,
          expectedAt: result.expectedAt,
          updatedAt: new Date(),
        })
        .where(eq(schema.bankPayments.id, payment.id))
        .returning();

      await postPayment(sent ?? payment, result.status);

      return c.json({ payment: sent ?? payment }, 201);
    },
  );

  /**
   * Setting one up to repeat.
   *
   * Only where the provider schedules them itself. A product that pretended to
   * by running its own timer would be a business's rent depending on our
   * server being awake.
   */
  ctx.app.post(
    "/api/bank-payments/recurring",
    requireSession(),
    requirePermission({ payments: ["send"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const body = (await c.req.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;

      const prepared = await prepare(orgId, body);
      if ("error" in prepared) {
        return c.json({ error: prepared.error }, prepared.status);
      }
      if (!prepared.provider.payRepeatedly) {
        return c.json(
          {
            error: `${prepared.provider.capabilities().name} cannot schedule repeating payments`,
          },
          409,
        );
      }

      const every = String(body.every ?? "");
      if (!["week", "month", "quarter", "year"].includes(every)) {
        return c.json({ error: "weekly, monthly, quarterly or yearly" }, 400);
      }
      const startsOn = new Date(String(body.startsOn ?? ""));
      if (Number.isNaN(startsOn.getTime())) {
        return c.json({ error: "when it should start" }, 400);
      }
      const endsOn = body.endsOn ? new Date(String(body.endsOn)) : null;
      if (endsOn && Number.isNaN(endsOn.getTime())) {
        return c.json({ error: "that is not a date" }, 400);
      }
      if (endsOn && endsOn <= startsOn) {
        return c.json({ error: "it would end before it began" }, 400);
      }

      const result = await prepared.provider.payRepeatedly(
        prepared.credentials,
        secrets.open(prepared.connection.accessToken),
        {
          fromAccountReference: prepared.fromAccountReference,
          amountCents: prepared.amountCents,
          currency: prepared.currency,
          description: prepared.description,
          payee: prepared.payeeDetails,
          schedule: { every, startsOn, endsOn },
        },
      );

      const [schedule] = await db
        .insert(schema.bankPaymentSchedules)
        .values({
          organizationId: orgId,
          payeeId: prepared.payee.id,
          connectionId: prepared.connection.id,
          fromAccountReference: prepared.fromAccountReference,
          fromLedgerAccountId: prepared.fromLedgerAccountId,
          amountCents: prepared.amountCents,
          currency: prepared.currency,
          description: prepared.description,
          every,
          startsOn,
          endsOn,
          providerReference: result.reference,
          createdBy: c.get("session").user.id,
        })
        .returning();

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "payment.scheduled",
        detail: {
          payee: prepared.payee.name,
          amountCents: prepared.amountCents,
          every,
        },
      });

      return c.json({ schedule }, 201);
    },
  );

  ctx.app.post(
    "/api/bank-payments/recurring/:id/stop",
    requireSession(),
    requirePermission({ payments: ["send"] }),
    proOnly,
    async (c: RouteContext) => {
      const orgId = activeOrganizationId(c.get("session"));
      const [stopped] = await db
        .update(schema.bankPaymentSchedules)
        .set({ active: false })
        .where(
          and(
            eq(schema.bankPaymentSchedules.id, c.req.param("id") ?? ""),
            eq(schema.bankPaymentSchedules.organizationId, orgId),
          ),
        )
        .returning();
      if (!stopped) return c.json({ error: "not found" }, 404);

      await record({
        organizationId: orgId,
        actor: c.get("session").user,
        action: "payment.scheduled",
        detail: { stopped: true, amountCents: stopped.amountCents },
      });

      /**
       * Said plainly rather than claimed.
       *
       * The arrangement lives at the bank. Marking it stopped here is this
       * instance's record; whether the bank has stopped it is between the
       * business and the bank, and pretending otherwise would have somebody
       * discover a payment they thought they had cancelled.
       */
      return c.json({
        ok: true,
        note: "Stopped here. Check with your bank that the standing instruction is cancelled too.",
      });
    },
  );
}

interface Prepared {
  provider: banking.BankProvider;
  credentials: banking.BankCredentials;
  connection: typeof schema.bankConnections.$inferSelect;
  payee: typeof schema.payees.$inferSelect;
  payeeDetails: banking.PaymentRequest["payee"];
  fromAccountReference: string;
  fromLedgerAccountId: string | null;
  amountCents: number;
  currency: string;
  description: string;
  billId: string | null;
}

/**
 * Everything a payment needs, checked before any of it is used.
 *
 * One function for the single payment and the repeating one, because the two
 * differ only in what the provider is asked to do — and two copies of these
 * checks is one copy that eventually lets something through.
 */
async function prepare(
  organizationId: string,
  body: Record<string, unknown>,
): Promise<Prepared | { error: string; status: 400 | 404 | 409 }> {
  const amountCents = body.amountCents;
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents <= 0
  ) {
    return { error: "how much, in whole pennies", status: 400 };
  }

  const [payee] = await db
    .select()
    .from(schema.payees)
    .where(
      and(
        eq(schema.payees.id, String(body.payeeId ?? "")),
        eq(schema.payees.organizationId, organizationId),
        isNull(schema.payees.archivedAt),
      ),
    )
    .limit(1);
  if (!payee) return { error: "who is being paid", status: 404 };

  const [connection] = await db
    .select()
    .from(schema.bankConnections)
    .where(
      and(
        eq(schema.bankConnections.id, String(body.connectionId ?? "")),
        eq(schema.bankConnections.organizationId, organizationId),
      ),
    )
    .limit(1);
  if (!connection) return { error: "which bank it comes from", status: 404 };

  const provider = banking.bankProvider(connection.provider);
  const credentials = await credentialsFor(organizationId, connection.provider);
  if (!provider || !credentials) {
    return { error: "the details for that bank are missing", status: 409 };
  }
  if (!provider.capabilities().payments) {
    // A provider that only reads is offered no button; this is the other half
    // of that, for anything reaching the route another way.
    return {
      error: `${provider.capabilities().name} can read your bank but cannot pay from it`,
      status: 409,
    };
  }

  const fromAccountReference = String(body.fromAccountReference ?? "");
  if (!fromAccountReference) {
    return { error: "which account it leaves", status: 400 };
  }

  const fromLedgerAccountId = body.fromLedgerAccountId
    ? String(body.fromLedgerAccountId)
    : null;
  if (
    fromLedgerAccountId &&
    !(await ownedAccount(organizationId, fromLedgerAccountId))
  ) {
    return { error: "that is not an account of yours", status: 404 };
  }

  let billId: string | null = null;
  if (body.billId) {
    const [bill] = await db
      .select()
      .from(schema.bills)
      .where(
        and(
          eq(schema.bills.id, String(body.billId)),
          eq(schema.bills.organizationId, organizationId),
        ),
      )
      .limit(1);
    if (!bill) return { error: "that bill is not yours", status: 404 };
    billId = bill.id;
  }

  return {
    provider,
    credentials,
    connection,
    payee,
    payeeDetails: {
      name: payee.name,
      // Opened at the last possible moment and never held anywhere else.
      accountNumber: secrets.open(payee.accountNumber),
      routingNumber: secrets.open(payee.routingNumber),
      kind: payee.kind === "personal" ? "personal" : "business",
    },
    fromAccountReference,
    fromLedgerAccountId,
    amountCents,
    currency: String(body.currency ?? "USD").slice(0, 3),
    description: String(body.description ?? "Payment").slice(0, 120),
    billId,
  };
}

/**
 * The books follow the money.
 *
 * Posted only once the provider has accepted, and only once — a payment
 * recorded that the bank refused is books that disagree with the statement for
 * ever, and one recorded twice is a bank balance that goes wrong quietly.
 */
async function postPayment(
  payment: typeof schema.bankPayments.$inferSelect,
  status: string,
): Promise<void> {
  if (status === "failed" || status === "cancelled") return;
  if (payment.entryId) return;
  if (!payment.fromLedgerAccountId) return;

  const other = payment.billId
    ? await ensureAccount(payment.organizationId, {
        code: "2000",
        name: "Accounts Payable",
        type: "liability",
      })
    : await ensureAccount(payment.organizationId, {
        code: "6000",
        name: "General Expenses",
        type: "expense",
      });

  const entry = await postJournalEntry(
    payment.organizationId,
    `Paid ${payment.description ?? "a supplier"}`,
    `bank-payment:${payment.id}`,
    [
      { accountId: other, debitCents: payment.amountCents },
      {
        accountId: payment.fromLedgerAccountId,
        creditCents: payment.amountCents,
      },
    ],
  );

  await db
    .update(schema.bankPayments)
    .set({ entryId: entry.id })
    .where(
      and(
        eq(schema.bankPayments.id, payment.id),
        // Only while it has none, so two runs cannot post two entries.
        isNull(schema.bankPayments.entryId),
      ),
    );
}

/**
 * Payments that were accepted and never reached the books.
 *
 * Nothing here re-sends anything, and nothing here asks the bank anything. It
 * finds accepted payments with no journal entry — the ones where the process
 * died between the provider saying yes and the books being written — and posts
 * them. A failed payment is skipped by the same rule that skips it everywhere
 * else, and one already posted is left alone.
 */
export async function settleOutstanding(): Promise<number> {
  /**
   * Recent payments, and `postPayment` decides which of them need anything.
   *
   * Not filtered to the ones with no entry here, deliberately: whether a
   * payment should be posted is one rule and it lives in one place. A filter
   * here that repeated it would mean breaking the rule inside `postPayment`
   * changed nothing — a guard held up by a query somewhere else is a guard
   * nobody can trust.
   *
   * Bounded by age rather than by state, because a payment older than a month
   * that never reached the books is not going to be fixed by another sweep;
   * it wants somebody looking at it.
   */
  const since = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
  const recent = await db
    .select()
    .from(schema.bankPayments)
    .where(gte(schema.bankPayments.createdAt, since));

  let posted = 0;
  for (const payment of recent) {
    // Every one of them is offered; `postPayment` is the only thing that
    // decides. Counting what it did rather than deciding again here.
    const had = payment.entryId;
    await postPayment(payment, payment.status);
    if (had) continue;
    const [after] = await db
      .select({ entryId: schema.bankPayments.entryId })
      .from(schema.bankPayments)
      .where(eq(schema.bankPayments.id, payment.id))
      .limit(1);
    if (after?.entryId) posted += 1;
  }
  return posted;
}

/**
 * The check digit every US routing number carries.
 *
 * A mistyped number is the difference between a supplier being paid and money
 * going somewhere nobody can get it back from, and this catches most single
 * mistyped digits before anything is sent. It is not a guarantee that the
 * bank exists — nothing offline is — which is why the screen also shows the
 * name and the last four before the button.
 */
export function validRouting(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  const sum =
    3 * ((d[0] ?? 0) + (d[3] ?? 0) + (d[6] ?? 0)) +
    7 * ((d[1] ?? 0) + (d[4] ?? 0) + (d[7] ?? 0)) +
    1 * ((d[2] ?? 0) + (d[5] ?? 0) + (d[8] ?? 0));
  return sum % 10 === 0;
}
