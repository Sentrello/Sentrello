import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { hashApiKey, newApiKey } from "@sentrello/auth/api-keys";
import { requirePermission, requireSession } from "@sentrello/auth/hono";
import { memberWith, signUpAsOwner } from "@sentrello/auth/testing";
import { and, asActor, db, eq, isNull, schema } from "@sentrello/db";
import { recordChanged } from "@sentrello/db/record-events";
import { verifyChain } from "@sentrello/db/security-events";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
import { revokeKeysOf } from "./api-keys";
import usersModule from "./index";

/**
 * Keys for scripts, end to end through the routes a key would really call.
 *
 * The properties that matter are the ones a key must never break: it is never
 * wider than whoever made it, it never reaches another business, it stops when
 * it is revoked or its day has passed, and the key itself is never written
 * down anywhere.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = registerForTest(usersModule);

/*
 * Two routes that share a path, the first acting on whoever is signed in and
 * the second naming a permission. Hono matches both for `/me` and runs only
 * the first, so a key must be judged by the route that runs. Registered here
 * because the router is built on the first request and takes no more after.
 */
app.get("/api/keys-probe/me", requireSession(), (c) =>
  c.json({ reached: "me" }),
);
app.get(
  "/api/keys-probe/:id",
  requireSession(),
  requirePermission({ settings: ["read"] }),
  (c) => c.json({ reached: c.req.param("id") }),
);

let orgA: string;
let orgB: string;
let ownerA: Headers;
let ownerAId: string;
let groupB: string;

async function business(name: string) {
  const signUp = await signUpAsOwner({
    email: `keys-${name}-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: `${name} owner`,
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `Keys ${name} ${suffix}`, slug: `keys-${name}-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return { headers, orgId: org.id, userId: signUp.response.user.id };
}

const bearer = (key: string) =>
  new Headers({
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  });

async function makeKey(
  headers: Headers,
  body: Record<string, unknown>,
): Promise<Response> {
  return app.request("/api/users/api-keys", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const a = await business("a");
  ownerA = a.headers;
  orgA = a.orgId;
  ownerAId = a.userId;
  const b = await business("b");
  orgB = b.orgId;
  const [group] = await db
    .insert(schema.userGroups)
    .values({ organizationId: orgB, name: `B only ${suffix}` })
    .returning();
  groupB = group?.id ?? "";
});

afterAll(async () => {
  await dropOrganization(orgA, orgB);
});

test("made, used, revoked, and then refused", async () => {
  const made = await makeKey(ownerA, {
    name: "Reader",
    permissions: { settings: ["read"] },
  });
  expect(made.status).toBe(201);
  const { key, apiKey } = (await made.json()) as {
    key: string;
    apiKey: { id: string; prefix: string };
  };
  expect(key.startsWith(apiKey.prefix)).toBe(true);

  const used = await app.request("/api/users/groups", {
    headers: bearer(key),
  });
  expect(used.status).toBe(200);

  // Its own permissions, not its maker's: the owner may list keys, the key
  // carrying only settings:read may not.
  const wider = await app.request("/api/users/api-keys", {
    headers: bearer(key),
  });
  expect(wider.status).toBe(403);

  const [row] = await db
    .select({ lastUsedAt: schema.apiKeys.lastUsedAt })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, apiKey.id));
  expect(row?.lastUsedAt).not.toBeNull();

  const revoked = await app.request(`/api/users/api-keys/${apiKey.id}`, {
    method: "DELETE",
    headers: ownerA,
  });
  expect(revoked.status).toBe(200);

  const after = await app.request("/api/users/groups", {
    headers: bearer(key),
  });
  expect(after.status).toBe(401);

  const events = await db
    .select({ action: schema.securityEvents.action })
    .from(schema.securityEvents)
    .where(eq(schema.securityEvents.organizationId, orgA));
  const actions = events.map((e) => e.action);
  expect(actions).toContain("api-key.created");
  expect(actions).toContain("api-key.revoked");
});

test("the key itself is never stored, only its hash", async () => {
  const made = await makeKey(ownerA, {
    name: "Stored",
    permissions: { settings: ["read"] },
  });
  const { key, apiKey } = (await made.json()) as {
    key: string;
    apiKey: { id: string };
  };
  const [row] = await db
    .select()
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, apiKey.id));
  expect(row?.tokenHash).toBe(hashApiKey(key));
  expect(JSON.stringify(row)).not.toContain(key);

  // And the list never hands it back.
  const list = await app.request("/api/users/api-keys", { headers: ownerA });
  expect(await list.text()).not.toContain(key);
});

