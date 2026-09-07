import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, desc, eq, inArray, schema } from "@sentrello/db";
import { runRecurringInvoices } from "./recurring";

/**
 * The recurring job issues invoices nobody is watching.
 *
 * It runs unattended, creates money documents and posts to the ledger, and had
 * no tests at all. Two things it got wrong were only visible from outside: the
 * invoices carried no due date, so overdue chasing — which skips invoices
 * without one — never saw them; and one unusable template threw, taking every
 * other business's invoices for that day down with it.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `rec-${suffix}`;
let contactId: string;

beforeAll(async () => {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Recurring ${suffix}`,
    slug: `recurring-${suffix}`,
    createdAt: new Date(),
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Monthly Client", kind: "customer" })
    .returning();
  if (!contact) throw new Error("could not create the test contact");
  contactId = contact.id;
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, ids));
  }
  await db
    .delete(schema.billableItems)
    .where(eq(schema.billableItems.organizationId, orgId));
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.invoiceLines, null],
    [schema.invoices, schema.invoices.organizationId],
    [schema.accounts, schema.accounts.organizationId],
    [schema.recurringProfiles, schema.recurringProfiles.organizationId],
    [schema.documentTaxes, schema.documentTaxes.organizationId],
    [schema.documentCounters, schema.documentCounters.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    if (!column) continue;
    await db.delete(table).where(eq(column, orgId));
  }
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

const yesterday = () => new Date(Date.now() - 86_400_000);

test("a due profile issues an invoice that can actually be chased", async () => {
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId,
    interval: "monthly",
    nextRunAt: yesterday(),
    templateJson: {
      lines: [
        {
          description: "Maintenance retainer",
          quantity: 1,
          unitPrice: 45000,
          taxRateBp: 875,
        },
      ],
    },
  });

  const result = await runRecurringInvoices();
  expect(result.issued).toBeGreaterThanOrEqual(1);

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  expect(invoice?.totalCents).toBe(48938); // 45000 + 8.75%, rounded
  // The whole point: overdue chasing filters on `dueDate is not null`.
  const dueDate = invoice?.dueDate;
  if (!dueDate) throw new Error("a recurring invoice must carry a due date");
  expect(dueDate.getTime()).toBeGreaterThan(Date.now());

  const lines = await db
    .select()
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalLines.entryId, schema.journalEntries.id),
    )
    .where(eq(schema.journalEntries.organizationId, orgId));
  const debits = lines.reduce((s, l) => s + l.journal_lines.debitCents, 0);
  const credits = lines.reduce((s, l) => s + l.journal_lines.creditCents, 0);
  expect(debits).toBe(48938);
  expect(credits).toBe(48938);
});

test("the schedule moves on, so the same invoice is not issued twice", async () => {
  const before = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));

  const again = await runRecurringInvoices();
  expect(again.issued).toBe(0);

  const after = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

test("one unusable template does not stop the rest of the run", async () => {
  // A template whose field names are wrong — the mistake that used to reach
  // Postgres as NaN. It must cost its own profile only.
  await db.insert(schema.recurringProfiles).values([
    {
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      templateJson: {
        lines: [{ description: "Broken", quantity: 1, unitPriceCents: 1000 }],
      },
    },
    {
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      templateJson: {
        lines: [
          {
            description: "Perfectly fine",
            quantity: 1,
            unitPrice: 10000,
            taxRateBp: 0,
          },
        ],
      },
    },
  ]);

  const result = await runRecurringInvoices();
  expect(result.issued).toBe(1);
  expect(result.skipped).toHaveLength(1);
  expect(result.skipped[0]?.reason).toContain("unitPrice");

  // And the good one is a real invoice, not a partial write.
  const invoices = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(invoices.some((i) => i.totalCents === 10000)).toBe(true);
});

test("a template invoice is copied whole, lines and all", async () => {
  // The good shape: a real draft somebody can open and correct, rather than a
  // blob of JSON that only the job can read.
  const [template] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      contactId,
      number: "TPL-0001",
      status: "draft",
      subtotalCents: 20_000,
      taxCents: 0,
      totalCents: 20_000,
      notes: "Billed monthly in advance",
    })
    .returning();
  await db.insert(schema.invoiceLines).values({
    invoiceId: template?.id ?? "",
    description: "Retainer, 7.5 hours",
    quantityMilli: 7_500,
    unit: "hour",
    unitPriceCents: 2_667,
    taxRateBp: 0,
  });

  const [profile] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: orgId,
      contactId,
      interval: "weekly",
      intervalCount: 2,
      nextRunAt: yesterday(),
      templateInvoiceId: template?.id,
    })
    .returning();

  const before = new Date();
  const result = await runRecurringInvoices();
  expect(result.issued).toBeGreaterThanOrEqual(1);

  const [raised] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.contactId, contactId))
    .orderBy(desc(schema.invoices.createdAt))
    .limit(1);
  expect(raised?.status).toBe("open");
  expect(raised?.totalCents).toBe(20_000);
  expect(raised?.notes).toBe("Billed monthly in advance");
  expect(raised?.number).not.toBe("TPL-0001");

  // The fractional quantity and the unit travel: without them "7.5 hours"
  // reaches the customer as "7 pieces".
  const [line] = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, raised?.id ?? ""));
  expect(line?.quantityMilli).toBe(7_500);
  expect(line?.unit).toBe("hour");

  // Fortnightly is one schedule, not two runs a month apart.
  const [after] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, profile?.id ?? ""));
  const moved = (after?.nextRunAt.getTime() ?? 0) - yesterday().getTime();
  expect(Math.round(moved / 86_400_000)).toBe(14);
  expect(after?.generatedCount).toBe(1);
  expect(after?.lastGeneratedAt?.getTime()).toBeGreaterThanOrEqual(
    before.getTime() - 1000,
  );
});

test("a schedule with an end date bills its last period and then stops", async () => {
  const [profile] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      // The next run after this one lands past the end, so this is the last.
      endsOn: new Date(Date.now() + 7 * 86_400_000),
      templateJson: {
        lines: [
          {
            description: "Final month",
            quantity: 1,
            unitPrice: 5_000,
            taxRateBp: 0,
          },
        ],
      },
    })
    .returning();

  const result = await runRecurringInvoices();
  expect(result.issued).toBeGreaterThanOrEqual(1);

  const [after] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, profile?.id ?? ""));
  // Billed, then closed — not left to raise a month the customer never agreed to.
  expect(after?.generatedCount).toBe(1);
  expect(after?.active).toBe(false);
});

test("a profile already past its end date bills nothing at all", async () => {
  const [profile] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: orgId,
      contactId,
      interval: "monthly",
      nextRunAt: yesterday(),
      endsOn: new Date(Date.now() - 90 * 86_400_000),
      templateJson: {
        lines: [
          {
            description: "Should never be raised",
            quantity: 1,
            unitPrice: 123_456,
            taxRateBp: 0,
          },
        ],
      },
    })
    .returning();

  await runRecurringInvoices();

  const raised = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  expect(raised.some((i) => i.totalCents === 123_456)).toBe(false);

  const [after] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, profile?.id ?? ""));
  expect(after?.active).toBe(false);
});

test("an auto-send profile still raises the invoice when no mail is set up", async () => {
  // Delivery is the last step, never the gate. A business that has not
  // configured mail must still have the invoice raised, in the books and
  // chaseable — otherwise the missing setting quietly means unbilled work.
  await db
    .update(schema.contacts)
    .set({ email: "ap@monthly.test" })
    .where(eq(schema.contacts.id, contactId));

  const outbox: { to: string }[] = [];
  await db.insert(schema.recurringProfiles).values({
    organizationId: orgId,
    contactId,
    interval: "monthly",
    nextRunAt: yesterday(),
    autoSend: true,
    templateJson: {
      lines: [
        {
          description: "Sent by itself",
          quantity: 1,
          unitPrice: 7_777,
          taxRateBp: 0,
        },
      ],
    },
  });

  const result = await runRecurringInvoices(new Date(), {
    mailer: {
      send: async (m) => {
        outbox.push({ to: m.to });
      },
    },
  });
  expect(result.issued).toBeGreaterThanOrEqual(1);

  const [raised] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.totalCents, 7_777));
  expect(raised?.status).toBe("open");
  // Whatever the mail did, the money is asked for.
  expect(raised?.dueDate).toBeTruthy();
  expect(result.sent).toBe(outbox.length);
});

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** A plan in the catalogue, and somebody subscribed to it. */
async function subscribe(overrides: Record<string, unknown> = {}) {
  const [plan] = await db
    .insert(schema.billableItems)
    .values({
      organizationId: orgId,
      name: "Support, monthly",
      unitPriceCents: 5_000,
      unit: "subscription",
      billingInterval: "monthly",
    })
    .returning();
  const [subscription] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: orgId,
      kind: "subscription",
      contactId,
      planItemId: plan?.id,
      name: plan?.name,
      quantity: 1,
      unitPriceCents: 5_000,
      interval: "monthly",
      intervalCount: 1,
      nextRunAt: new Date("2026-03-01"),
      status: "active",
      ...overrides,
    })
    .returning();
  if (!subscription) throw new Error("could not create the subscription");
  return subscription;
}

