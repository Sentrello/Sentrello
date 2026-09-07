import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { lockState } from "@sentrello/db/lockout";
import { auth } from "./index";
import { signUpAsOwner } from "./testing";
import { unlockForEmail } from "./unlock";

/**
 * The way back in when the lock itself is what is keeping somebody out.
 *
 * `lockState`'s own docstring names the denial of service this closes:
 * anyone who knows an address can hold it locked from one IP, and on a
 * self-hosted box that address is usually the only administrator's — the one
 * person with nobody else to ask for an unlock. This has to work without a
 * session, because a session is exactly what the lock is withholding.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `unlock-${suffix}@example.test`;

let orgId: string;
let userId: string;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Locked Out",
  });
  userId = signUp.response.user.id;
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Unlock ${suffix}`, slug: `unlock-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
});

afterAll(async () => {
  await db
    .delete(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgId));
  await db
    .delete(schema.securityPolicy)
    .where(eq(schema.securityPolicy.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await db.delete(schema.account).where(eq(schema.account.userId, userId));
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

async function failure() {
  await db.insert(schema.securityEvents).values({
    organizationId: orgId,
    action: "sign-in.failed",
    detail: { email },
  });
}

test("clears a lock without a session, the way the login route cannot", async () => {
  for (let i = 0; i < 6; i += 1) await failure();
  expect((await lockState(orgId, email)).locked).toBe(true);

  const result = await unlockForEmail(email);
  expect(result).toEqual({ ok: true });

  expect((await lockState(orgId, email)).locked).toBe(false);

  const [event] = await db
    .select()
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.action, "account.unlocked"));
  expect(event?.organizationId).toBe(orgId);
  expect(event?.detail).toEqual({ email });
});

test("an unknown address is refused without saying more", async () => {
  const result = await unlockForEmail(`nobody-${suffix}@example.test`);
  expect(result).toEqual({
    ok: false,
    reason: `no account for nobody-${suffix}@example.test`,
  });
});
