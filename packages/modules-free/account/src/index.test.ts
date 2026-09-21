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

/**
 * The two things a customer can do to their own page.
 *
 * Asked for by James on 21 September: switch it light or dark, and keep a
 * copy of any section for their own records. Both are links rather than
 * scripts — a good many people read these pages in a mail client's browser.
 */
test("the colours a customer chose are the colours they get back", async () => {
  const orgId = await makeOrg(`Colours ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Ida Nightmode");
  addAccountSection({
    id: "shop",
    moduleId: "shop",
    label: "Shop orders",
    hasAny: async () => true,
    load: async () => [{ label: "Orders", value: 1, kind: "count" }],
  });
  const app = registerForTest(account);

  const asked = await app.request(
    `http://localhost/account/${contact.portalToken}?theme=dark`,
  );
  expect(asked.status).toBe(200);
  const cookie = asked.headers.get("set-cookie") ?? "";
  expect(cookie).toContain("sentrello_account_theme=dark");
  // HttpOnly, because nothing but the server drawing the page reads it.
  expect(cookie).toContain("HttpOnly");
  expect(await asked.text()).toContain('data-theme="dark"');

  // And the choice survives without the query, which is the whole point.
  const again = await app.request(
    `http://localhost/account/${contact.portalToken}`,
    { headers: { cookie: "sentrello_account_theme=dark" } },
  );
  expect(await again.text()).toContain('data-theme="dark"');

  /*
   * Nothing chosen is nothing imposed: the root element carries no choice and
   * the stylesheet falls through to the machine's own preference. Asserted on
   * the html tag rather than on the page, because the stylesheet names
   * `data-theme` in its own rules whatever the customer picked.
   */
  const fresh = await app.request(
    `http://localhost/account/${contact.portalToken}`,
  );
  expect(await fresh.text()).toContain('<html lang="en"><head>');
});

test("a section can be kept, and one they have nothing in cannot", async () => {
  const orgId = await makeOrg(`Keeping ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Pat Printer");
  addAccountSection({
    id: "shop",
    moduleId: "shop",
    label: "Shop orders",
    hasAny: async () => true,
    load: async () => [{ label: "Orders", value: 2, kind: "count" }],
  });
  const app = registerForTest(account);

  const whole = await app.request(
    `http://localhost/account/${contact.portalToken}/print`,
  );
  expect(whole.status).toBe(200);
  const html = await whole.text();
  // It prints itself, and the navigation is not on the paper.
  expect(html).toContain("window.print()");
  expect(html).toContain("@media print");

  const one = await app.request(
    `http://localhost/account/${contact.portalToken}/shop/print`,
  );
  expect(one.status).toBe(200);
  expect(await one.text()).toContain("Shop orders");

  /*
   * A section this customer has nothing in is a 404, not an empty page:
   * naming one must not confirm that the business runs it.
   */
  const absent = await app.request(
    `http://localhost/account/${contact.portalToken}/booking/print`,
  );
  expect(absent.status).toBe(404);
});

test("the tools are icons with words, and one section knows its way home", async () => {
  /*
   * Icons because the row is three small actions beside each other and three
   * words read as a sentence; words inside them because an icon alone is a
   * guess for anybody using a screen reader, and a tooltip is not a label.
   */
  const orgId = await makeOrg(`Icons ${suffix}`);
  orgIds.push(orgId);
  const contact = await makeContact(orgId, "Sam Symbol");
  addAccountSection({
    id: "shop",
    moduleId: "shop",
    label: "Shop orders",
    icon: "shopping-bag",
    hasAny: async () => true,
    load: async () => [{ label: "Orders", value: 2, kind: "count" }],
    href: async () => "/shop/orders/abc",
  });
  const app = registerForTest(account);

  const html = await (
    await app.request(`http://localhost/account/${contact.portalToken}`)
  ).text();
  expect(html).toContain("<svg");
  // Every icon says what it is, for a reader that cannot see it.
  expect(html).toContain("Save Shop orders as a PDF");
  expect(html).toContain("Open Shop orders");
  expect(html).toContain('title="Switch to dark"');
  // The whole page has no way back to itself.
  expect(html).not.toContain("Back to everything you have with us");

  const one = await (
    await app.request(
      `http://localhost/account/${contact.portalToken}/shop/print`,
    )
  ).text();
  // A section on its own does: it is the page somebody lands on from a link.
  expect(one).toContain("Back to everything you have with us");
});
