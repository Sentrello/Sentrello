import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { raiseInvoice } from "./documents";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * An invoice raised by something other than a person, on a business that quotes
 * gross.
 *
 * The UK and the EU put the tax inside the price: a plan that says £120 means
 * £120 is what the customer pays, and £20 of it is the VAT. The US quotes net
 * and adds the tax at the till. Which one a business does is a setting, read
 * when a document is made and then frozen onto it.
 *
 * `raiseInvoice` read neither. So every invoice it raised was net-quoted
 * whatever the business had said: a £120 subscription billed £144, every month,
 * to every subscriber — and the document then agreed with itself, because its
 * own copy of the flag said net as well, so the only thing wrong anywhere was
 * the amount. Three callers go through this door and all three bill a price
 * somebody typed into a plan or a service: a subscription period, a mid-period
 * change, and an appointment that was kept.
 *
 * The US was the one market where the default happened to be right, which is
 * the same shape as the `?? "USD"` currency fallback this file's sibling covers.
 */
const orgId = `docs-gross-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await makeOrganization(orgId);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

async function quotes(gross: boolean) {
  await db
    .insert(schema.invoicingSettings)
    .values({ organizationId: orgId, pricesIncludeTax: gross })
    .onConflictDoUpdate({
      target: schema.invoicingSettings.organizationId,
      set: { pricesIncludeTax: gross },
    });
}

/** £120 with 20% VAT inside it. */
const oneLine = [
  {
    description: "Coffee club",
    quantity: 1,
    unitPriceCents: 12_000,
    taxRatePpm: 200_000,
  },
];

test("a gross-quoting business bills the price it quoted, tax inside", async () => {
  await quotes(true);

  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: oneLine,
  });
  // What the customer agreed to pay, to the cent — not £144.
  expect(invoice?.totalCents).toBe(12_000);
  expect(invoice?.taxCents).toBe(2000);
  expect(invoice?.subtotalCents).toBe(10_000);
  // And the document says which convention it was made under, because every
  // later reading of it — the screen, the PDF, a credit note — asks the
  // document rather than the setting.
  expect(invoice?.pricesIncludeTax).toBe(true);
});

test("a net-quoting business still adds the tax on top", async () => {
  await quotes(false);

  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: oneLine,
  });
  expect(invoice?.subtotalCents).toBe(12_000);
  expect(invoice?.taxCents).toBe(2400);
  expect(invoice?.totalCents).toBe(14_400);
  expect(invoice?.pricesIncludeTax).toBe(false);
});

/** No settings row at all is a business that has never been asked. Net. */
test("a business with no invoicing settings quotes net", async () => {
  await db
    .delete(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, orgId));

  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: oneLine,
  });
  expect(invoice?.totalCents).toBe(14_400);
  expect(invoice?.pricesIncludeTax).toBe(false);
});
