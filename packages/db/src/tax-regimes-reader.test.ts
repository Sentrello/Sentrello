import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "./index";
import { setTaxRegimes, taxRegimesFor } from "./tax-regimes";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * What a business is offered before it has chosen, read from the database.
 *
 * `defaultTaxRegimesFor` is tested on its own next door, and a correct table
 * nothing calls is the failure this file exists for: the derivation was right
 * and the reader returned the American default regardless, which is a sidebar
 * with the wrong country's tax screen in it and no test able to tell.
 *
 * Three states, and the middle one is the point: no row at all is "never
 * chosen"; a row is a choice and is honoured whatever it says; an empty row is
 * a business that turned everything off and stays off.
 */
const orgId = `org-regime-${crypto.randomUUID().slice(0, 8)}`;

const setCountry = (countryCode: string | null) =>
  db
    .update(schema.organizations)
    .set({ countryCode })
    .where(eq(schema.organizations.id, orgId));

beforeAll(async () => {
  await makeOrganization(orgId);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

test("a business that has not chosen gets its own country's regime", async () => {
  await setCountry("CA");
  expect(await taxRegimesFor(orgId)).toEqual(["ca-tax"]);

  await setCountry("GB");
  expect(await taxRegimesFor(orgId)).toEqual(["uk-vat"]);

  await setCountry("ES");
  expect(await taxRegimesFor(orgId)).toEqual(["eu-vat"]);
});

test("and the old fallback where we have no rules", async () => {
  await setCountry(null);
  expect(await taxRegimesFor(orgId)).toEqual(["us-sales-tax"]);

  await setCountry("NZ");
  expect(await taxRegimesFor(orgId)).toEqual(["us-sales-tax"]);
});

/**
 * A choice outranks the country, including a choice that contradicts it.
 *
 * A Canadian business that sells into the EU and files nothing at home is
 * unusual and entirely its own call. Nothing here may quietly add its country
 * back.
 */
test("a business that has chosen is not second-guessed", async () => {
  await setCountry("CA");
  await setTaxRegimes(orgId, ["eu-vat"]);
  expect(await taxRegimesFor(orgId)).toEqual(["eu-vat"]);

  await setTaxRegimes(orgId, []);
  expect(await taxRegimesFor(orgId)).toEqual([]);
});

/**
 * A row is not a choice, which is the half that was wrong until 8 October.
 *
 * `ledgerSettings` is created by closing a period, defining a custom field or
 * setting a VAT scheme — none of them a statement about where the business
 * trades — and `taxRegimes` has a column default of `["us-sales-tax"]`. So a
 * business in Toronto that closed September looked exactly like one that had
 * chosen to file American sales tax: it was handed the US screen, its own
 * GST/HST one was taken away, and the country-derived default above could not
 * fire, which made that fix inert for every instance that had done any
 * bookkeeping.
 *
 * Found by closing a period on a running instance. Reading the function says it
 * works, which is why this test writes the row the way the other writers do —
 * without ever calling `setTaxRegimes`.
 */
test("a row written by something else is not a choice about tax", async () => {
  await setCountry("CA");
  await db
    .delete(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));

  // Exactly what closing a period writes: the lock, and nothing about tax.
  await db
    .insert(schema.ledgerSettings)
    .values({ organizationId: orgId, closedThrough: new Date("2026-09-30") });

  // The column default is sitting in the row, and it is not an answer.
  const [row] = await db
    .select({
      taxRegimes: schema.ledgerSettings.taxRegimes,
      chosenAt: schema.ledgerSettings.taxRegimesChosenAt,
    })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
  expect(row?.taxRegimes).toEqual(["us-sales-tax"]);
  expect(row?.chosenAt).toBeNull();

  expect(await taxRegimesFor(orgId)).toEqual(["ca-tax"]);
});

/** And once somebody does choose, the stamp makes it stick. */
test("choosing stamps it, and the same answer then stands", async () => {
  await setCountry("CA");
  // The awkward case: choosing exactly what the column default holds. Before
  // the stamp this was indistinguishable from never having chosen, so the
  // setting could not be set — it would be overridden on every read.
  await setTaxRegimes(orgId, ["us-sales-tax"]);
  expect(await taxRegimesFor(orgId)).toEqual(["us-sales-tax"]);

  const [row] = await db
    .select({ chosenAt: schema.ledgerSettings.taxRegimesChosenAt })
    .from(schema.ledgerSettings)
    .where(eq(schema.ledgerSettings.organizationId, orgId));
  expect(row?.chosenAt).not.toBeNull();

  // And an empty choice is still a choice, not a fallback to the country.
  await setTaxRegimes(orgId, []);
  expect(await taxRegimesFor(orgId)).toEqual([]);
});