test("a subscription bills its plan without a template invoice", async () => {
  const subscription = await subscribe();

  const result = await runRecurringInvoices(new Date("2026-03-02"));
  expect(result.issued).toBeGreaterThan(0);

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId))
    .orderBy(desc(schema.invoices.issueDate))
    .limit(1);
  expect(invoice?.totalCents).toBe(5_000);

  const lines = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice?.id as string));
  expect(lines).toHaveLength(1);
  expect(lines[0]?.description).toBe("Support, monthly");

  const [after] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(after?.nextRunAt.toISOString().slice(0, 10)).toBe("2026-04-01");
  expect(after?.generatedCount).toBe(1);
});

/**
 * The price is the customer's, not the plan's.
 *
 * A business that raises its prices has not raised them for the people who
 * signed up last year, and a plan edited on a Tuesday must not rebill
 * everybody on Wednesday.
 */
test("a plan's new price does not reach an existing subscriber", async () => {
  const subscription = await subscribe({
    nextRunAt: new Date("2026-05-01"),
    unitPriceCents: 4_000,
  });
  await db
    .update(schema.billableItems)
    .set({ unitPriceCents: 9_900 })
    .where(eq(schema.billableItems.id, subscription.planItemId as string));

  await runRecurringInvoices(new Date("2026-05-02"));

  const [invoice] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId))
    .orderBy(desc(schema.invoices.issueDate))
    .limit(1);
  expect(invoice?.totalCents).toBe(4_000);
});

