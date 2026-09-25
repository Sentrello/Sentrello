import { afterEach, beforeEach, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { registerForTest, resetRateLimits } from "@sentrello/module-sdk";
import { Hono } from "hono";
import { registerBootstrapRoutes } from "./bootstrap";

/**
 * Claiming an instance is the most valuable thing that can happen on it —
 * whoever does it becomes the owner — and between the installer finishing and
 * the owner creating their account it is reachable by anyone who knows the
 * address.
 *
 * The token closes that window, and the limit stops it being guessed. Better
 * Auth rate-limits its own sign-in routes; this one is ours.
 *
 * ## Why this is `.alone.ts` and not `.test.ts`
 *
 * Every test here needs the instance to be *unclaimed*, and `needsBootstrap()`
 * answers that by asking whether the organizations table is empty — the whole
 * table, because one instance holds one organization. The suite has 247 files
 * sharing one database and Bun runs them at the same time, so "no organization
 * exists anywhere" was true only when nothing else happened to be mid-test.
 *
 * It failed about one run in four, and always on the claimed check swallowing
 * the one being made: somebody else's organization made the route answer 409,
 * so the test asking whether a stranger is refused never reached the token at
 * all. Measured at five failures out of five when run beside a single file
 * that makes an organization, and zero out of five when run on its own.
 *
 * That is not flakiness worth retrying past. These five tests cover the most
 * valuable operation on an instance — whoever claims it owns it — and a gate
 * that is random is a gate that gets ignored, then removed.
 *
 * So the name keeps it out of `bun test`'s glob — Bun looks for `.test` or
 * `.spec` in a filename — and `verify.sh` runs it by path, once the rest of
 * the suite has finished and the leftovers check has proved the table empty.
 * The `./` matters: without it Bun reads the argument as a name filter, finds
 * nothing, and says so rather than passing quietly. Nothing else needs this: `boot.test.ts` is the only
 * other file that touches bootstrap, and it passes beside an organization.
 */

const app = new Hono();
registerBootstrapRoutes(app as never);

const claim = (body: Record<string, unknown>) =>
  app.request("http://localhost/api/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const owner = {
  email: "owner@claim.test",
  password: "correct-horse-battery-staple",
  name: "Owner",
  organizationName: "Claim Ltd",
};

async function wipe() {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, owner.email));
  if (u) {
    await db.delete(schema.member).where(eq(schema.member.userId, u.id));
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.slug, "claim-ltd"));
}

beforeEach(async () => {
  await wipe();
  resetRateLimits();
  process.env.SENTRELLO_SETUP_TOKEN = "the-real-setup-token";
});

afterEach(async () => {
  await wipe();
  process.env.SENTRELLO_SETUP_TOKEN = undefined;
});

test("a stranger with no token cannot claim the instance", async () => {
  const res = await claim(owner);
  expect(res.status).toBe(403);

  const users = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, owner.email));
  expect(users).toHaveLength(0);
});

test("guessing the token is refused and then throttled", async () => {
  const codes: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    const res = await claim({ ...owner, setupToken: `guess-${i}` });
    codes.push(res.status);
  }
  expect(codes.slice(0, 5)).toEqual([403, 403, 403, 403, 403]);
  // Five is generous for a once-ever act and leaves no room for a list.
  expect(codes.slice(5)).toEqual([429, 429, 429]);
});

test("the person who installed it can still claim it", async () => {
  const res = await claim({ ...owner, setupToken: "the-real-setup-token" });
  expect(res.status).toBe(201);
});

test("nobody can claim it twice, token or not", async () => {
  expect(
    (await claim({ ...owner, setupToken: "the-real-setup-token" })).status,
  ).toBe(201);

  const again = await claim({
    ...owner,
    email: "attacker@evil.test",
    setupToken: "the-real-setup-token",
  });
  expect(again.status).toBe(409);
});

test("an instance with no token configured is still claimable", async () => {
  // Someone running it on a laptop, or behind a private network, should not
  // be forced through a token they never set.
  process.env.SENTRELLO_SETUP_TOKEN = undefined;
  const res = await claim(owner);
  expect(res.status).toBe(201);
});
