import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import {
  allOnboarding,
  clearOnboarding,
  registerForTest,
} from "@sentrello/module-sdk";
import invoicing from "./index";

/**
 * The checklist a business works through before it sends anything.
 *
 * The CRM has had this test for weeks and invoicing had none, which is the
 * wrong way round: this is the guide whose steps are about money leaving the
 * building. What it holds is the part that rots — the `done` predicates read
 * tables, and a column rename or a table that grows an organization filter
 * elsewhere leaves a step answering "already done" on an empty business. A
 * checklist that ticks itself is worse than no checklist, because it is read
 * once and then never again.
 *
 * It also holds the shape of the list, because a step was missing from it for
 * as long as it existed: **how a customer is supposed to pay.** The portal
 * prints "How to pay" from the business's own instructions and prints nothing
 * at all without them, so a business that skipped the setting sent bills that
 * said what was owed and not how to settle it — and found out when somebody
 * emailed to ask. The section is called Getting paid.
 */
clearOnboarding();
registerForTest(invoicing);

const orgId = `org-invoicing-onboarding-${crypto.randomUUID().slice(0, 8)}`;

const guide = () => {
  const found = allOnboarding().find((g) => g.id === "invoicing");
  if (!found) throw new Error("invoicing registered no onboarding guide");
  return found;
};

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("getting paid says how to get paid", () => {
  const ids = guide().steps.map((s) => s.id);
  expect(ids).toContain("how-to-pay");
  // Before the first invoice, because that is when it is needed: the bill
  // carries the instructions, so setting them afterwards is too late for the
  // one already sent.
  expect(ids.indexOf("how-to-pay")).toBeLessThan(ids.indexOf("first-invoice"));
});

test("every step opens a screen that exists", () => {
  // A step whose `opens` names nothing is a checklist item that goes nowhere
  // when it is pressed, which is the one thing a checklist must not do.
  //
  // Not "a screen this module registers": `first-contact` opens the CRM's
  // contacts screen on purpose, because that is where somebody to invoice is
  // added. The list is the screens the steps are allowed to point at, and it
  // is short enough to keep honest by hand.
  const screens = new Set([
    "invoicing",
    "quotes",
    "settings",
    "invoicing-settings",
    "contacts",
  ]);
  for (const s of guide().steps) {
    expect(screens.has(s.opens ?? ""), `${s.id} opens ${s.opens}`).toBe(true);
  }
});

/*
 * One step answers about the business's country rather than about a column of
 * its own, so it is complete when there is nothing to ask. Named here rather
 * than left out of the loop quietly, and it has its own tests at the bottom.
 */
const ASKS_ABOUT_THE_COUNTRY = "gross-or-net";

test("on an empty business, nothing is already done", async () => {
  // The org has to exist, or the steps that read it answer about nothing.
  await db
    .insert(schema.organizations)
    .values({ id: orgId, name: "Empty", slug: orgId, createdAt: new Date() })
    .onConflictDoNothing();

  for (const s of guide().steps) {
    if (s.id === ASKS_ABOUT_THE_COUNTRY) continue;
    expect(await s.done?.(orgId), `${s.id} claimed to be done`).toBe(false);
  }
});

test("saying how to be paid ticks that step and no other", async () => {
  await db
    .insert(schema.organizations)
    .values({ id: orgId, name: "Empty", slug: orgId, createdAt: new Date() })
    .onConflictDoNothing();
  await db
    .update(schema.organizations)
    .set({ paymentInstructions: "Bank transfer to 12-34-56 · 12345678" })
    .where(eq(schema.organizations.id, orgId));

  const steps = guide().steps;
  const done = steps.find((s) => s.id === "how-to-pay");
  expect(await done?.done?.(orgId)).toBe(true);
  // And nothing else moved, which is what says the predicate reads its own
  // column rather than "has this business been touched at all".
  for (const s of steps.filter(
    (s) => s.id !== "how-to-pay" && s.id !== ASKS_ABOUT_THE_COUNTRY,
  )) {
    expect(await s.done?.(orgId), `${s.id} ticked as well`).toBe(false);
  }
});

/**
 * Whitespace is not an answer. A business that opened the field, pressed
 * space and saved has told its customers nothing, and a step that ticks on
 * that is the self-ticking checklist this file exists to stop.
 */
test("a field of spaces is not an answer", async () => {
  await db
    .update(schema.organizations)
    .set({ paymentInstructions: "   " })
    .where(eq(schema.organizations.id, orgId));
  const done = guide().steps.find((s) => s.id === "how-to-pay");
  expect(await done?.done?.(orgId)).toBe(false);
});

/**
 * And the step that is only a question in some countries.
 *
 * `invoicingSettings.pricesIncludeTax` defaults to net — a price with tax added
 * on top, which is how the US quotes. The UK and the EU quote the other way: a
 * price list that says £120 means £120, with the VAT inside it. Typed into a net
 * instance that bills £144, and the document agrees with itself the whole way
 * down, so the only thing wrong anywhere is the amount.
 *
 * Which makes this a step with no column of its own to read. It asks where the
 * business trades, and then whether it has ever saved the screen that holds the
 * answer — because any answer on that screen is a correct one, including net,
 * and there is no per-step dismissal to let a British wholesaler out of a
 * question it has already answered properly.
 */
const grossOrNet = () => {
  const step = guide().steps.find((s) => s.id === ASKS_ABOUT_THE_COUNTRY);
  if (!step?.done) throw new Error("no gross-or-net step that can answer");
  return step.done;
};

const setCountry = (countryCode: string | null) =>
  db
    .update(schema.organizations)
    .set({ countryCode })
    .where(eq(schema.organizations.id, orgId));

test("a business where the default is right is not asked", async () => {
  await setCountry("US");
  expect(await grossOrNet()(orgId)).toBe(true);
  await setCountry("CA");
  expect(await grossOrNet()(orgId)).toBe(true);
});

/** Nor one we have no rules for, because there is nothing we could tell it. */
test("a country outside the four markets is not asked", async () => {
  await setCountry(null);
  expect(await grossOrNet()(orgId)).toBe(true);
  await setCountry("AU");
  expect(await grossOrNet()(orgId)).toBe(true);
});

test("a business that quotes gross at home is asked once", async () => {
  await db
    .delete(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, orgId));

  await setCountry("GB");
  expect(await grossOrNet()(orgId)).toBe(false);
  await setCountry("IE");
  expect(await grossOrNet()(orgId)).toBe(false);

  // Saving the screen is the answer, whichever way it was answered: net is a
  // real answer for a wholesaler, and nothing here may insist on gross.
  await db
    .insert(schema.invoicingSettings)
    .values({ organizationId: orgId, pricesIncludeTax: false })
    .onConflictDoNothing();
  expect(await grossOrNet()(orgId)).toBe(true);

  await db
    .delete(schema.invoicingSettings)
    .where(eq(schema.invoicingSettings.organizationId, orgId));
  await setCountry(null);
});
