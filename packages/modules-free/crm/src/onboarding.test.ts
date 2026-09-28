import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { allOnboarding, clearOnboarding } from "@sentrello/module-sdk";
import { registerForTest } from "@sentrello/module-sdk";
import crm from "./index";

/**
 * The checklist a business sees on its first morning.
 *
 * The mechanism has been in the SDK for weeks and exactly one module used it,
 * so a CRM arrived empty with nothing saying what to do first — every screen
 * working perfectly on no data, which is the worst first impression a product
 * can make.
 *
 * What is tested here is the part that rots: the `done` predicates. They read
 * tables, and a column rename or a table that grows an organization filter
 * elsewhere leaves a step that answers "already done" on an empty business —
 * a checklist that ticks itself is worse than none, because it is read once
 * and then never again.
 */
clearOnboarding();
registerForTest(crm);

const orgId = `org-onboarding-${crypto.randomUUID().slice(0, 8)}`;

const guide = () => {
  const found = allOnboarding().find((g) => g.id === "crm");
  if (!found) throw new Error("the CRM registered no onboarding guide");
  return found;
};

const step = (id: string) => {
  const found = guide().steps.find((s) => s.id === id);
  if (!found?.done) throw new Error(`no step ${id} that can answer`);
  return found.done;
};

afterAll(async () => {
  await db.delete(schema.forms).where(eq(schema.forms.organizationId, orgId));
  await db.delete(schema.deals).where(eq(schema.deals.organizationId, orgId));
  await db
    .delete(schema.companies)
    .where(eq(schema.companies.organizationId, orgId));
});

test("every step opens a screen the CRM actually registers", () => {
  // A step whose `opens` names nothing is a checklist item that goes nowhere
  // when it is clicked, which is the one thing a checklist must not do.
  const screens = new Set(["companies", "deals", "forms", "contacts"]);
  for (const s of guide().steps) {
    expect(screens.has(s.opens ?? ""), `${s.id} opens ${s.opens}`).toBe(true);
  }
});

test("on an empty business, nothing is already done", async () => {
  for (const s of guide().steps) {
    expect(await s.done?.(orgId), `${s.id} claimed to be done`).toBe(false);
  }
});

test("a company, a deal and a form each tick their own step", async () => {
  await db
    .insert(schema.companies)
    .values({ organizationId: orgId, name: "Halloway & Finch" });
  expect(await step("first-company")(orgId)).toBe(true);
  // And only its own: the other two are still waiting.
  expect(await step("first-deal")(orgId)).toBe(false);

  await db
    .insert(schema.deals)
    .values({ organizationId: orgId, name: "A roof" });
  expect(await step("first-deal")(orgId)).toBe(true);

  await db.insert(schema.forms).values({
    organizationId: orgId,
    key: `k-${crypto.randomUUID().slice(0, 8)}`,
    name: "Enquiries",
  });
  expect(await step("first-form")(orgId)).toBe(true);
});

/**
 * Another business's rows are not this one's progress.
 *
 * Every predicate here filters by organization, and one that forgot would
 * show a brand-new instance a finished checklist — on a hosted tier, using
 * somebody else's data to do it.
 */
test("a step does not count another business's rows", async () => {
  const theirs = `org-other-${crypto.randomUUID().slice(0, 8)}`;
  await db
    .insert(schema.companies)
    .values({ organizationId: theirs, name: "Somebody Else Ltd" });
  try {
    expect(await step("first-company")(theirs)).toBe(true);
    const fresh = `org-fresh-${crypto.randomUUID().slice(0, 8)}`;
    expect(await step("first-company")(fresh)).toBe(false);
  } finally {
    await db
      .delete(schema.companies)
      .where(eq(schema.companies.organizationId, theirs));
  }
});