test("a key cannot carry a permission its maker does not hold", async () => {
  const colleague = await memberWith({
    organizationId: orgA,
    ownerHeaders: ownerA,
    permission: { settings: ["read", "update"] },
    email: `keys-colleague-${suffix}@example.test`,
  });

  const refused = await makeKey(colleague.headers, {
    name: "Too wide",
    permissions: { settings: ["read"], crm: ["delete"] },
  });
  expect(refused.status).toBe(400);
  expect(((await refused.json()) as { error: string }).error).toContain(
    "crm: delete",
  );

  const fine = await makeKey(colleague.headers, {
    name: "Within",
    permissions: { settings: ["read"] },
  });
  expect(fine.status).toBe(201);
  const { key } = (await fine.json()) as { key: string };

  // And it narrows with its maker: take their access away and the key's
  // reach goes with it, without anybody touching the key.
  await db
    .update(schema.member)
    .set({ role: "customer", baseRole: "customer" })
    .where(eq(schema.member.userId, colleague.userId));
  const narrowed = await app.request("/api/users/groups", {
    headers: bearer(key),
  });
  expect(narrowed.status).toBe(403);
});

test("a key from one business never reads another's", async () => {
  const made = await makeKey(ownerA, {
    name: "Tenancy",
    permissions: { settings: ["read", "update"] },
  });
  const { key } = (await made.json()) as { key: string };

  const groups = await app.request("/api/users/groups", {
    headers: bearer(key),
  });
  expect(groups.status).toBe(200);
  const body = (await groups.json()) as { groups: { id: string }[] };
  expect(body.groups.some((g) => g.id === groupB)).toBe(false);

  const keys = await app.request("/api/users/api-keys", {
    headers: bearer(key),
  });
  const listed = (await keys.json()) as {
    keys: { id: string }[];
  };
  const [bKey] = await db
    .insert(schema.apiKeys)
    .values({
      organizationId: orgB,
      name: "B's",
      prefix: "sntl_b",
      tokenHash: newApiKey().hash,
      createdBy: ownerAId,
    })
    .returning({ id: schema.apiKeys.id });
  expect(listed.keys.some((k) => k.id === bKey?.id)).toBe(false);
  const revokeB = await app.request(`/api/users/api-keys/${bKey?.id}`, {
    method: "DELETE",
    headers: ownerA,
  });
  expect(revokeB.status).toBe(404);
});

test("a key past its day is refused, and works for the whole of it", async () => {
  const today = newApiKey();
  const yesterday = newApiKey();
  const now = new Date();
  const midnight = (offset: number) =>
    new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + offset,
      ),
    );
  await db.insert(schema.apiKeys).values([
    {
      organizationId: orgA,
      name: "Today",
      prefix: today.prefix,
      tokenHash: today.hash,
      permissions: { settings: ["read"] },
      createdBy: ownerAId,
      expiresOn: midnight(0),
    },
    {
      organizationId: orgA,
      name: "Yesterday",
      prefix: yesterday.prefix,
      tokenHash: yesterday.hash,
      permissions: { settings: ["read"] },
      createdBy: ownerAId,
      expiresOn: midnight(-2),
    },
  ]);

  const good = await app.request("/api/users/groups", {
    headers: bearer(today.key),
  });
  expect(good.status).toBe(200);
  const gone = await app.request("/api/users/groups", {
    headers: bearer(yesterday.key),
  });
  expect(gone.status).toBe(401);

  // And a day already gone cannot be chosen for a new key.
  const past = await makeKey(ownerA, {
    name: "Past",
    permissions: { settings: ["read"] },
    expiresOn: midnight(-2).toISOString().slice(0, 10),
  });
  expect(past.status).toBe(400);
});

test("a wrong key is refused even with a session cookie beside it", async () => {
  const headers = new Headers(ownerA);
  headers.set("authorization", "Bearer sntl_not-a-real-key");
  const res = await app.request("/api/users/groups", { headers });
  expect(res.status).toBe(401);
});

