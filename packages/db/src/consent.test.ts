import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "./client";
import { consentHistory, describeConsent, recordConsent } from "./consent";
import { eq, inArray } from "./orm";
import * as schema from "./schema";

/**
 * Consent, and whose it is.
 *
 * `consentHistory` filters by organization and nothing held it there. Deleting
 * that one line broke no test, which is the shape worth fixing rather than the
 * bug: this is the evidence a business produces when somebody asks what they
 * agreed to, and the wrong business's evidence is worse than none.
 *
 * **The subject id is the same in both organizations on purpose.** A consent
 * record is keyed by subject kind and id, and a test using two different ids
 * passes whether or not the organization filter is there — the ids alone
 * separate the rows. Only a collision makes the filter the thing doing the
 * work, and a collision is not exotic: `subjectId` is whatever the caller
 * passes, and an imported list, a checkout email or a form submission can
 * carry the same identifier for two different businesses' customers.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const ours = `consent-a-${suffix}`;
const theirs = `consent-b-${suffix}`;
/** One id, two businesses. This is what makes the test mean anything. */
const SUBJECT = { kind: "contact" as const, id: crypto.randomUUID() };

async function makeOrg(id: string) {
  await db.insert(schema.organizations).values({
    id,
    name: `Consent ${id}`,
    slug: id,
    countryCode: "US",
    createdAt: new Date(),
  });
}

beforeAll(async () => {
  await makeOrg(ours);
  await makeOrg(theirs);

  await recordConsent({
    organizationId: ours,
    subject: { ...SUBJECT, label: "Our customer" },
    purpose: "marketing.email",
    granted: true,
    source: "form",
    wording: "Tick to hear from us",
    at: new Date("2026-01-10T09:00:00Z"),
  });
  await recordConsent({
    organizationId: ours,
    subject: { ...SUBJECT, label: "Our customer" },
    purpose: "marketing.email",
    granted: false,
    source: "staff",
    at: new Date("2026-06-02T09:00:00Z"),
  });
  await recordConsent({
    organizationId: theirs,
    subject: { ...SUBJECT, label: "Somebody else's customer" },
    purpose: "marketing.email",
    granted: true,
    source: "import",
    at: new Date("2026-03-01T09:00:00Z"),
  });
});

afterAll(async () => {
  await db
    .delete(schema.consentRecords)
    .where(inArray(schema.consentRecords.organizationId, [ours, theirs]));
  for (const id of [ours, theirs]) {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, id));
  }
});

test("one business's history is only its own, for the same person", async () => {
  const mine = await consentHistory(ours, SUBJECT);
  expect(mine).toHaveLength(2);
  expect(
    mine.every((row) => row.organizationId === ours),
    "another business's consent record reached this history",
  ).toBe(true);
  expect(mine.map((row) => row.source)).toEqual(["form", "staff"]);
});

test("and the other business sees only theirs", async () => {
  const other = await consentHistory(theirs, SUBJECT);
  expect(other).toHaveLength(1);
  expect(other[0]?.source).toBe("import");
});

test("oldest first, because it is a history and reads as one", async () => {
  // "Agreed on the form, withdrew two years later" is the sentence somebody
  // needs; newest-first tells it backwards.
  const mine = await consentHistory(ours, SUBJECT);
  const times = mine.map((row) => row.at.getTime());
  expect(times).toEqual([...times].sort((a, b) => a - b));
});

test("a subject nobody has recorded anything about has no history", async () => {
  const none = await consentHistory(ours, {
    kind: "contact" as const,
    id: crypto.randomUUID(),
  });
  expect(none).toEqual([]);
});

test("the subject kind separates two records sharing an id", async () => {
  // A contact and a subscriber can hold the same uuid in principle; the kind
  // is part of the key for that reason.
  // "subscriber" rather than an invented kind: the type is a closed set, and
  // the point is that the kind is part of the key, not that any string works.
  const asSubscriber = await consentHistory(ours, {
    kind: "subscriber" as const,
    id: SUBJECT.id,
  });
  expect(asSubscriber).toEqual([]);
});

test("what it is described as, in the words a business would repeat", async () => {
  const [first] = await consentHistory(ours, SUBJECT);
  expect(first).toBeTruthy();
  if (!first) return;
  const said = describeConsent(first);
  // A sentence somebody could read back to the person who asked, not a row.
  expect(said).toContain("Our customer");
  expect(said).toContain("agreed");
  expect(said).toContain("to be emailed marketing");
  expect(said).toContain("on a form they filled in");
  expect(said).toContain("2026-01-10");
});