test("a paused subscription bills nothing and keeps its date", async () => {
  const subscription = await subscribe({
    nextRunAt: new Date("2026-06-01"),
    status: "paused",
  });
  // Counted on the subscription rather than on the organization's invoices:
  // other profiles in this suite are due on the same day, and their invoices
  // are not this test's business.
  await runRecurringInvoices(new Date("2026-06-02"));

  const [unchanged] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(unchanged?.nextRunAt.toISOString().slice(0, 10)).toBe("2026-06-01");
  expect(unchanged?.generatedCount).toBe(0);
});

test("a trial bills nothing until it ends", async () => {
  /**
   * Due, and still in its trial.
   *
   * The date has passed — so the run picks the subscription up — and the trial
   * has not, which is the only arrangement that tests the guard rather than
   * the scheduler.
   */
  const subscription = await subscribe({
    nextRunAt: new Date("2026-07-10"),
    status: "trialing",
    trialEndsAt: new Date("2026-07-20"),
  });

  // inside the trial, with the run date past: still nothing
  await runRecurringInvoices(new Date("2026-07-15"));
  const [still] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(still?.generatedCount).toBe(0);
  expect(still?.status).toBe("trialing");

  // once the trial is over: the first invoice, and it is no longer a trial
  await runRecurringInvoices(new Date("2026-07-21"));
  const [billing] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(billing?.generatedCount).toBe(1);
  expect(billing?.status).toBe("active");
});

/**
 * Cancelling keeps the period already paid for.
 *
 * The customer bought this month; they keep it. What must not happen is one
 * more invoice for the month after — which is what a cancellation that only
 * set a flag would have allowed.
 */
test("a cancellation set for the period end bills no further", async () => {
  const subscription = await subscribe({
    nextRunAt: new Date("2026-08-01"),
    cancelAt: new Date("2026-08-01"),
    cancelledAt: new Date("2026-07-20"),
  });

  await runRecurringInvoices(new Date("2026-08-02"));

  const [ended] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(ended?.status).toBe("cancelled");
  expect(ended?.active).toBe(false);
  // nothing was raised for the period after the one already paid for
  expect(ended?.generatedCount).toBe(0);
});