test("a key reaches only routes that name a permission, and makes no keys", async () => {
  const made = await makeKey(ownerA, {
    name: "Admin script",
    permissions: { settings: ["read", "update"] },
  });
  const { key } = (await made.json()) as { key: string };

  // Session-only: acts on whoever is signed in, which for a key is its maker.
  const me = await app.request("/api/users/me/security", {
    headers: bearer(key),
  });
  expect(me.status).toBe(403);

  const minted = await app.request("/api/users/api-keys", {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify({
      name: "Child",
      permissions: { settings: ["read"] },
    }),
  });
  expect(minted.status).toBe(403);
});

test("a bearer token that is not ours leaves the cookie to answer", async () => {
  // An identity proxy in front of an instance can add its own bearer token to
  // every request; reading that as a wrong key would sign everybody out.
  const headers = new Headers(ownerA);
  headers.set("authorization", "Bearer issued-by-the-proxy");
  const res = await app.request("/api/users/groups", { headers });
  expect(res.status).toBe(200);
});

test("guessing keys runs out, and a good key never spends the budget", async () => {
  const made = await makeKey(ownerA, {
    name: "Busy meter",
    permissions: { settings: ["read"] },
  });
  const { key } = (await made.json()) as { key: string };
  for (let i = 0; i < 40; i++) {
    const ok = await app.request("/api/users/groups", { headers: bearer(key) });
    expect(ok.status).toBe(200);
  }

  const statuses: number[] = [];
  for (let i = 0; i < 31; i++) {
    const res = await app.request("/api/users/groups", {
      headers: bearer(`sntl_guess-${i}`),
    });
    statuses.push(res.status);
  }
  expect(statuses.slice(0, 30).every((s) => s === 401)).toBe(true);
  expect(statuses[30]).toBe(429);
});

test("a permission on a route that never runs lets no key through", async () => {
  const made = await makeKey(ownerA, {
    name: "Neighbour",
    permissions: { settings: ["read"] },
  });
  const { key } = (await made.json()) as { key: string };

  const named = await app.request("/api/keys-probe/abc", {
    headers: bearer(key),
  });
  expect(named.status).toBe(200);

  // `/me` also matches `/:id`, whose permission is declared but never asked:
  // the handler that answers is the session-only one.
  const me = await app.request("/api/keys-probe/me", { headers: bearer(key) });
  expect(me.status).toBe(403);
});

test("a key stops with its maker, suspended or removed", async () => {
  const maker = await memberWith({
    organizationId: orgA,
    ownerHeaders: ownerA,
    permission: { settings: ["read", "update"] },
    email: `keys-leaver-${suffix}@example.test`,
  });
  const made = await makeKey(maker.headers, {
    name: "Leaver's",
    permissions: { settings: ["read"] },
  });
  const { key } = (await made.json()) as { key: string };
  const call = () => app.request("/api/users/groups", { headers: bearer(key) });
  expect((await call()).status).toBe(200);

  const mine = eq(schema.member.userId, maker.userId);
  await db.update(schema.member).set({ disabledAt: new Date() }).where(mine);
  expect((await call()).status).toBe(401);

  await db.delete(schema.member).where(mine);
  expect((await call()).status).toBe(401);
});

test("a key cannot give itself a password to sign in with", async () => {
  // A temporary password is a way in as a person, with all of that person's
  // access — the owner's, here — and none of the key's limits.
  const made = await makeKey(ownerA, {
    name: "Settings only",
    permissions: { settings: ["read", "update"] },
  });
  const { key } = (await made.json()) as { key: string };

  const reset = await app.request(`/api/users/${ownerAId}/password`, {
    method: "POST",
    headers: bearer(key),
  });
  expect(reset.status).toBe(403);
  expect(await reset.text()).not.toContain('password":');
});

test("a key cannot open another way in as a person", async () => {
  const made = await makeKey(ownerA, {
    name: "Doors",
    permissions: { settings: ["read", "update"] },
  });
  const { key } = (await made.json()) as { key: string };

  const sso = await app.request("/api/users/sso", {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify({
      kind: "oidc",
      domain: `doors-${suffix}.example.test`,
      issuer: "https://idp.example.test",
      clientId: "id",
      clientSecret: "secret",
    }),
  });
  expect(sso.status).toBe(403);

  const invite = await app.request("/api/users/invitations", {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify({
      email: `doors-${suffix}@example.test`,
      role: "owner",
    }),
  });
  expect(invite.status).toBe(403);
});

