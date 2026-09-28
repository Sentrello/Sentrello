import { afterAll, beforeEach, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { documentTotals } from "@sentrello/db/money";
import { ensurePortalToken } from "@sentrello/db/portal";
import {
  allAccountSections,
  registerForTest,
  resetRateLimits,
} from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import invoicing from "./index";

/**
 * One number, told the same way everywhere a customer can see it.
 *
 * The badge on a portal row and the outstanding figure under the table are
 * the same fact stated twice, and they used to be computed twice: the badge
 * from the stored `status` column, the figure live from payments and credit
 * notes. Anything that settles an invoice without updating the column — or
 * updates it with different arithmetic, as the early-payment discount did —
 * put the two into contradiction on the one page a business cannot stand
 * behind the customer and explain.
 *
 * So these tests never look at the column. They read the page the customer
 * reads, and the customer's account summary beside it, and insist the two
 * tell one story: a settled badge means nothing outstanding, an unsettled
 * badge means a positive figure, and the account page's "You owe" is the
 * portal's figure to the cent.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(invoicing);
const orgIds: string[] = [];

afterAll(async () => {
  for (const id of orgIds) {
    const invoices = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, id));
    const ids = invoices.map((i) => i.id);
    if (ids.length > 0) {
      await db
        .delete(schema.invoiceLines)
        .where(inArray(schema.invoiceLines.invoiceId, ids));
    }
    await db
      .delete(schema.payments)
      .where(eq(schema.payments.organizationId, id));
    await db
      .delete(schema.invoices)
      .where(eq(schema.invoices.organizationId, id));
    await db
      .delete(schema.contacts)
      .where(eq(schema.contacts.organizationId, id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, id));
  }
});

beforeEach(() => {
  // Each scenario opens the portal once or twice from the same address.
  resetRateLimits();
});

async function makeCustomer(name: string) {
  const organizationId = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id: organizationId,
    name: `Agreement ${name} ${suffix}`,
    slug: `agreement-${name.toLowerCase()}-${suffix}`,
    createdAt: new Date(),
  });
  orgIds.push(organizationId);

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId, name: `${name} Customer` })
    .returning();
  if (!contact) throw new Error("contact insert failed");
  return { organizationId, contact, token: await ensurePortalToken(contact) };
}

let seq = 0;
async function makeInvoice(args: {
  organizationId: string;
  contactId: string;
  status?: string;
  dueDate?: Date | null;
  unitPrice?: number;
  earlyDiscountTakenCents?: number;
}) {
  seq += 1;
  const totals = documentTotals([
    { quantity: 1, unitPrice: args.unitPrice ?? 10_000 },
  ]);
  const [row] = await db
    .insert(schema.invoices)
    .values({
      organizationId: args.organizationId,
      contactId: args.contactId,
      number: `AGR-${suffix}-${seq}`,
      status: args.status ?? "open",
      dueDate: args.dueDate ?? null,
      subtotalCents: totals.subtotal,
      taxCents: totals.tax,
      totalCents: totals.total,
      earlyDiscountTakenCents: args.earlyDiscountTakenCents ?? 0,
    })
    .returning();
  if (!row) throw new Error("invoice insert failed");
  return row;
}

async function pay(
  organizationId: string,
  invoiceId: string,
  amountCents: number,
) {
  await db
    .insert(schema.payments)
    .values({ organizationId, invoiceId, amountCents });
}

async function creditNote(args: {
  organizationId: string;
  contactId: string;
  referenceInvoiceId: string;
  totalCents: number;
}) {
  seq += 1;
  await db.insert(schema.invoices).values({
    organizationId: args.organizationId,
    contactId: args.contactId,
    kind: "credit_note",
    referenceInvoiceId: args.referenceInvoiceId,
    number: `AGR-CN-${suffix}-${seq}`,
    status: "open",
    totalCents: args.totalCents,
  });
}

/** The badge in an invoice's row, as rendered. Null when it is not listed. */
function badgeFor(html: string, number: string): string | null {
  const row = new RegExp(
    `<td>${number}</td>\\s*<td>[^<]*</td>\\s*<td class="[^"]*">([^<]*)</td>`,
  ).exec(html);
  return row?.[1] ?? null;
}

/** What the page tells the customer they owe, in cents. */
function outstandingCents(html: string): number {
  if (/Nothing outstanding/.test(html)) return 0;
  const found = /<p class="owed">\$([\d,]+\.\d\d) outstanding<\/p>/.exec(html);
  if (!found?.[1]) throw new Error("the portal stated no outstanding figure");
  return Math.round(Number(found[1].replace(/,/g, "")) * 100);
}

/** The "You owe" figure on the unified account page, for the same customer. */
async function accountOwes(organizationId: string, contactId: string) {
  const section = allAccountSections().find((s) => s.id === "invoicing");
  if (!section) throw new Error("invoicing registered no account section");
  const figures = await section.load(organizationId, contactId);
  return figures.find((f) => f.label === "You owe")?.value ?? 0;
}

/**
 * The whole acceptance criterion, in one function.
 *
 * A settled badge and a positive balance are a contradiction in either
 * direction, and the customer's two pages disagreeing is a third. Every
 * scenario below ends here.
 */
async function assertOnePlainStory(args: {
  organizationId: string;
  contactId: string;
  token: string;
  number: string;
  expectBadge: string | null;
}) {
  const page = await app.request(`http://localhost/portal/${args.token}`);
  expect(page.status).toBe(200);
  const html = await page.text();

  const badge = badgeFor(html, args.number);
  expect(badge).toBe(args.expectBadge);

  const owed = outstandingCents(html);
  const settled = badge === "paid" || badge === "credited" || badge === null;
  if (settled) {
    expect(owed).toBe(0);
  } else {
    expect(owed).toBeGreaterThan(0);
  }

  // The same fact, on the customer's other page.
  expect(await accountOwes(args.organizationId, args.contactId)).toBe(owed);
  return { html, badge, owed };
}

test("part paid, then credited for the rest: reads paid, and owes nothing", async () => {
  const { organizationId, contact, token } = await makeCustomer("PartCredit");
  const invoice = await makeInvoice({
    organizationId,
    contactId: contact.id,
    status: "open", // never updated — the write path is not what is trusted
  });
  await pay(organizationId, invoice.id, 4_000);
  await creditNote({
    organizationId,
    contactId: contact.id,
    referenceInvoiceId: invoice.id,
    totalCents: 6_000,
  });

  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "paid",
  });
});

