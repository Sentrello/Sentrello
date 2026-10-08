import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import {
  allOnboarding,
  clearOnboarding,
  registerForTest,
} from "@sentrello/module-sdk";
import settings from "./index";

/**
 * The one setting nothing else can guess, and the step that asks for it.
 *
 * A business has no timezone until somebody fills it in, and from 3 October the
 * fallback is UTC rather than whatever clock the container keeps. UTC is the
 * only safe assumption and it is wrong for almost everybody — it decides when a
 * timed offer starts, when the till's day rolls over, and which day an hour
 * worked lands on. So James's condition for the UTC change was that onboarding
 * ask, and this is what proves it still does.
 *
 * The predicate is the part that rots. It reads a column, and the failure it
 * guards against is a step that answers "already done" on a business that has
 * set nothing — a checklist that ticks itself is worse than none, because it is
 * read once and then never again.
 */
clearOnboarding();
registerForTest(settings);

const orgId = `org-tz-${crypto.randomUUID().slice(0, 8)}`;

const askedFor = () => {
  const guide = allOnboarding().find((g) => g.id === "settings");
  if (!guide) throw new Error("the settings module registered no guide");
  const step = guide.steps.find((s) => s.id === "timezone");
  if (!step?.done) throw new Error("no timezone step that can answer");
  return step.done;
};

const setZone = (timezone: string | null) =>
  db
    .update(schema.organizations)
    .set({ timezone })
    .where(eq(schema.organizations.id, orgId));

beforeAll(async () => {
  await makeOrganization(orgId);
  await setZone(null);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

test("a business that has said nothing is asked", async () => {
  expect(await askedFor()(orgId)).toBe(false);
});

test("a business that has said is not asked again", async () => {
  await setZone("America/Denver");
  expect(await askedFor()(orgId)).toBe(true);
});

/**
 * Known, not merely filled in.
 *
 * "Americas/Denver" is a field somebody has completed and a timezone nothing
 * can read, and `timezoneFor` falls back to UTC on exactly that. If the step
 * only checked for text it would read as done while the business ran on the
 * fallback — the step has to agree with the code that uses the value.
 */
test("a timezone nothing can read is not an answer", async () => {
  await setZone("Americas/Denver");
  expect(await askedFor()(orgId)).toBe(false);

  await setZone("");
  expect(await askedFor()(orgId)).toBe(false);
});

/** And clearing it brings the step back, because the business is back where it was. */
test("clearing it asks again", async () => {
  await setZone("Europe/London");
  expect(await askedFor()(orgId)).toBe(true);
  await setZone(null);
  expect(await askedFor()(orgId)).toBe(false);
});

/**
 * And the one whose window closes: which country, and therefore which currency.
 *
 * `baseCurrency` is `notNull` with a default of USD, and the first journal entry
 * locks it. So a business in Toronto that never opens the business screen keeps
 * its books in dollars permanently, and the first thing that tells it so is the
 * refusal when it tries to change them. Three of the four markets this product
 * is sold into.
 *
 * The step's predicate is the interesting half. "Has a country" is not enough —
 * the countries where the screen cannot guess a currency leave the default
 * standing — so what it actually looks for is the shape the default produces:
 * dollar books outside the United States.
 */
const askedForCountry = () => {
  const guide = allOnboarding().find((g) => g.id === "settings");
  if (!guide) throw new Error("the settings module registered no guide");
  const step = guide.steps.find((s) => s.id === "country");
  if (!step?.done) throw new Error("no country step that can answer");
  return step.done;
};

const setMarket = (countryCode: string | null, baseCurrency = "USD") =>
  db
    .update(schema.organizations)
    .set({ countryCode, baseCurrency })
    .where(eq(schema.organizations.id, orgId));

test("a business that has not said where it is, is asked", async () => {
  await setMarket(null);
  expect(await askedForCountry()(orgId)).toBe(false);
  await setMarket("");
  expect(await askedForCountry()(orgId)).toBe(false);

  /*
   * And on a currency that is not the default, which is where the country half
   * of this predicate is the only thing doing any work. Asserted because the
   * first two expectations above pass whether or not the country is checked at
   * all: an empty country is also "not the United States", so the currency
   * branch answers them by accident. Removing the country check left this file
   * green, which is how it came to be written.
   */
  await setMarket(null, "CAD");
  expect(await askedForCountry()(orgId)).toBe(false);
});

test("the United States on dollars is a complete answer", async () => {
  await setMarket("US", "USD");
  expect(await askedForCountry()(orgId)).toBe(true);
});

/** The whole point: a country filled in while the currency stayed behind. */
test("Canada on dollars is not", async () => {
  await setMarket("CA", "USD");
  expect(await askedForCountry()(orgId)).toBe(false);

  await setMarket("GB", "USD");
  expect(await askedForCountry()(orgId)).toBe(false);

  await setMarket("CA", "CAD");
  expect(await askedForCountry()(orgId)).toBe(true);
});

/**
 * Euro books in Delaware is a choice, not the default's doing.
 *
 * A predicate that demanded the country's own currency would nag for ever at
 * every business that keeps its books in something else on purpose, and a step
 * that cannot be completed is read once and then ignored.
 */
test("a currency that is nobody's default is left alone", async () => {
  await setMarket("US", "EUR");
  expect(await askedForCountry()(orgId)).toBe(true);
});

/**
 * And once the ledger has an entry the field is disabled, so the step stops.
 *
 * Sending somebody to a control they cannot use is worse than saying nothing:
 * the screen already explains why it is fixed. Asserted by posting an entry
 * under the business that is in the wrong state, so the only thing that changes
 * between the two expectations is whether the books are empty.
 */
test("a business whose books are already in dollars is not sent anywhere", async () => {
  await setMarket("CA", "USD");
  expect(await askedForCountry()(orgId)).toBe(false);

  await db.insert(schema.journalEntries).values({
    organizationId: orgId,
    memo: "whatever locked it",
  });
  expect(await askedForCountry()(orgId)).toBe(true);

  await db
    .delete(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
});