/** A member who makes a key, and what it takes to call with it. */
async function makerWithKey(tag: string) {
  const maker = await memberWith({
    organizationId: orgA,
    ownerHeaders: ownerA,
    permission: { settings: ["read", "update"] },
    email: `keys-${tag}-${suffix}@example.test`,
  });
  const made = await makeKey(maker.headers, {
    name: `${tag}'s`,
    permissions: { settings: ["read"] },
  });
  const { key, apiKey } = (await made.json()) as {
    key: string;
    apiKey: { id: string };
  };
  const call = () => app.request("/api/users/groups", { headers: bearer(key) });
  return { maker, key, id: apiKey.id, call };
}

async function revocationOf(id: string) {
  const [row] = await db
    .select({ revokedAt: schema.apiKeys.revokedAt })
    .from(schema.apiKeys)
    .where(eq(schema.apiKeys.id, id));
  const [line] = await db
    .select({ detail: schema.securityEvents.detail })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgA),
        eq(schema.securityEvents.action, "api-key.revoked"),
        eq(schema.securityEvents.subjectId, id),
      ),
    );
  return { revokedAt: row?.revokedAt ?? null, recorded: line?.detail ?? null };
}

test("removing somebody revokes their keys, and letting them back does not revive one", async () => {
  const { maker, id, call } = await makerWithKey("removed");
  expect((await call()).status).toBe(200);

  const [membership] = await db
    .select()
    .from(schema.member)
    .where(eq(schema.member.userId, maker.userId));
  if (!membership) throw new Error("no membership");

  const removed = await app.request(`/api/users/${maker.userId}`, {
    method: "DELETE",
    headers: ownerA,
  });
  expect(removed.status).toBe(200);

  const { revokedAt, recorded } = await revocationOf(id);
  expect(revokedAt).not.toBeNull();
  expect(recorded).toMatchObject({ because: "member.removed" });

  // Back on the books, exactly as they were.
  await db.insert(schema.member).values(membership);
  expect((await call()).status).toBe(401);
});

test("suspending somebody revokes their keys, and restoring them does not revive one", async () => {
  const { maker, id, call } = await makerWithKey("suspended");
  expect((await call()).status).toBe(200);

  const suspend = (disabled: boolean) =>
    app.request(`/api/users/${maker.userId}`, {
      method: "PATCH",
      headers: ownerA,
      body: JSON.stringify({ disabled }),
    });
  expect((await suspend(true)).status).toBe(200);
  const { revokedAt, recorded } = await revocationOf(id);
  expect(revokedAt).not.toBeNull();
  expect(recorded).toMatchObject({ because: "account.disabled" });

  expect((await suspend(false)).status).toBe(200);
  expect((await call()).status).toBe(401);
});

test("what a key did is recorded as done with that key", async () => {
  const made = await makeKey(ownerA, {
    name: "Meter",
    permissions: { settings: ["read", "update"] },
  });
  const { key, apiKey } = (await made.json()) as {
    key: string;
    apiKey: { id: string };
  };

  const created = await app.request("/api/users/groups", {
    method: "POST",
    headers: bearer(key),
    body: JSON.stringify({ name: `By key ${suffix}` }),
  });
  expect(created.status).toBe(201);

  const events = await app.request("/api/users/events?action=group.created", {
    headers: ownerA,
  });
  const { events: rows } = (await events.json()) as {
    events: { actor: string; actorId: string; actorKeyId: string | null }[];
  };
  const mine = rows.find((r) => r.actorKeyId === apiKey.id);
  expect(mine?.actorId).toBe(ownerAId);
  expect(mine?.actor).toBe("a owner, with key \u2018Meter\u2019");

  // By hand, the same person reads as themselves.
  const byHand = await app.request("/api/users/groups", {
    method: "POST",
    headers: ownerA,
    body: JSON.stringify({ name: `By hand ${suffix}` }),
  });
  expect(byHand.status).toBe(201);
  const [handLine] = await db
    .select()
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgA),
        eq(schema.securityEvents.subjectName, `By hand ${suffix}`),
      ),
    );
  expect(handLine?.actorName).toBe("a owner");
  expect(handLine?.actorKeyId).toBeNull();

  // The key is part of what the chain protects, and older rows still verify.
  const verdict = await verifyChain(orgA);
  expect(verdict.problems).toEqual([]);

  // The change feed says the same.
  const entityId = crypto.randomUUID();
  await asActor(
    ownerAId,
    () =>
      recordChanged({
        organizationId: orgA,
        entity: "probe",
        entityId,
        action: "created",
      }),
    { id: apiKey.id, name: "Meter" },
  );
  const [change] = await db
    .select()
    .from(schema.recordEvents)
    .where(eq(schema.recordEvents.entityId, entityId));
  expect(change?.actorId).toBe(ownerAId);
  expect(change?.actorKeyId).toBe(apiKey.id);
});

