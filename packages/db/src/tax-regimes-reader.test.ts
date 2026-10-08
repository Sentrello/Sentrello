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
