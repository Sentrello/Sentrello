import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq, sql } from "drizzle-orm";
import { auth } from "./index";
import { admin, customer } from "./permissions";
import { signUpAsOwner } from "./testing";

// --- the matrix itself, no database needed -------------------------------

// Staff and Accounting used to be asserted here, when they were compiled in.
// They are the business's own roles now, so what they contain is asserted
// where they are defined — see the users module's defaults. What is left here
// is the pair that genuinely cannot be data.

test("admin keeps the built-in org powers on top of the Sentrello resources", () => {
  expect(admin.authorize({ invoicing: ["send"] }).success).toBe(true);
  expect(admin.authorize({ member: ["create"] }).success).toBe(true);
  expect(admin.authorize({ organization: ["update"] }).success).toBe(true);
  expect(admin.authorize({ settings: ["update"] }).success).toBe(true);
});

test("customer may only read invoices — row scoping is the routes' job", () => {
  expect(customer.authorize({ invoicing: ["read"] }).success).toBe(true);
  expect(customer.authorize({ invoicing: ["create"] }).success).toBe(false);
  expect(customer.authorize({ crm: ["read"] }).success).toBe(false);
});

// --- end to end through real sessions ------------------------------------

const suffix = crypto.randomUUID().slice(0, 8);
const password = "correct-horse-battery-staple";
const emails = {
  owner: `owner-${suffix}@example.test`,
  accounting: `accounting-${suffix}@example.test`,
  staff: `staff-${suffix}@example.test`,
};

let orgId: string;
let ownerHeaders: Headers;
let accountingHeaders: Headers;
let staffHeaders: Headers;

async function signUp(email: string, name: string) {
  const { headers, response } = await signUpAsOwner({ email, password, name });
  const cookie = headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  return { userId: response.user.id, headers: new Headers({ cookie }) };
}

beforeAll(async () => {
  const owner = await signUp(emails.owner, "Owner");
  ownerHeaders = owner.headers;

  const org = await auth.api.createOrganization({
    body: { name: `Perms ${suffix}`, slug: `perms-${suffix}` },
    headers: ownerHeaders,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: ownerHeaders,
  });

  /**
   * The two roles under test are created here rather than compiled in.
   *
   * That is the point of the change they came from: Staff and Accounting are
   * ordinary roles a business owns, so the honest way to test what they allow
   * is to make one and assign it — which is exactly what an instance does on
   * its first run.
   *
   * The permissions are deliberately the smallest that express the boundary,
   * not a copy of the shipped defaults. What the shipped ones contain is
   * asserted where they are defined; what this file owns is whether a role
   * created as data is enforced at all.
   */
  const seeded: [string, Record<string, string[]>][] = [
    ["accounting", { invoicing: ["send"], crm: ["read"] }],
    ["staff", { crm: ["read", "create"], invoicing: ["read"] }],
  ];
  for (const [role, permission] of seeded) {
    await auth.api.createOrgRole({
      body: { organizationId: orgId, role, permission },
      headers: ownerHeaders,
    });
  }

  for (const [role, email] of [
    ["accounting", emails.accounting],
    ["staff", emails.staff],
  ] as const) {
    const member = await signUp(email, role);
    // Added on a compiled role, then moved onto the business's own. Better
    // Auth types `addMember` to the roles compiled in, which is now two — and
    // moving somebody onto a role the business made is the path an instance
    // actually takes, so the test takes it too.
    const added = await auth.api.addMember({
      body: { userId: member.userId, organizationId: orgId, role: "customer" },
    });
    await auth.api.updateMemberRole({
      body: {
        memberId: (added as { id: string }).id,
        role,
        organizationId: orgId,
      },
      headers: ownerHeaders,
    });
    await auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: member.headers,
    });
    if (role === "accounting") accountingHeaders = member.headers;
    else staffHeaders = member.headers;
  }
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db.execute(
    sql`delete from organization_role where organization_id = ${orgId}`,
  );
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  for (const email of Object.values(emails)) {
    const [u] = await db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, email));
    if (!u) continue;
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("the owner's session resolves to the organization it created", async () => {
  const session = await auth.api.getSession({ headers: ownerHeaders });
  expect(session?.session.activeOrganizationId).toBe(orgId);
});

test("signing in later still lands in the organization", async () => {
  // The session made while creating the organization has it set. A session
  // made by signing in tomorrow is a different row, and if it comes back
  // without an active organization the whole instance behaves as though the
  // business were empty: every list is empty and every write is refused.
  const signIn = await auth.api.signInEmail({
    body: { email: emails.owner, password },
    returnHeaders: true,
  });
  const cookie = signIn.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-in returned no session cookie");

  const session = await auth.api.getSession({
    headers: new Headers({ cookie }),
  });
  expect(session?.session.activeOrganizationId).toBe(orgId);
});

test("accounting can send invoices through a real session", async () => {
  const result = await auth.api.hasPermission({
    headers: accountingHeaders,
    body: { permissions: { invoicing: ["send"] } },
  });
  expect(result.success).toBe(true);
});

test("staff is denied invoice creation through a real session", async () => {
  const result = await auth.api.hasPermission({
    headers: staffHeaders,
    body: { permissions: { invoicing: ["create"] } },
  });
  expect(result.success).toBe(false);
});

test("staff can still work contacts", async () => {
  const result = await auth.api.hasPermission({
    headers: staffHeaders,
    body: { permissions: { crm: ["create"] } },
  });
  expect(result.success).toBe(true);
});

test("a request with no session is not granted anything", async () => {
  const check = auth.api.hasPermission({
    headers: new Headers(),
    body: { permissions: { crm: ["read"] } },
  });
  // Better Auth throws for an unauthenticated caller; the Hono guard turns any
  // non-`success` outcome into a 403, so both shapes deny.
  await expect(check).rejects.toBeDefined();
});
