import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import { readInsights } from "./pro";

/**
 * The charts are added up by the database now, not in the process. These are
 * the figures that arithmetic has to keep: a credit note subtracting from its
 * customer, invoices raised against nobody as their own row, drafts and voids
 * left out, and a month's income and expense from the ledger.
 */
const orgId = `insights-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await makeOrganization(orgId);
  const [ada, bob] = await db
    .insert(schema.contacts)
    .values([
      { organizationId: orgId, name: "Ada", firstName: "Ada", lastName: "L" },
      { organizationId: orgId, name: "Bob", firstName: "Bob" },
    ])
    .returning();
  if (!ada || !bob) throw new Error("no contacts");
  const invoice = (
    number: string,
    totalCents: number,
    contactId: string | null,
    extra: Partial<typeof schema.invoices.$inferInsert> = {},
  ) => ({
    organizationId: orgId,
    number,
    status: "sent",
    currency: "USD",
    issueDate: new Date(),
    subtotalCents: totalCents,
    taxCents: 0,
    totalCents,
    contactId,
    ...extra,
  });
  const [adas] = await db
    .insert(schema.invoices)
    .values(invoice("I-1", 10_000, ada.id))
    .returning();
  await db.insert(schema.invoices).values([
    invoice("CN-1", 4_000, ada.id, {
      kind: "credit_note",
      referenceInvoiceId: adas?.id,
    }),
    invoice("I-2", 5_000, bob.id),
    invoice("I-3", 99_000, bob.id, { status: "draft" }),
    invoice("I-4", 99_000, bob.id, { status: "void" }),
    invoice("I-5", 2_000, null),
  ]);

  const [income, expense] = await db
    .insert(schema.accounts)
    .values([
      { organizationId: orgId, code: "4000", name: "Sales", type: "income" },
      { organizationId: orgId, code: "5000", name: "Costs", type: "expense" },
    ])
    .returning();
  const [entry] = await db
    .insert(schema.journalEntries)
    .values({ organizationId: orgId })
    .returning();
  if (!income || !expense || !entry) throw new Error("no ledger");
  await db.insert(schema.journalLines).values([
    { entryId: entry.id, accountId: income.id, creditCents: 7_000 },
    { entryId: entry.id, accountId: expense.id, debitCents: 2_500 },
    { entryId: entry.id, accountId: income.id, debitCents: 500 },
  ]);
});

afterAll(() => dropOrganization(orgId));

test("top customers are billed less credited, keyed by the record", async () => {
  const { topCustomers } = await readInsights(orgId);
  expect(topCustomers).toEqual([
    { contactId: expect.any(String), name: "Ada L", cents: 6_000 },
    { contactId: expect.any(String), name: "Bob", cents: 5_000 },
    { contactId: null, name: "No customer", cents: 2_000 },
  ]);
});

test("this month's income and expense come from the ledger", async () => {
  const { months } = await readInsights(orgId);
  expect(months).toHaveLength(12);
  expect(months.at(-1)).toMatchObject({
    incomeCents: 6_500,
    expenseCents: 2_500,
    netCents: 4_000,
  });
});