test("paid in full, then credited: still reads paid, and owes nothing", async () => {
  const { organizationId, contact, token } = await makeCustomer("PaidCredit");
  const invoice = await makeInvoice({ organizationId, contactId: contact.id });
  await pay(organizationId, invoice.id, 10_000);
  await creditNote({
    organizationId,
    contactId: contact.id,
    referenceInvoiceId: invoice.id,
    totalCents: 10_000,
  });

  // Credited past the total: the customer is owed money, which is never the
  // same as the customer owing a negative sum.
  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "paid",
  });
});

test("a void is never shown, and never counted", async () => {
  const { organizationId, contact, token } = await makeCustomer("Voided");
  const invoice = await makeInvoice({
    organizationId,
    contactId: contact.id,
    status: "void",
    dueDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
  });

  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: null,
  });
});

test("overdue, then paid late: reads paid rather than overdue", async () => {
  const { organizationId, contact, token } = await makeCustomer("PaidLate");
  const invoice = await makeInvoice({
    organizationId,
    contactId: contact.id,
    dueDate: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
  });

  const late = await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "overdue",
  });
  expect(late.owed).toBe(10_000);

  await pay(organizationId, invoice.id, 10_000);
  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "paid",
  });
});

test("paying early for less settles the invoice on the page, not only in the column", async () => {
  const { organizationId, contact, token } = await makeCustomer("Skonto");
  const invoice = await makeInvoice({
    organizationId,
    contactId: contact.id,
    // 2% for paying early: the saving is not a payment, it is debt given up.
    earlyDiscountTakenCents: 200,
    status: "paid",
  });
  await pay(organizationId, invoice.id, 9_800);

  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "paid",
  });
});

/**
 * The column, deliberately wrong. Both directions, because both are reachable
 * — a write path that forgot to settle the column, and one that settled it
 * for an invoice that is still owed money.
 */
test("a stored status that lies cannot contradict the total a customer is shown", async () => {
  const { organizationId, contact, token } = await makeCustomer("Drifted");

  const settled = await makeInvoice({ organizationId, contactId: contact.id });
  await pay(organizationId, settled.id, 10_000);
  // As if the payment route had died between the insert and the update.
  await db
    .update(schema.invoices)
    .set({ status: "open" })
    .where(eq(schema.invoices.id, settled.id));

  await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: settled.number,
    expectBadge: "paid",
  });

  const owing = await makeCustomer("DriftedOwing");
  const unpaid = await makeInvoice({
    organizationId: owing.organizationId,
    contactId: owing.contact.id,
    dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
    status: "paid", // nobody paid it
  });

  const story = await assertOnePlainStory({
    organizationId: owing.organizationId,
    contactId: owing.contact.id,
    token: owing.token,
    number: unpaid.number,
    expectBadge: "overdue",
  });
  expect(story.owed).toBe(10_000);
});

/**
 * The boundary the two pages used to read differently: the portal called an
 * invoice late strictly after its due moment, the account summary called it
 * late at that moment. One instant, invisible in practice, and two answers —
 * so the instant itself is pinned in `money.test.ts`, where a clock can be
 * held still. What is checkable here is that both pages now read one rule.
 */
test("not yet due reads due, not overdue — on both pages at once", async () => {
  const { organizationId, contact, token } = await makeCustomer("Boundary");
  const invoice = await makeInvoice({
    organizationId,
    contactId: contact.id,
    dueDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  });

  const { owed } = await assertOnePlainStory({
    organizationId,
    contactId: contact.id,
    token,
    number: invoice.number,
    expectBadge: "due",
  });
  expect(owed).toBe(10_000);
});
