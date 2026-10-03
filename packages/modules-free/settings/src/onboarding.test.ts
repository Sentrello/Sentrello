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
