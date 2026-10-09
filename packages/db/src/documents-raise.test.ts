import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, db, eq, schema } from "@sentrello/db";
import { dayIn } from "./day";
import { raiseInvoice } from "./documents";
import { PeriodClosedError } from "./ledger";
import { documentTotals } from "./money";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * `raiseInvoice` with the two things its callers were working around: a day
 * the document belongs to, and a line that carries more than one tax.
 *
 * A lapsed subscription's March invoice was raised today and re-dated after
 * the fact, entry and all; a Quebec subscriber's GST and QST were charged as
 * one blended rate onto the shared Tax Payable, where neither return reads it.
 */
const orgId = `docs-raise-${crypto.randomUUID().slice(0, 8)}`;
let gst = "";
let pst = "";

const DAY = 86_400_000;
const today = () => dayIn(new Date(), null);
const daysAgo = (n: number) => new Date(today().getTime() - n * DAY);
const iso = (d: Date) => d.toISOString().slice(0, 10);

async function entryOf(invoiceId: string) {
  return db
    .select({
      postedAt: schema.journalEntries.postedAt,
      code: schema.accounts.code,
      debit: schema.journalLines.debitCents,
      credit: schema.journalLines.creditCents,
    })
    .from(schema.journalLines)
    .innerJoin(
      schema.journalEntries,
      eq(schema.journalEntries.id, schema.journalLines.entryId),
    )
    .innerJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.journalLines.accountId),
    )
    .where(
      and(
        eq(schema.journalEntries.organizationId, orgId),
        eq(schema.journalEntries.source, `invoice:${invoiceId}`),
      ),
    );
}

async function invoiceCount() {
  return (
    await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, orgId))
  ).length;
}

beforeAll(async () => {
  await makeOrganization(orgId);
  const made = await db
    .insert(schema.taxDefinitions)
    .values([
      {
        organizationId: orgId,
        name: "GST",
        rateBp: 500,
        ratePpm: 50_000,
        regime: "ca",
        jurisdiction: "CA",
      },
      {
        organizationId: orgId,
        name: "PST BC",
        rateBp: 700,
        ratePpm: 70_000,
        regime: "ca",
        jurisdiction: "CA-BC",
      },
    ])
    .returning();
  gst = made[0]?.id ?? "";
  pst = made[1]?.id ?? "";
});

afterAll(async () => {
  await dropOrganization(orgId);
});

const plain = {
  description: "Membership",
  quantity: 1,
  unitPriceCents: 1000,
};

test("an issue date dates the invoice, its entry, its due date", async () => {
  const day = daysAgo(20);
  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    issueDate: iso(day),
    lines: [plain],
  });
  if (!invoice) throw new Error("no invoice");
  expect(invoice.issueDate.toISOString()).toBe(day.toISOString());
  // The default terms (thirty days) counted from the issue date, not today.
  expect(invoice.dueDate?.toISOString()).toBe(
    new Date(day.getTime() + 30 * DAY).toISOString(),
  );
  const entry = await entryOf(invoice.id);
  expect(entry.length).toBeGreaterThan(0);
  for (const line of entry) {
    expect(line.postedAt.toISOString()).toBe(day.toISOString());
  }
});

test("an explicit due date wins over the terms", async () => {
  const due = daysAgo(2);
  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    issueDate: daysAgo(5),
    dueDate: due,
    lines: [plain],
  });
  expect(invoice?.dueDate?.toISOString()).toBe(due.toISOString());
});

test("a future issue date is refused", async () => {
  await expect(
    raiseInvoice(orgId, {
      contactId: null,
      issueDate: iso(new Date(today().getTime() + 2 * DAY)),
      lines: [plain],
    }),
  ).rejects.toThrow("in the future");
});

