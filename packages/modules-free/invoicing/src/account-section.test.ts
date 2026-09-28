import { afterAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { documentTotals } from "@sentrello/db/money";
import { ensurePortalToken } from "@sentrello/db/portal";
import { allAccountSections, registerForTest } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import {
  customerBalance,
  invoicingAccountFigures,
  invoicingHasAccountActivity,
} from "./account-section";
import invoicing from "./index";

/**
 * Invoicing's section of the unified customer account page.
 *
 * The gate order itself — entitlement, then `hasAny`, then `load` — is the
 * host's contract and is tested generically in `modules-free/account`. What
 * belongs here is invoicing's own answer: which invoices count, whether the
 * figures agree with what `documentTotals` actually charged, and that the
 * vocabulary a customer reads here matches the one on their bill.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const orgIds: string[] = [];

afterAll(async () => {
  for (const id of orgIds) {
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

async function makeOrg(name: string) {
  const id = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${suffix}`,
    createdAt: new Date(),
  });
  orgIds.push(id);
  return id;
}

async function makeContact(organizationId: string, name: string) {
  const [row] = await db
    .insert(schema.contacts)
    .values({ organizationId, name })
    .returning();
  if (!row) throw new Error("contact insert failed");
  return row;
}

let seq = 0;
/** A real invoice row, its total taken straight from `documentTotals`. */
async function makeInvoice(args: {
  organizationId: string;
  contactId: string;
  status?: string;
  dueDate?: Date;
  lines?: { quantity: number; unitPrice: number; taxRatePpm?: number }[];
}) {
  seq += 1;
  const lines = args.lines ?? [{ quantity: 1, unitPrice: 10_000 }];
  const totals = documentTotals(lines);
  const [row] = await db
    .insert(schema.invoices)
    .values({
      organizationId: args.organizationId,
      contactId: args.contactId,
      number: `ACC-${suffix}-${seq}`,
      status: args.status ?? "open",
      dueDate: args.dueDate,
      subtotalCents: totals.subtotal,
      taxCents: totals.tax,
      totalCents: totals.total,
    })
    .returning();
  if (!row) throw new Error("invoice insert failed");
  return { ...row, totals };
}

async function makeCreditNote(args: {
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
    number: `CN-${suffix}-${seq}`,
    status: "open",
    totalCents: args.totalCents,
  });
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

test("a customer who was sent an invoice has account activity; one who wasn't does not", async () => {
  const orgId = await makeOrg(`Barker ${suffix}`);
  const billed = await makeContact(orgId, "Billed Customer");
  const untouched = await makeContact(orgId, "Untouched Customer");

  await makeInvoice({ organizationId: orgId, contactId: billed.id });

  expect(await invoicingHasAccountActivity(orgId, billed.id)).toBe(true);
  expect(await invoicingHasAccountActivity(orgId, untouched.id)).toBe(false);
});

test("a draft or a void is never offered as payable, and never counted", async () => {
  const orgId = await makeOrg(`Drafty ${suffix}`);
  const contact = await makeContact(orgId, "Only Drafts");

  await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
    status: "draft",
  });
  await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
    status: "void",
  });

  // Neither a business thinking out loud nor a document taken back is a bill
  // this customer was sent — the section does not exist for them.
  expect(await invoicingHasAccountActivity(orgId, contact.id)).toBe(false);

  // A real invoice alongside them must not have its balance inflated by the
  // two that were never sent.
  const real = await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
  });
  const figures = await invoicingAccountFigures(orgId, contact.id);
  const owed = figures.find((f) => f.label === "You owe");
  expect(owed?.value).toBe(real.totals.total);
});

test("totals agree with documentTotals — nothing here is computed a second way", async () => {
  const orgId = await makeOrg(`Totals ${suffix}`);
  const contact = await makeContact(orgId, "Careful Customer");

  const lines = [
    { quantity: 3, unitPrice: 2_500, taxRatePpm: 87_500 },
    { quantity: 1, unitPrice: 9_999, taxRatePpm: 200_000 },
  ];
  const expected = documentTotals(lines);
  await makeInvoice({ organizationId: orgId, contactId: contact.id, lines });

  const figures = await invoicingAccountFigures(orgId, contact.id);
  expect(figures.find((f) => f.label === "You owe")?.value).toBe(
    expected.total,
  );
});

