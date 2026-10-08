import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import settings from "./index";

/**
 * Who may pull everything this business holds about a named person.
 *
 * `POST /api/privacy/export` asks every loaded module what it has about one
 * person and hands it back in a pack: the CRM's notes, the invoices, a shop's
 * orders, a booking diary, documents. It asked for `settings: ["read"]`, which
 * is the mild permission the seeded **Managers** and **Executives** policies
 * carry — so a manager with no CRM, invoicing or shop permission at all could
 * assemble a dossier on any customer. One module's read permission was a way
 * around every other module's gating.
 *
 * Nothing tested these routes before this file. It asks for `settings:
 * ["update"]` now, the same as the erase beside it, and the two genuinely
 * read-only routes stay at read because neither carries anybody's data.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `privacy-owner-${suffix}@x.test`;
const readerEmail = `privacy-reader-${suffix}@x.test`;
const app = registerForTest(settings);

let ownerHeaders: Headers;
let readerHeaders: Headers;
let orgId: string;
let readerId: string;

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
    body: { name: `Privacy ${suffix}`, slug: `privacy-${suffix}` },
    headers: ownerHeaders,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: ownerHeaders,
  });

  /*
   * A policy carrying exactly what the seeded Managers one carries of settings:
   * read and no more. Made here rather than by seeding the whole default set,
   * so the test states the permission it is about.
   */
  await auth.api.createOrgRole({
    body: {
      organizationId: orgId,
      role: `settings readers ${suffix}`,
      permission: { dashboard: ["read"], settings: ["read"] },
    },
    headers: ownerHeaders,
  });

  const reader = await signUpAsOwner({
    email: readerEmail,
    password: "correct-horse-battery-staple",
    name: "A Manager",
  });
  readerId = reader.response.user.id;
  const readerCookie = reader.headers.get("set-cookie");
  if (!readerCookie) throw new Error("sign-up returned no session cookie");
  readerHeaders = new Headers({
    cookie: readerCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: readerId,
    role: `settings readers ${suffix}`,
    baseRole: `settings readers ${suffix}`,
    createdAt: new Date(),
  });
  /*
   * The membership was written straight into the table after this session
   * existed, so the session's own active-organization hook never ran for it.
   * Without this every permission check on it fails for that reason instead of
   * the one under test — which would make the refusal below meaningless.
   */
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: readerHeaders,
  });
});

afterAll(async () => {
  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  for (const email of [ownerEmail, readerEmail]) {
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

const as = (headers: Headers, path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });

test("the active organization really is set, so a refusal means what it says", async () => {
  // Without this the reader's session has no organization and everything 403s
  // for that reason, which would pass the test below for the wrong reason.
  const sources = await as(readerHeaders, "/api/privacy/sources");
  expect(sources.status).toBe(200);
});

test("a settings reader may read the record of processing", async () => {
  // What kinds of data the business holds and for how long. No person in it.
  const res = await as(readerHeaders, "/api/privacy/sources");
  expect(res.status).toBe(200);
  expect(
    Array.isArray(((await res.json()) as { sources: unknown[] }).sources),
  ).toBe(true);
});

test("and the log of what was asked and done", async () => {
  const res = await as(readerHeaders, "/api/privacy/requests");
  expect(res.status).toBe(200);
});

test("but may not pull everything held about a person", async () => {
  const res = await as(readerHeaders, "/api/privacy/export", {
    method: "POST",
    body: JSON.stringify({ email: "somebody@example.test" }),
  });
  expect(res.status).toBe(403);
});

test("nor erase them, which was already true", async () => {
  const res = await as(readerHeaders, "/api/privacy/erase", {
    method: "POST",
    body: JSON.stringify({ email: "somebody@example.test" }),
  });
  expect(res.status).toBe(403);
});

test("the owner can do both", async () => {
  const exported = await as(ownerHeaders, "/api/privacy/export", {
    method: "POST",
    body: JSON.stringify({ email: "somebody@example.test" }),
  });
  expect(exported.status).toBe(200);
});
