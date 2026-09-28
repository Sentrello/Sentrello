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
  const screens = new Set(["invoicing", "quotes", "settings", "contacts"]);
  for (const s of guide().steps) {
    expect(screens.has(s.opens ?? ""), `${s.id} opens ${s.opens}`).toBe(true);
  }
});

test("on an empty business, nothing is already done", async () => {
  // The org has to exist, or the steps that read it answer about nothing.
  await db
    .insert(schema.organizations)
    .values({ id: orgId, name: "Empty", slug: orgId, createdAt: new Date() })
    .onConflictDoNothing();

  for (const s of guide().steps) {
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
  for (const s of steps.filter((s) => s.id !== "how-to-pay")) {
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
