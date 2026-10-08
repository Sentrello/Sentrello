import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import invoicing from "./index";

/**
 * Three decisions behind one button.
 *
 * `POST /api/contacts/:id/portal-link` asked for `invoicing: ["read"]` for all
 * of its work, and two parts of that work are not reads. `?rotate=1` **revokes**
 * the link a customer is already using — their address stops working, and
 * nothing on the business's side says so. `?send=1` puts a message in that
 * customer's inbox over the business's name.
 *
 * The seeded **staff** policy carries `invoicing: ["read"]` and nothing more on
 * invoicing, which is exactly the role this was wrong for: anybody doing the
 * daily work could take a customer's link away or mail them.
 *
 * Handing somebody the link they already have stays a read. Answering "where do
 * I see my invoices?" is what a reader is for.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `portal-owner-${suffix}@x.test`;
const staffEmail = `portal-staff-${suffix}@x.test`;
const role = `invoice readers ${suffix}`;
const app = registerForTest(invoicing);

let ownerHeaders: Headers;
let staffHeaders: Headers;
let orgId: string;
let contactId: string;

beforeAll(async () => {
  const owner = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = owner.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  ownerHeaders = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Portal ${suffix}`, slug: `portal-${suffix}` },
    headers: ownerHeaders,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: ownerHeaders,
  });

  await auth.api.createOrgRole({
    body: {
      organizationId: orgId,
      role,
      // What the seeded staff policy carries of invoicing, and no more.
      permission: { dashboard: ["read"], invoicing: ["read"] },
    },
    headers: ownerHeaders,
  });

  const staff = await signUpAsOwner({
    email: staffEmail,
    password: "correct-horse-battery-staple",
    name: "A Member of Staff",
  });
  const staffCookie = staff.headers.get("set-cookie");
  if (!staffCookie) throw new Error("sign-up returned no session cookie");
  staffHeaders = new Headers({
    cookie: staffCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: staff.response.user.id,
    role,
    baseRole: role,
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: staffHeaders,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({
      organizationId: orgId,
      // `name` is the stored display name and is not derived on insert.
      name: "Rosa Keen",
      firstName: "Rosa",
      lastName: "Keen",
      email: `rosa-${suffix}@x.test`,
    })
    .returning();
  if (!contact) throw new Error("no contact");
  contactId = contact.id;
});

afterAll(async () => {
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  for (const email of [ownerEmail, staffEmail]) {
    const [user] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!user) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
});

const post = (headers: Headers, query = "") =>
  app.request(
    `http://localhost/api/contacts/${contactId}/portal-link${query}`,
    {
      method: "POST",
      headers,
      body: "{}",
    },
  );

test("a reader may fetch the link to hand to the customer", async () => {
  const res = await post(staffHeaders);
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  expect(url).toContain("/portal/");
});

test("asking twice gives the same link, so nothing was revoked", async () => {
  const first = (await (await post(staffHeaders)).json()) as { url: string };
  const again = (await (await post(staffHeaders)).json()) as { url: string };
  expect(again.url).toBe(first.url);
});

test("a reader may not reissue it, because that breaks the one in use", async () => {
  const before = (await (await post(ownerHeaders)).json()) as { url: string };
  const refused = await post(staffHeaders, "?rotate=1");
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "invoicing: update",
  );
  // And the customer's link still works, which is the point of refusing.
  const after = (await (await post(ownerHeaders)).json()) as { url: string };
  expect(after.url).toBe(before.url);
});

test("nor send it to the customer over the business's name", async () => {
  const refused = await post(staffHeaders, "?send=1");
  expect(refused.status).toBe(403);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "invoicing: send",
  );
});

test("the owner may reissue, and the link changes", async () => {
  const before = (await (await post(ownerHeaders)).json()) as { url: string };
  const rotated = await post(ownerHeaders, "?rotate=1");
  expect(rotated.status).toBe(200);
  const after = (await rotated.json()) as { url: string };
  expect(after.url).not.toBe(before.url);
});
