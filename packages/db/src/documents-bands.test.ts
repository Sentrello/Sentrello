import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, db, eq, like, schema } from "@sentrello/db";
import { dayIn } from "./day";
import { raiseInvoice } from "./documents";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * An invoice raised by something other than a person, with a named tax on it.
 *
 * Subscriptions, prorations, metered usage and bookings all bill through
 * `raiseInvoice`, and it wrote no tax bands. The posting reads the bands to
 * decide where the tax goes, so with none every one of those invoices put US
 * and Canadian tax on the shared 2200 — and the returns read only the
 * per-authority accounts. Charged, collected, and missing from the return.
 *
 * And it set no issue date, so the column's `now()` dated it: an instant, on a
 * column that names a day, which a billing run at 02:00 UTC turns into the
 * evening before for a business in New York.
 */
const orgId = `docs-bands-${crypto.randomUUID().slice(0, 8)}`;
let definitionId = "";

beforeAll(async () => {
  await makeOrganization(orgId);
  await db
    .update(schema.organizations)
    .set({ timezone: "America/New_York" })
    .where(eq(schema.organizations.id, orgId));
  const [made] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: "NY sales tax",
      rateBp: 888,
      ratePpm: 88_750,
      regime: "us",
    })
    .returning();
  definitionId = made?.id ?? "";
});

afterAll(async () => {
  await dropOrganization(orgId);
});

test("a named US tax is banded and posted to its own authority's account", async () => {
  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: [
      {
        description: "Coffee club",
        quantity: 1,
        unitPriceCents: 2000,
        taxRatePpm: 88_750,
        taxDefinitionId: definitionId,
      },
    ],
  });
  if (!invoice) throw new Error("no invoice");
  expect(invoice.taxCents).toBe(178);

  const bands = await db
    .select()
    .from(schema.documentTaxes)
    .where(eq(schema.documentTaxes.documentId, invoice.id));
  expect(bands.map((b) => [b.taxDefinitionId, b.name, b.taxCents])).toEqual([
    [definitionId, "NY sales tax", 178],
  ]);

  const [credited] = await db
    .select({ cents: schema.journalLines.creditCents })
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
        eq(schema.journalEntries.source, `invoice:${invoice.id}`),
        like(schema.accounts.code, "2200-%"),
      ),
    );
  expect(credited?.cents).toBe(178);

  // A day, where the business is: midnight UTC of New York's today.
  expect(invoice.issueDate.toISOString()).toBe(
    dayIn(new Date(), "America/New_York").toISOString(),
  );
});

test("a tax rate from another business is refused", async () => {
  await expect(
    raiseInvoice(orgId, {
      contactId: null,
      lines: [
        {
          description: "x",
          quantity: 1,
          unitPriceCents: 100,
          taxDefinitionId: crypto.randomUUID(),
        },
      ],
    }),
  ).rejects.toThrow("that tax rate does not exist");
});