test("guessing keys is budgeted per /64 on IPv6, not per address", async () => {
  const from = (ip: string, i: number) => {
    const headers = bearer(`sntl_v6-guess-${i}`);
    headers.set("x-real-ip", ip);
    return app.request("/api/users/groups", { headers });
  };
  // Thirty addresses, all inside one /64: one caller.
  for (let i = 0; i < 30; i++) {
    expect(
      (await from(`2001:db8:77:1::${(i + 1).toString(16)}`, i)).status,
    ).toBe(401);
  }
  expect((await from("2001:db8:77:1:ffff::9", 30)).status).toBe(429);
  // The next /64 is somebody else.
  expect((await from("2001:db8:77:2::1", 31)).status).toBe(401);
});

/**
 * A key made while its maker is being suspended does not outlive the
 * suspension.
 *
 * Suspending somebody revokes every key they made, inside the transaction that
 * suspends them. A key made in the same moment was checked against the
 * membership as it was before that transaction committed, and written after
 * its revocation sweep had already run: live, and alive again the day the
 * person is restored. The suspension is held open here so the key is made
 * exactly inside that gap, rather than hoping two requests land in it.
 */
test("a key made while its maker is being suspended is refused, not left alive", async () => {
  const maker = await memberWith({
    organizationId: orgA,
    ownerHeaders: ownerA,
    permission: { settings: ["read", "update"] },
    email: `keys-mid-suspend-${suffix}@example.test`,
  });
  const mine = and(
    eq(schema.member.organizationId, orgA),
    eq(schema.member.userId, maker.userId),
  );

  let commit = () => {};
  const held = new Promise<void>((resolve) => {
    commit = resolve;
  });
  let opened = () => {};
  const open = new Promise<void>((resolve) => {
    opened = resolve;
  });
  const suspension = db.transaction(async (tx) => {
    await tx.update(schema.member).set({ disabledAt: new Date() }).where(mine);
    await revokeKeysOf(tx, orgA, maker.userId, ownerAId);
    opened();
    await held;
  });
  await open;

  const making = makeKey(maker.headers, {
    name: "Made mid-suspension",
    permissions: { settings: ["read"] },
  });
  await Bun.sleep(500);
  commit();
  await suspension;
  const made = await making;

  const live = await db
    .select({ id: schema.apiKeys.id })
    .from(schema.apiKeys)
    .where(
      and(
        eq(schema.apiKeys.createdBy, maker.userId),
        isNull(schema.apiKeys.revokedAt),
      ),
    );
  expect(live).toEqual([]);
  expect(made.status).not.toBe(201);
}, 30_000);

test("revoking one key ten times at once revokes it once", async () => {
  const made = await makeKey(ownerA, {
    name: "Revoked at once",
    permissions: { settings: ["read"] },
  });
  const { apiKey } = (await made.json()) as { apiKey: { id: string } };
  const answers = await Promise.all(
    Array.from({ length: 10 }, () =>
      app.request(`/api/users/api-keys/${apiKey.id}`, {
        method: "DELETE",
        headers: ownerA,
      }),
    ),
  );
  expect(answers.map((a) => a.status).filter((s) => s === 200)).toHaveLength(1);
  const lines = await db
    .select({ id: schema.securityEvents.id })
    .from(schema.securityEvents)
    .where(
      and(
        eq(schema.securityEvents.organizationId, orgA),
        eq(schema.securityEvents.action, "api-key.revoked"),
        eq(schema.securityEvents.subjectId, apiKey.id),
      ),
    );
  expect(lines).toHaveLength(1);
}, 30_000);
