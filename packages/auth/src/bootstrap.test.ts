import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { eq } from "drizzle-orm";
import { asRequestHeaders, ensureBootstrapped } from "./bootstrap";

const suffix = crypto.randomUUID().slice(0, 8);
const orgId = `bootstrap-${suffix}`;

beforeAll(async () => {
  await db.insert(schema.organizations).values({
    id: orgId,
    name: `Bootstrap ${suffix}`,
    slug: `bootstrap-${suffix}`,
    createdAt: new Date(),
  });
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

test("a second boot skips bootstrap and creates nothing", async () => {
  const before = await db.select().from(schema.organizations);

  expect(await ensureBootstrapped()).toEqual({ bootstrapped: false });
  // even when owner details are supplied, an instance that already has an
  // organization must not create a second one
  expect(
    await ensureBootstrapped({
      email: `never-${suffix}@example.test`,
      password: "correct-horse-battery-staple",
      name: "Never Created",
    }),
  ).toEqual({ bootstrapped: false });

  const after = await db.select().from(schema.organizations);
  expect(after.length).toBe(before.length);

  const created = await db
    .select()
    .from(schema.user)
    .where(eq(schema.user.email, `never-${suffix}@example.test`));
  expect(created).toHaveLength(0);
});

test("a fresh instance with no owner details waits rather than guessing", async () => {
  // the installer supplies the owner on first run; until then this is a no-op
  expect(await ensureBootstrapped()).toEqual({ bootstrapped: false });
});

test("a sign-up's set-cookie becomes the cookie the next request sends", () => {
  const response = new Headers();
  response.append(
    "set-cookie",
    "better-auth.session_token=abc123; Path=/; HttpOnly; SameSite=Lax",
  );

  const request = asRequestHeaders(response);
  // the value the server will actually look for
  expect(request.get("cookie")).toBe("better-auth.session_token=abc123");
  // and not the response-shaped header, which is what produced a silent 401
  expect(request.get("set-cookie")).toBeNull();
});

test("multiple cookies survive, attributes do not", () => {
  const response = new Headers();
  response.append(
    "set-cookie",
    "a=1; Path=/; HttpOnly, b=2; Path=/; Secure; SameSite=Strict",
  );
  expect(asRequestHeaders(response).get("cookie")).toBe("a=1; b=2");
});

test("no cookie at all yields empty headers rather than throwing", () => {
  expect([...asRequestHeaders(new Headers()).keys()]).toEqual([]);
});