test("a day in a closed period is refused, and nothing is written", async () => {
  const closed = daysAgo(10);
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, closedThrough: closed })
    .onConflictDoUpdate({
      target: schema.ledgerSettings.organizationId,
      set: { closedThrough: closed },
    });
  try {
    const before = await invoiceCount();
    await expect(
      raiseInvoice(orgId, {
        contactId: null,
        issueDate: daysAgo(12),
        lines: [plain],
      }),
    ).rejects.toBeInstanceOf(PeriodClosedError);
    // The last closed day itself is closed too.
    await expect(
      raiseInvoice(orgId, {
        contactId: null,
        issueDate: closed,
        lines: [plain],
      }),
    ).rejects.toBeInstanceOf(PeriodClosedError);
    expect(await invoiceCount()).toBe(before);

    // The day after is open.
    const open = await raiseInvoice(orgId, {
      contactId: null,
      issueDate: daysAgo(9),
      lines: [plain],
    });
    expect(open?.issueDate.toISOString()).toBe(daysAgo(9).toISOString());
  } finally {
    await db
      .update(schema.ledgerSettings)
      .set({ closedThrough: null })
      .where(eq(schema.ledgerSettings.organizationId, orgId));
  }
});

test("a two-tax line posts each tax to its own account, balanced, at the screen's rounding", async () => {
  const line = {
    description: "Coaching, BC",
    quantity: 3,
    unitPriceCents: 1999,
    taxes: [{ taxDefinitionId: gst }, { taxDefinitionId: pst }],
  };
  const invoice = await raiseInvoice(orgId, { contactId: null, lines: [line] });
  if (!invoice) throw new Error("no invoice");

  // The invoice screen's arithmetic for the same line: per-line, per-tax.
  const screen = documentTotals([
    {
      quantity: 3,
      unitPrice: 1999,
      taxes: [
        { taxDefinitionId: gst, name: "GST", ratePpm: 50_000 },
        { taxDefinitionId: pst, name: "PST BC", ratePpm: 70_000 },
      ],
    },
  ]);
  expect(invoice.subtotalCents).toBe(screen.subtotal);
  expect(invoice.taxCents).toBe(screen.tax);
  expect(invoice.totalCents).toBe(screen.total);
  // 5997 × 5% = 299.85 → 300; × 7% = 419.79 → 420.
  expect(invoice.taxCents).toBe(720);

  const [stored] = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(stored?.taxes?.map((t) => [t.taxDefinitionId, t.ratePpm])).toEqual([
    [gst, 50_000],
    [pst, 70_000],
  ]);
  // The first tax in the single-tax columns, for anything still reading them.
  expect(stored?.taxDefinitionId).toBe(gst);
  expect(stored?.taxRatePpm).toBe(50_000);

  const entry = await entryOf(invoice.id);
  const debits = entry.reduce((n, l) => n + l.debit, 0);
  const credits = entry.reduce((n, l) => n + l.credit, 0);
  expect(debits).toBe(credits);
  expect(debits).toBe(invoice.totalCents);
  const taxLines = entry
    .filter((l) => l.code.startsWith("2200"))
    .map((l) => [l.code, l.credit])
    .sort();
  expect(taxLines).toEqual(
    [
      [`2200-${gst.slice(0, 8)}`, 300],
      [`2200-${pst.slice(0, 8)}`, 420],
    ].sort(),
  );
});

test("a line naming the same tax twice is refused", async () => {
  await expect(
    raiseInvoice(orgId, {
      contactId: null,
      lines: [
        {
          ...plain,
          taxes: [{ taxDefinitionId: gst }, { taxDefinitionId: gst }],
        },
      ],
    }),
  ).rejects.toThrow("the same tax is on the line twice");
});

test("an old single-tax caller is unchanged", async () => {
  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: [{ ...plain, taxRatePpm: 50_000, taxDefinitionId: gst }],
  });
  if (!invoice) throw new Error("no invoice");
  expect(invoice.taxCents).toBe(50);
  expect(invoice.issueDate.toISOString()).toBe(today().toISOString());
  const [stored] = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.invoiceId, invoice.id));
  expect(stored?.taxes).toBeNull();
  expect(stored?.taxDefinitionId).toBe(gst);
  expect(stored?.taxRatePpm).toBe(50_000);
  const tax = (await entryOf(invoice.id)).filter((l) =>
    l.code.startsWith("2200-"),
  );
  expect(tax.map((l) => l.credit)).toEqual([50]);
});
