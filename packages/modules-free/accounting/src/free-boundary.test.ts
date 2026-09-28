import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest } from "@sentrello/module-sdk";
import accounting from "./index";

/**
 * What a business had before a licence, it keeps.
 *
 * `pro.ts` is gone — the paid half of Accounting is a bundle in another
 * repository now, and nothing in this package can prove it still answers.
 * What this package can and must prove is its own half: a Free instance,
 * with no bundle loaded at all, still has its accounts, its money in and
 * out, its journal and its two statements.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(accounting, undefined, () => false);

let orgId: string;
let headers: Headers;
const email = `accounting-free-${suffix}@example.test`;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Accounting Free ${suffix}`, slug: `acc-free-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (user) {
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
});

test("the Free half still answers on a Free instance", async () => {
  for (const path of [
    "/api/accounts",
    "/api/transactions",
    "/api/journal",
    "/api/reports/profit-and-loss",
    "/api/reports/balance-sheet",
  ]) {
    const res = await app.request(`http://localhost${path}`, { headers });
    expect(res.status).toBe(200);
  }
});
