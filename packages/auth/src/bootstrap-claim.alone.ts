import { afterEach, beforeEach, expect, test } from "bun:test";
import { db, eq, inArray, schema } from "@sentrello/db";
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

/**
 * Every address these tests claim with.
 *
 * In `wipe` rather than at the end of a test body, because a test body that
 * fails an assertion never reaches its own cleanup — and then the *next* run
 * sees the leftover account and fails for a reason that has nothing to do with
 * what it is asking. That cost half an hour on 8 October: two owner accounts
 * where the gate allows one, from a previous run of this file rather than from
 * the product.
 */
const addresses = [
  owner.email,
  "Owner@Claim.test",
  "attacker@evil.test",
  ...[1, 2, 3, 4, 5].map((n) => `owner${n}@claim.test`),
];

async function forget(email: string) {
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (!u) return;
  await db.delete(schema.member).where(eq(schema.member.userId, u.id));
  await db.delete(schema.session).where(eq(schema.session.userId, u.id));
  await db.delete(schema.account).where(eq(schema.account.userId, u.id));
  await db.delete(schema.user).where(eq(schema.user.id, u.id));
}

async function wipe() {
  for (const email of addresses) await forget(email);
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.slug, "claim-ltd"));
  /*
   * And the row that makes claiming happen once, or the next test inherits a
   * claimed instance and is answered by the gate rather than by what it asks.
   */
  await db.delete(schema.instanceClaim);
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

test("claiming records where the business is, and shrugs at nonsense", async () => {
  /*
   * The timezone comes from the browser doing the claiming, because an unset
   * one is not a neutral state: what day it is decides whether an invoice is
   * late and which month a figure lands in, and with nothing set the answer is
   * UTC — wrong for three of the four markets this product is sold in.
   */
  expect(
    (
      await claim({
        ...owner,
        setupToken: "the-real-setup-token",
        timezone: "America/Halifax",
      })
    ).status,
  ).toBe(201);
  const [org] = await db
    .select({ timezone: schema.organizations.timezone })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, "claim-ltd"));
  expect(org?.timezone).toBe("America/Halifax");
});

test("a timezone this server cannot resolve does not cost somebody their instance", async () => {
  const res = await claim({
    ...owner,
    setupToken: "the-real-setup-token",
    timezone: "Mars/Olympus_Mons",
  });
  expect(res.status).toBe(201);
  const [org] = await db
    .select({ timezone: schema.organizations.timezone })
    .from(schema.organizations)
    .where(eq(schema.organizations.slug, "claim-ltd"));
  expect(org?.timezone ?? null).toBeNull();
});

test("an instance with no token configured is still claimable", async () => {
  // Someone running it on a laptop, or behind a private network, should not
  // be forced through a token they never set.
  process.env.SENTRELLO_SETUP_TOKEN = undefined;
  const res = await claim(owner);
  expect(res.status).toBe(201);
});

/**
 * Claiming it twice at the same moment, which is not the same question.
 *
 * "Nobody can claim it twice" above asks it sequentially, and the check that
 * answers it is a read: `needsBootstrap()` asks whether any organization
 * exists, and everything that creates one runs after. Five claims arriving
 * together all passed that read and all answered 201, leaving five
 * organizations on an instance built for one, each with its own owner.
 * Measured on a running instance rather than reasoned about.
 *
 * What reaches it in practice is two submissions at once from whoever is
 * claiming. A stranger needs the setup token, which the installer generates —
 * so on an ordinary install this is an accident, and on one deployed without a
 * token it is a second owner the operator never sees.
 *
 * `Promise.all` is a real race here, because the handler awaits the database
 * several times and the gap between the read and the write is where every
 * extra claim got in.
 */
test("five claims at once make one business, not five", async () => {
  const token = "the-real-setup-token";
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((n) =>
      claim({
        ...owner,
        email: `owner${n}@claim.test`,
        organizationName: "Claim Ltd",
        setupToken: token,
      }),
    ),
  );
  const codes = results.map((r) => r.status).sort();
  expect(codes.filter((c) => c === 201)).toHaveLength(1);
  expect(codes.filter((c) => c === 409)).toHaveLength(4);

  const orgs = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations);
  expect(orgs).toHaveLength(1);

  /*
   * And one owner account, not five with one of them holding the business.
   *
   * Counted among the five addresses rather than over the table: the whole
   * suite shares one database and leaves twenty thousand users in it, so
   * "exactly one user exists" is a different and untrue claim. The
   * organizations assertion above can be absolute because `verify.sh` runs
   * this file only once the leftovers check has proved that table empty.
   */
  const made = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(
      inArray(
        schema.user.email,
        [1, 2, 3, 4, 5].map((n) => `owner${n}@claim.test`),
      ),
    );
  expect(made).toHaveLength(1);
});

/**
 * And the same claim five times at once, which is the double-pressed button.
 *
 * Different from the test above in the one way that matters: the claim row
 * lets the same address back in, so a retry can finish a claim that fell over.
 * Five copies of one submission all pass that door together. What holds them
 * to one business is the slug, unique in the database, so the losers fall
 * over at the organization and the winner keeps the instance.
 */
test("five identical claims at once make one business and one owner", async () => {
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map(() =>
      claim({ ...owner, setupToken: "the-real-setup-token" }),
    ),
  );
  expect(results.filter((r) => r.status === 201)).toHaveLength(1);

  const orgs = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations);
  expect(orgs).toHaveLength(1);
  const owners = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, owner.email));
  expect(owners).toHaveLength(1);
  const members = await db
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(eq(schema.member.organizationId, orgs[0]?.id ?? ""));
  expect(members).toHaveLength(1);
}, 30_000);

/**
 * And a claim that fell over part-way is still the same operator's to finish.
 *
 * Claiming is two steps — an account, then an organization — so a failure
 * between them leaves the instance unclaimed with the account already made.
 * The gate must not turn that into an instance nobody can claim, and must not
 * hand it to the next person who asks.
 */
test("a half-finished claim is recoverable by its owner and nobody else", async () => {
  await db.delete(schema.instanceClaim);
  await db
    .insert(schema.instanceClaim)
    .values({ id: 1, email: "owner@claim.test" });

  const stranger = await claim({
    ...owner,
    email: "attacker@evil.test",
    setupToken: "the-real-setup-token",
  });
  expect(stranger.status).toBe(409);

  // However they typed it the second time.
  const theirs = await claim({
    ...owner,
    email: "Owner@Claim.test",
    setupToken: "the-real-setup-token",
  });
  expect(theirs.status).toBe(201);

  const orgs = await db
    .select({ id: schema.organizations.id })
    .from(schema.organizations);
  expect(orgs).toHaveLength(1);
});
