import { afterAll, beforeEach, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { ensurePortalToken } from "@sentrello/db/portal";
import {
  addAccountSection,
  clearAccountSections,
  registerForTest,
} from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import account, { visibleSections } from "./index";

/**
 * The unified customer account page: identity, disclosure, and forgery.
 *
 * The viewer holds no platform session — the credential is the same portal
 * token `/portal/:token` and Subscriptions' own portal already trust, so
 * these tests exercise it the same way: an HTTP request with a token in the
 * URL and nothing else.
 */

const suffix = crypto.randomUUID().slice(0, 8);

async function makeOrg(name: string) {
  const id = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${suffix}`,
    createdAt: new Date(),
  });
  return id;
}

async function makeContact(organizationId: string, name: string) {
  const [row] = await db
    .insert(schema.contacts)
    .values({ organizationId, name })
    .returning();
  if (!row) throw new Error("contact insert failed");
  const token = await ensurePortalToken(row);
  return { ...row, portalToken: token };
}

const orgIds: string[] = [];
afterAll(async () => {
  for (const id of orgIds) {
    await db
      .delete(schema.contacts)
      .where(eq(schema.contacts.organizationId, id));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, id));
  }
});

beforeEach(() => {
  clearAccountSections();
});

test("a section a customer has something in appears, figures and all", async () => {
  const orgId = await makeOrg(`Barker ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Dana Customer");

  addAccountSection({
    id: "shop",
    moduleId: "shop",
    label: "Shop orders",
    hasAny: async () => true,
    load: async () => [{ label: "Orders", value: 3, kind: "count" }],
  });

  const app = registerForTest(account);
  const res = await app.request(
    `http://localhost/account/${contact.portalToken}`,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toContain("Shop orders");
  expect(html).toContain("Orders");
  expect(html).toContain("Dana Customer");
});

test("a section whose entitlement the business lacks is never evaluated, let alone shown", async () => {
  const orgId = await makeOrg(`Lacking ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "No Pro Here");

  let hasAnyCalled = false;
  addAccountSection({
    id: "pro-only",
    moduleId: "pro-thing",
    label: "Pro-only section",
    entitlement: { tier: "pro" },
    hasAny: async () => {
      hasAnyCalled = true;
      return true;
    },
    load: async () => [{ label: "x", value: 1 }],
  });

  // Entitled to nothing beyond Free — the instance this business is on.
  const app = registerForTest(account, undefined, () => false);
  const res = await app.request(
    `http://localhost/account/${contact.portalToken}`,
  );
  const html = await res.text();
  expect(html).not.toContain("Pro-only section");
  expect(hasAnyCalled).toBe(false);
});

test("a customer with nothing in a section never has load called, and never sees it", async () => {
  const orgId = await makeOrg(`Empty ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Never Booked");

  let loadCalled = false;
  addAccountSection({
    id: "booking",
    moduleId: "scheduling",
    label: "Booking",
    hasAny: async () => false,
    load: async () => {
      loadCalled = true;
      return [{ label: "x", value: 1 }];
    },
  });

  const app = registerForTest(account);
  const res = await app.request(
    `http://localhost/account/${contact.portalToken}`,
  );
  const html = await res.text();
  expect(html).not.toContain("Booking");
  expect(loadCalled).toBe(false);
});

test("one business's customer cannot see another's account", async () => {
  const orgA = await makeOrg(`Alpha ${suffix}`);
  const orgB = await makeOrg(`Beta ${suffix}`);
  orgIds.push(orgA, orgB);
  const alice = await makeContact(orgA, "Alice of Alpha");
  const bob = await makeContact(orgB, "Bob of Beta");

  addAccountSection({
    id: "shop",
    moduleId: "shop",
    label: "Shop orders",
    // A section keyed correctly by the pair the host handed it: it would
    // only ever answer true for Alice's own organization and contact.
    hasAny: async (organizationId, contactId) =>
      organizationId === orgA && contactId === alice.id,
    load: async () => [{ label: "Orders", value: 9, kind: "count" }],
  });

  const app = registerForTest(account);

  const aliceRes = await app.request(
    `http://localhost/account/${alice.portalToken}`,
  );
  const aliceHtml = await aliceRes.text();
  expect(aliceHtml).toContain("Alice of Alpha");
  expect(aliceHtml).toContain("Shop orders");

  const bobRes = await app.request(
    `http://localhost/account/${bob.portalToken}`,
  );
  const bobHtml = await bobRes.text();
  expect(bobHtml).toContain("Bob of Beta");
  expect(bobHtml).not.toContain("Alice");
  expect(bobHtml).not.toContain("Shop orders");
});

test("a tampered or invented token is refused, not merely denied its data", async () => {
  const orgId = await makeOrg(`Guarded ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Guarded Customer");

  const app = registerForTest(account);

  // Flip one character of a real token.
  const real = contact.portalToken;
  const flipped = real.slice(0, -1) + (real.at(-1) === "a" ? "b" : "a");
  const tampered = await app.request(`http://localhost/account/${flipped}`);
  expect(tampered.status).toBe(404);

  const invented = await app.request(
    "http://localhost/account/not-a-real-token-at-all",
  );
  expect(invented.status).toBe(404);

  // The real one still works, so the refusal above was the token, not a
  // route that answers 404 to everything.
  const real404Check = await app.request(`http://localhost/account/${real}`);
  expect(real404Check.status).toBe(200);
});

test("a section whose load throws is left out entirely, not shown empty", async () => {
  const orgId = await makeOrg(`Throws ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Sees No Ghost");

  addAccountSection({
    id: "flaky",
    moduleId: "flaky-mod",
    label: "Flaky Section",
    hasAny: async () => true,
    load: async () => {
      throw new Error("query failed");
    },
  });

  const app = registerForTest(account);
  const res = await app.request(
    `http://localhost/account/${contact.portalToken}`,
  );
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).not.toContain("Flaky Section");
});

test("visibleSections: gate order — entitlement, then presence, then load", async () => {
  const calls: string[] = [];
  addAccountSection({
    id: "a",
    moduleId: "m",
    label: "A",
    entitlement: { tier: "pro" },
    hasAny: async () => {
      calls.push("hasAny:a");
      return true;
    },
    load: async () => {
      calls.push("load:a");
      return [];
    },
  });
  addAccountSection({
    id: "b",
    moduleId: "m",
    label: "B",
    hasAny: async () => {
      calls.push("hasAny:b");
      return false;
    },
    load: async () => {
      calls.push("load:b");
      return [];
    },
  });

  const views = await visibleSections(() => false, "org", "contact");
  expect(views).toEqual([]);
  // "a" was refused on entitlement alone; "b" was asked and said no.
  expect(calls).toEqual(["hasAny:b"]);
});
