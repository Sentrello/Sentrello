import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "./client";
import { ownedIdOrNothing, ownedIds } from "./owned";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * Two businesses, one contact each. Each may name its own and only its own,
 * and the other's is refused in the very words an invented id is.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const alpha = `alpha-owned-${suffix}`;
const beta = `beta-owned-${suffix}`;
let ours = "";
let theirs = "";

beforeAll(async () => {
  await makeOrganization(alpha);
  await makeOrganization(beta);
  const [a] = await db
    .insert(schema.contacts)
    .values({ organizationId: alpha, name: "Ours" })
    .returning({ id: schema.contacts.id });
  const [b] = await db
    .insert(schema.contacts)
    .values({ organizationId: beta, name: "Theirs" })
    .returning({ id: schema.contacts.id });
  if (!a || !b) throw new Error("the contacts were not made");
  ours = a.id;
  theirs = b.id;
});

afterAll(async () => {
  await dropOrganization(alpha, beta);
});

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return {
      status: (err as { status?: number }).status,
      says: (err as Error).message,
    };
  }
  return null;
};

test("a business's own id comes back, and nothing is nothing", async () => {
  expect(
    await ownedIdOrNothing(schema.contacts, alpha, ours, "contactId"),
  ).toBe(ours);
  expect(
    await ownedIdOrNothing(schema.contacts, alpha, null, "contactId"),
  ).toBeNull();
  expect(
    await ownedIdOrNothing(schema.contacts, alpha, "", "contactId"),
  ).toBeNull();
  expect(
    await ownedIds(schema.contacts, alpha, [ours, ours], "contactIds"),
  ).toEqual([ours]);
});

test("another business's id is refused exactly as an invented one", async () => {
  const foreign = await refusal(
    ownedIdOrNothing(schema.contacts, alpha, theirs, "contactId"),
  );
  const invented = await refusal(
    ownedIdOrNothing(schema.contacts, alpha, crypto.randomUUID(), "contactId"),
  );
  expect(foreign).toEqual({
    status: 400,
    says: "contactId does not name anything in this business.",
  });
  expect(invented).toEqual(foreign);
  // Not an id at all is the same answer, and never a uuid cast error.
  expect(
    await refusal(
      ownedIdOrNothing(schema.contacts, alpha, "nope", "contactId"),
    ),
  ).toEqual(foreign);
  expect(
    await refusal(ownedIdOrNothing(schema.contacts, alpha, {}, "contactId")),
  ).toEqual(foreign);
});

test("one foreign id in a list refuses the list", async () => {
  expect(
    await refusal(
      ownedIds(schema.contacts, alpha, [ours, theirs], "contactIds"),
    ),
  ).toEqual({
    status: 400,
    says: "contactIds does not name anything in this business.",
  });
  expect(
    await refusal(ownedIds(schema.contacts, alpha, "x", "contactIds")),
  ).not.toBeNull();
});
