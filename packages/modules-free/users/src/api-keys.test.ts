import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { hashApiKey, newApiKey } from "@sentrello/auth/api-keys";
import { memberWith, signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import { registerForTest } from "@sentrello/module-sdk";
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
  headers.set("authorization", "Bearer eyJhbGciOiJSUzI1NiJ9.proxy.token");
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