test("a subscription whose plan was deleted is skipped, not fatal", async () => {
  const subscription = await subscribe({ nextRunAt: new Date("2026-09-01") });
  await db
    .delete(schema.billableItems)
    .where(eq(schema.billableItems.id, subscription.planItemId as string));

  const result = await runRecurringInvoices(new Date("2026-09-02"));
  expect(result.skipped.some((s) => s.profileId === subscription.id)).toBe(
    true,
  );

  // and it is left alone, so it works again once somebody fixes it
  const [untouched] = await db
    .select()
    .from(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, subscription.id));
  expect(untouched?.nextRunAt.toISOString().slice(0, 10)).toBe("2026-09-01");
});

/**
 * A subscription billed in another currency reaches the books converted.
 *
 * The invoice route was fixed for this in the morning; this job was not, and
 * it is the one that runs unattended every night. It credited income with the
 * subtotal — which does not balance once a discount is taken off the total —
 * and posted face value whatever currency the profile billed in, so a monthly
 * plan in euros put euro cents into dollar books. Every month. Quietly.
 */
test("a foreign subscription posts at its rate, and the entry balances", async () => {
  const { db, schema } = await import("@sentrello/db");
  const { eq, inArray } = await import("drizzle-orm");

  // 1 EUR = 1.25 of the books' currency, recorded yesterday.
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "EUR",
    rateMicro: 1_250_000,
    asOf: yesterday,
  });

  const [plan] = await db
    .insert(schema.billableItems)
    .values({
      organizationId: orgId,
      name: `Euro plan ${crypto.randomUUID().slice(0, 6)}`,
      unitPriceCents: 20_000,
      unit: "subscription",
      billingInterval: "monthly",
    })
    .returning();
  if (!plan) throw new Error("could not create the plan");

  const due = new Date();
  due.setDate(due.getDate() - 1);
  const [profile] = await db
    .insert(schema.recurringProfiles)
    .values({
      organizationId: orgId,
      kind: "subscription",
      contactId,
      name: plan.name,
      planItemId: plan.id,
      quantity: 1,
      unitPriceCents: 20_000,
      taxRateBp: 0,
      currency: "EUR",
      interval: "monthly",
      intervalCount: 1,
      nextRunAt: due,
      status: "active",
      startedAt: due,
    })
    .returning();
  if (!profile) throw new Error("could not create the subscription");

  await runRecurringInvoices();

  const [raised] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.contactId, contactId))
    .orderBy(schema.invoices.createdAt);
  const mine = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  const euro = mine.find((i) => i.currency === "EUR");
  expect(euro).toBeTruthy();
  // The document says what the customer owes, in their currency.
  expect(euro?.totalCents).toBe(20_000);
  expect(euro?.rateMicro).toBe(1_250_000);

  // The ledger says what it is worth here: 200.00 EUR at 1.25 = 250.00.
  const lines = await db
    .select({
      debitCents: schema.journalLines.debitCents,
      creditCents: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .where(eq(schema.journalEntries.source, `invoice:${euro?.id}`));
  const debits = lines.reduce((sum, l) => sum + l.debitCents, 0);
  const credits = lines.reduce((sum, l) => sum + l.creditCents, 0);
  expect(debits).toBe(25_000);
  // And it balances, which is the thing that must never stop being true.
  expect(credits).toBe(debits);

  /**
   * Everything this test made, removed.
   *
   * Other tests in this file ask for "the most recent invoice on the
   * organization", and an invoice left here dated today wins that query for
   * every one of them — which is exactly how this test broke a passing
   * assertion about a subscriber's agreed price the first time it ran.
   */
  await db.delete(schema.journalLines).where(
    inArray(
      schema.journalLines.entryId,
      db
        .select({ id: schema.journalEntries.id })
        .from(schema.journalEntries)
        .where(eq(schema.journalEntries.source, `invoice:${euro?.id}`)),
    ),
  );
  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.source, `invoice:${euro?.id}`));
  await db
    .delete(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, euro?.id as string));
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.id, euro?.id as string));
  await db
    .delete(schema.recurringProfiles)
    .where(eq(schema.recurringProfiles.id, profile.id));
  await db
    .delete(schema.billableItems)
    .where(eq(schema.billableItems.id, plan.id));
  await db
    .delete(schema.exchangeRates)
    .where(eq(schema.exchangeRates.organizationId, orgId));
  void raised;
});