test("a credited invoice reads settled, not owed — the vocabulary a customer reads matches their bill", async () => {
  const orgId = await makeOrg(`Credited ${suffix}`);
  const contact = await makeContact(orgId, "Fully Credited");

  const invoice = await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
    status: "credited",
  });
  await makeCreditNote({
    organizationId: orgId,
    contactId: contact.id,
    referenceInvoiceId: invoice.id,
    totalCents: invoice.totals.total,
  });

  const figures = await invoicingAccountFigures(orgId, contact.id);
  expect(figures.find((f) => f.label === "You owe")?.value).toBe(0);
  // Settled by credit note, not by money — it must not be counted as paid.
  expect(figures.find((f) => f.label === "Paid")?.value ?? 0).toBe(0);
});

test("partly paid then credited for the rest reads paid — real money still shows as paid", async () => {
  const orgId = await makeOrg(`PartCredit ${suffix}`);
  const contact = await makeContact(orgId, "Part Paid Then Credited");

  const invoice = await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
    status: "paid",
    lines: [{ quantity: 1, unitPrice: 10_000 }],
  });
  await pay(orgId, invoice.id, 4_000);
  await makeCreditNote({
    organizationId: orgId,
    contactId: contact.id,
    referenceInvoiceId: invoice.id,
    totalCents: 6_000,
  });

  const figures = await invoicingAccountFigures(orgId, contact.id);
  expect(figures.find((f) => f.label === "You owe")?.value).toBe(0);
  // The 4,000 that genuinely changed hands still shows as paid — a credit
  // note settling the rest must not erase it.
  expect(figures.find((f) => f.label === "Paid")?.value).toBe(4_000);
});

test("an overdue balance is called out; a balance not yet due is not", async () => {
  const orgId = await makeOrg(`Overdue ${suffix}`);
  const contact = await makeContact(orgId, "Behind Customer");

  await makeInvoice({
    organizationId: orgId,
    contactId: contact.id,
    dueDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
  });

  const late = await invoicingAccountFigures(orgId, contact.id);
  const overdue = late.find((f) => f.label === "Overdue");
  expect(overdue?.value).toBeGreaterThan(0);
  expect(overdue?.tone).toBe("bad");

  const onTime = await makeContact(orgId, "On Time Customer");
  await makeInvoice({
    organizationId: orgId,
    contactId: onTime.id,
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });
  const figures = await invoicingAccountFigures(orgId, onTime.id);
  expect(figures.find((f) => f.label === "Overdue")).toBeUndefined();
});

test("one business's customer cannot see another's invoices", async () => {
  const orgA = await makeOrg(`Alpha ${suffix}`);
  const orgB = await makeOrg(`Beta ${suffix}`);
  const alice = await makeContact(orgA, "Alice of Alpha");

  await makeInvoice({ organizationId: orgA, contactId: alice.id });

  expect(await invoicingHasAccountActivity(orgA, alice.id)).toBe(true);
  // The same contact id, asked about under the wrong organization: the pair
  // does not match anything, which is the whole of the scoping.
  expect(await invoicingHasAccountActivity(orgB, alice.id)).toBe(false);

  const figures = await invoicingAccountFigures(orgB, alice.id);
  expect(figures.find((f) => f.label === "You owe")?.value).toBe(0);
});

/**
 * The figure the portal-link email quotes at the customer.
 *
 * That email worked its own total out — every invoice ever raised for them,
 * whatever its status, less the payments — so a business sending somebody a
 * link to their account told them they owed for drafts nobody had sent, for
 * invoices that had been voided, and for the credit notes it had given them.
 * It reads `customerBalance` now, which is what the page at the other end of
 * the link shows.
 */
test("a customer's balance counts neither drafts, voids nor credit notes", async () => {
  const organizationId = await makeOrg("Balance");
  const contact = await makeContact(organizationId, "Nkemdirim");

  const owed = await makeInvoice({ organizationId, contactId: contact.id });
  await makeInvoice({ organizationId, contactId: contact.id, status: "draft" });
  await makeInvoice({ organizationId, contactId: contact.id, status: "void" });
  const credited = await makeInvoice({ organizationId, contactId: contact.id });
  await makeCreditNote({
    organizationId,
    contactId: contact.id,
    referenceInvoiceId: credited.id,
    totalCents: credited.totalCents,
  });

  const balance = await customerBalance(organizationId, contact.id);
  // Only the one invoice that is actually a debt.
  expect(balance.owedCents).toBe(owed.totalCents);
});

test("registers as a section with no entitlement of its own, and its href leads to the real portal", async () => {
  registerForTest(invoicing);
  const section = allAccountSections().find((s) => s.id === "invoicing");
  expect(section).toBeDefined();
  expect(section?.entitlement).toBeUndefined();

  const orgId = await makeOrg(`Hrefs ${suffix}`);
  const contact = await makeContact(orgId, "Href Customer");
  const token = await ensurePortalToken(contact);

  const href = await section?.href?.(orgId, contact.id);
  expect(href).toBe(`/portal/${token}`);
});
