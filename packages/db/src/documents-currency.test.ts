import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { raiseInvoice } from "./documents";
import { MoneyError } from "./money";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * An invoice raised by something other than a person, on a business that is
 * not American.
 *
 * `raiseInvoice` is what a module calls when a thing that happened turns into
 * money owed: a booking that was kept, a subscription period that came round,
 * a proration. None of those callers says anything about currency, because
 * none of them has an opinion — and the parameter defaulted to `"USD"`.
 *
 * On a GBP or EUR instance that asked for a dollar rate. A business that does
 * not trade in dollars never records one, so the refusal below fired and the
 * invoice was never raised. **Booking could not bill on three of our four
 * markets**, silently, until somebody went looking for an invoice that had
 * never appeared.
 *
 * Found 2026-09-28. The same fallback was live on the invoice form, on quotes
 * and on subscriptions, and this one was the quietest of the four.
 */
const orgId = `docs-currency-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await makeOrganization(orgId);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

async function keepsBooksIn(code: string) {
  await db
    .update(schema.organizations)
    .set({ baseCurrency: code })
    .where(eq(schema.organizations.id, orgId));
}

const oneLine = [
  { description: "Roof survey", quantity: 1, unitPriceCents: 10_000 },
];

test("a caller that says nothing gets the business's own currency", async () => {
  await keepsBooksIn("GBP");

  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    lines: oneLine,
  });
  expect(invoice).not.toBeNull();
  expect(invoice?.currency).toBe("GBP");

  // Not merely a label: the ledger has to have taken it, which is what the
  // rate lookup is for. A base currency is always worth one of itself.
  expect(invoice?.totalCents).toBe(10_000);
});

test("a caller that names a currency with no rate is still refused", async () => {
  await keepsBooksIn("GBP");

  await expect(
    raiseInvoice(orgId, { contactId: null, currency: "JPY", lines: oneLine }),
  ).rejects.toBeInstanceOf(MoneyError);
});

test("a currency the business has priced is taken", async () => {
  await keepsBooksIn("GBP");
  await db.insert(schema.exchangeRates).values({
    organizationId: orgId,
    code: "EUR",
    rateMicro: 850_000,
    asOf: new Date("2020-01-01"),
  });

  const invoice = await raiseInvoice(orgId, {
    contactId: null,
    currency: "EUR",
    lines: oneLine,
  });
  expect(invoice?.currency).toBe("EUR");
});
