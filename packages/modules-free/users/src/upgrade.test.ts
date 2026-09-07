import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { eq, sql } from "@sentrello/db/orm";
import { dropOrganization } from "@sentrello/db/testing";

/**
 * The upgrade, rehearsed.
 *
 * Staff and Accounting used to be compiled into the product. An instance that
 * has been running holds people whose `member.role` says `staff`, and after
 * the upgrade nothing in the code knows that name any more — so unless the
 * migration has given their organization a role by that name, they sign in to
 * a product with nothing in it.
 *
 * This builds that instance: an organization with no default policies at all,
 * a member holding `staff` and another holding `admin,accounting`, exactly as
 * the old shape left them. Then it runs the real migration file and asks what
 * those people can do.
 *
 * It is deliberately not a test of `seedDefaults`. A new organization gets its
 * roles from the seed and always did; the ones that already exist are the ones
 * at risk, and they are what this covers.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `upgrade-owner-${suffix}@x.test`;
const staffEmail = `upgrade-staff-${suffix}@x.test`;
const booksEmail = `upgrade-books-${suffix}@x.test`;

let headers: Headers;
let orgId: string;
let staffId: string;
let booksId: string;
/** Each person's own session. See the note on `may`. */
let staffHeaders: Headers;
let booksHeaders: Headers;

const migration = readFileSync(
  join(
    import.meta.dir,
    "../../../db/drizzle/0038_staff_and_accounting_become_data.sql",
  ),
  "utf8",
);

/**
 * What one person may do, asked as that person.
 *
 * `hasPermission` takes a `userId` in the body and does not use it: it answers
 * for whoever the request's session belongs to. Asking with the owner's
 * headers about somebody else returns the owner's answer, so a check written
 * that way says `true` for a member holding a role that does not exist — a
 * test that cannot fail.
 *
 * Every question here is therefore asked with that member's own session.
 */
async function may(
  who: Headers,
  permissions: Record<string, string[]>,
): Promise<boolean> {
  return await auth.api
    .hasPermission({
      headers: who,
      body: { organizationId: orgId, permissions },
    })
    .then((r) => r.success)
    .catch(() => false);
}

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Upgrade ${suffix}`, slug: `upgrade-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // Two colleagues, written straight in with the roles the old product gave
  // them. No seed runs: this organization predates the change.
  for (const [email, name, role] of [
    [staffEmail, "A Fitter", "staff"],
    [booksEmail, "A Bookkeeper", "admin,accounting"],
  ] as const) {
    const person = await signUpAsOwner({
      email,
      password: "correct-horse-battery-staple",
      name,
    });
    const id = person.response.user.id;
    const cookieFor = person.headers.get("set-cookie");
    if (!cookieFor) throw new Error("sign-up returned no session cookie");
    const own = new Headers({
      cookie: cookieFor,
      "content-type": "application/json",
    });
    if (role === "staff") {
      staffId = id;
      staffHeaders = own;
    } else {
      booksId = id;
      booksHeaders = own;
    }
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId: id,
      role,
      createdAt: new Date(),
    });
  }
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db.execute(
    sql`delete from organization_role where organization_id = ${orgId}`,
  );
  await dropOrganization(orgId);
  for (const email of [ownerEmail, staffEmail, booksEmail]) {
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

test("before the migration, an existing staff member has nothing", async () => {
  // Not a bug being asserted — the state the upgrade would leave them in if
  // the migration did not exist. This is what makes the next test mean
  // something.
  expect(await may(staffHeaders, { dashboard: ["read"] })).toBe(false);
  expect(await may(staffHeaders, { crm: ["create"] })).toBe(false);
});

test("the migration gives the organization the roles its people already hold", async () => {
  await db.execute(sql.raw(migration));

  const rows = await db.execute(
    sql`select role from organization_role where organization_id = ${orgId} order by role`,
  );
  expect(JSON.stringify(rows)).toContain("staff");
  expect(JSON.stringify(rows)).toContain("accounting");
});

test("and afterwards staff can do exactly what staff does", async () => {
  expect(await may(staffHeaders, { dashboard: ["read"] })).toBe(true);
  expect(await may(staffHeaders, { crm: ["create"] })).toBe(true);
  expect(await may(staffHeaders, { documents: ["update"] })).toBe(true);

  // And no more than that: whoever does the work still cannot raise or send a
  // bill for it, which is the separation the default exists to express.
  expect(await may(staffHeaders, { invoicing: ["create"] })).toBe(false);
  expect(await may(staffHeaders, { invoicing: ["send"] })).toBe(false);
  expect(await may(staffHeaders, { settings: ["update"] })).toBe(false);
});

test("a member holding two roles keeps both", async () => {
  // `member.role` is comma separated and Better Auth allows an action if any
  // of them grants it. One of these two names is compiled and the other is
  // not, which is exactly the mixture the upgrade creates.
  expect(await may(booksHeaders, { settings: ["update"] })).toBe(true); // from admin
  expect(await may(booksHeaders, { bookkeeping: ["delete"] })).toBe(true); // from accounting
  expect(await may(booksHeaders, { invoicing: ["send"] })).toBe(true);
});

test("running it twice changes nothing", async () => {
  // Migrations get re-run against restored backups and half-finished
  // deployments. A second pass must not double the rows or fail on the unique
  // name.
  const before = await db.execute(
    sql`select count(*)::int as n from organization_role where organization_id = ${orgId}`,
  );
  await db.execute(sql.raw(migration));
  const after = await db.execute(
    sql`select count(*)::int as n from organization_role where organization_id = ${orgId}`,
  );
  expect(JSON.stringify(after)).toEqual(JSON.stringify(before));
});

/**
 * Editing a policy, which is the half that makes "they are data now" true.
 *
 * Deletable but not editable is not much of a promise: a business wanting a
 * Staff who may also send invoices would still be copying it and remembering
 * which of the two is assigned. This is the endpoint the screen's Edit button
 * calls, exercised in the shape it calls it.
 */
test("a default policy can be edited, and everybody holding it is affected", async () => {
  const before = await may(staffHeaders, { invoicing: ["send"] });
  expect(before).toBe(false);

  await auth.api.updateOrgRole({
    body: {
      organizationId: orgId,
      roleName: "staff",
      data: {
        permission: {
          dashboard: ["read"],
          crm: ["read", "create", "update"],
          invoicing: ["read", "send"],
        },
      },
    },
    headers,
  });

  // The person holding it, not the person who changed it.
  expect(await may(staffHeaders, { invoicing: ["send"] })).toBe(true);
  expect(await may(staffHeaders, { crm: ["create"] })).toBe(true);
  // And still no more than the policy says.
  expect(await may(staffHeaders, { settings: ["update"] })).toBe(false);
});

test("the two compiled roles cannot be edited away", async () => {
  // `admin` is the floor the owner stands on. If this ever starts succeeding,
  // a business can lock itself out of its own machine.
  const attempt = auth.api.updateOrgRole({
    body: {
      organizationId: orgId,
      roleName: "admin",
      data: { permission: { dashboard: ["read"] } },
    },
    headers,
  });
  await expect(attempt).rejects.toBeDefined();
});
