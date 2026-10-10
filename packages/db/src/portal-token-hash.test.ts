import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "./client";
import { eq } from "./orm";
import {
  contactByPortalToken,
  ensurePortalToken,
  portalTokenHash,
} from "./portal";
import * as schema from "./schema";

/**
 * A portal link is found by its hash, and only by the token it was minted as.
 *
 * The lookup used to load every contact holding a token and compare each in
 * constant time, so a stranger's every guess scanned the whole customer list.
 * The hash is worked out by the database, which is what lets every writer —
 * a reissue, an erasure, a module in another repository — stay in step with
 * it without knowing it exists.
 */

const orgId = crypto.randomUUID();
let contactId: string;
// A fresh caller per lookup: the budget is not what is being tested here.
const caller = () => `portal-hash-${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `portal-hash-${orgId}`,
    slug: `portal-hash-${orgId}`,
    createdAt: new Date(),
  });
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Portal Customer" })
    .returning();
  if (!contact) throw new Error("could not create the contact");
  contactId = contact.id;
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

async function hashOnRow(): Promise<string | null> {
  const [row] = await db
    .select({ hash: schema.contacts.portalTokenHash })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contactId));
  return row?.hash ?? null;
}

test("the database's hash is the one the server computes", async () => {
  // A backslash and a character outside ASCII: the two things a bytea cast
  // would otherwise read differently from the token's own bytes.
  for (const token of [
    "abcdefghijklmnopqrstuvwxyz_-0123456789AB",
    "back\\slash-and-\\x41-not-an-escape-at-all",
    "naïve-café-token-with-utf8-in-it-0123",
  ]) {
    await db
      .update(schema.contacts)
      .set({ portalToken: token })
      .where(eq(schema.contacts.id, contactId));
    expect(await hashOnRow()).toBe(portalTokenHash(token));
  }
});

test("a minted token finds its contact, and a reissue retires the old one", async () => {
  const first = await ensurePortalToken({ id: contactId, portalToken: null });
  expect((await contactByPortalToken(first, caller()))?.id).toBe(contactId);

  const second = await ensurePortalToken(
    { id: contactId, portalToken: first },
    true,
  );
  expect((await contactByPortalToken(second, caller()))?.id).toBe(contactId);
  expect(await contactByPortalToken(first, caller())).toBeNull();
});

test("a wrong token, or one cleared by an erasure, finds nobody", async () => {
  const token = await ensurePortalToken({ id: contactId, portalToken: null });
  expect(await contactByPortalToken(`${token}x`, caller())).toBeNull();

  await db
    .update(schema.contacts)
    .set({ portalToken: null })
    .where(eq(schema.contacts.id, contactId));
  expect(await hashOnRow()).toBeNull();
  expect(await contactByPortalToken(token, caller())).toBeNull();
});

test("two contacts cannot hold one token", async () => {
  const token = await ensurePortalToken({ id: contactId, portalToken: null });
  const copy = async () =>
    db
      .insert(schema.contacts)
      .values({ organizationId: orgId, name: "Copy", portalToken: token });
  await expect(copy()).rejects.toThrow();
});

/**
 * Two emails to one customer at the same moment send one working link.
 *
 * Each caller reads the contact, finds no token, and mints one. Both wrote,
 * the second over the first, so the first email went out with a link that
 * had already stopped working — and the customer never knew why.
 */
test("ten links minted at once for a customer with none are one link", async () => {
  await db
    .update(schema.contacts)
    .set({ portalToken: null })
    .where(eq(schema.contacts.id, contactId));
  const minted = await Promise.all(
    Array.from({ length: 10 }, () =>
      ensurePortalToken({ id: contactId, portalToken: null }),
    ),
  );
  expect(new Set(minted).size).toBe(1);
  expect((await contactByPortalToken(minted[0] ?? "", caller()))?.id).toBe(
    contactId,
  );
}, 30_000);
