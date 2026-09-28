import { afterAll, expect, test } from "bun:test";
import { db, eq, inArray, schema } from "@sentrello/db";
import { creditedAgainst, writeTaxBands } from "./documents";

/**
 * The two helpers in this file no route reaches directly.
 *
 * `module-tenancy.test.ts` proves the tax-definition lookup in
 * `prepareDocument` refuses another business's rate, because a route call can
 * reach it. These two it cannot: `creditedAgainst` is summed behind the status
 * recompute and the list totals, and `writeTaxBands` runs inside a caller's
 * transaction. Both take an `organizationId` and are trusted to use it, which
 * is exactly the trust that has to be watched — a wrong filter here ships
 * unseen.
 *
 * Same shape as `tenancy-helpers.test.ts` in the data layer: two businesses,
 * a row planted for the second that an unscoped query would return or destroy,
 * and the assertion that it is not.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const alpha = `alpha-${suffix}`;
const beta = `beta-${suffix}`;

afterAll(async () => {
  await db
    .delete(schema.documentTaxes)
    .where(inArray(schema.documentTaxes.organizationId, [alpha, beta]));
  await db
    .delete(schema.invoices)
    .where(inArray(schema.invoices.organizationId, [alpha, beta]));
});

test("credits against an invoice are one business's credit notes only", async () => {
  /*
   * The poison row is a credit note in the second business whose
   * `referenceInvoiceId` points at the first business's invoice. Nothing in
   * the product writes one — which is the point: only the filter stands
   * between it and the sum. Unscoped, the invoice would show more credited
   * than the business ever issued, and the status recompute would mark it
   * settled by a stranger's document.
   */
  const [invoice] = await db
    .insert(schema.invoices)
    .values({ organizationId: alpha, number: `INV-${suffix}` })
    .returning();
  if (!invoice) throw new Error("invoice insert returned no row");

  await db.insert(schema.invoices).values([
    {
      organizationId: alpha,
      number: `CN-A-${suffix}`,
      kind: "credit_note",
      referenceInvoiceId: invoice.id,
      totalCents: 5_000,
    },
    {
      organizationId: beta,
      number: `CN-B-${suffix}`,
      kind: "credit_note",
      referenceInvoiceId: invoice.id,
      totalCents: 7_777,
    },
  ]);

  // The business's own 5000, and not a cent of the stranger's 7777.
  const credited = await creditedAgainst(alpha, [invoice.id]);
  expect(credited.get(invoice.id)).toBe(5_000);
});

test("rewriting one business's tax bands leaves another's alone", async () => {
  /*
   * The same document id in both businesses. Ids are random in practice, so
   * an unscoped delete would usually hit nothing and look correct — until the
   * one day it does not, and a business's tax breakdown vanishes while its
   * invoice keeps charging the tax. The band table is what the tax summary
   * reads; a row deleted here is tax collected and never reported.
   */
  const documentId = crypto.randomUUID();
  const band = {
    documentType: "invoice",
    documentId,
    name: "Standard",
    rateBp: 2000,
    ratePpm: 200_000,
    taxableCents: 10_000,
    taxCents: 2_000,
  };
  await db
    .insert(schema.documentTaxes)
    .values({ organizationId: beta, ...band });

  await db.transaction(async (tx) => {
    await writeTaxBands(tx, alpha, "invoice", documentId, []);
  });

  const survivors = await db
    .select({ organizationId: schema.documentTaxes.organizationId })
    .from(schema.documentTaxes)
    .where(eq(schema.documentTaxes.documentId, documentId));
  expect(survivors.map((r) => r.organizationId)).toEqual([beta]);
});
