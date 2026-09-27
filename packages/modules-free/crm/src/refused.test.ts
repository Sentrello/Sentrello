import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

/**
 * A write the database refused, answered as the mistake it is.
 *
 * The generic CRUD writes the caller's body and the organization id and
 * nothing else, so a missing required column, a number too large for its
 * field or a word where a number belongs are all the caller's. Every one of
 * them used to be a 500 and "something went wrong": `POST /api/tasks` with
 * no title said the software had broken rather than what was missing.
 *
 * Scoped to this wrapper on purpose. The same violation elsewhere could be
 * our own bug, which is why it is not answered globally.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();
let orgId: string;
let headers: Headers;

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
    registerAccountSection: () => {},
    registerSearch: () => {},
    registerPersonalData: () => {},
    registerOnboarding: () => {},
    registerCrawlable: () => {},
    provide: () => {},
    registerJob: () => {},
  } as never);

  const signUp = await signUpAsOwner({
    email: `refused-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Refused",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Refused ${suffix}`, slug: `refused-${suffix}` },
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
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

const post = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

test("a missing required field is named, not crashed on", async () => {
  const res = await post("/api/tasks", {});
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: string };
  // The column Postgres refused, so somebody can act on it.
  expect(body.error).toContain("title");
  expect(body.error).toContain("required");
});

test("a word where a number belongs is a sentence, not a crash", async () => {
  const res = await post("/api/deals", { name: "Roof", amountCents: "lots" });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/not the right kind/i);
});

test("a number too large for its field says so", async () => {
  const res = await post("/api/deals", {
    name: "Roof",
    amountCents: Number.MAX_SAFE_INTEGER,
  });
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/larger than/i);
});

const patch = (path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(body),
  });

/**
 * A change is the same story, and had two faults of its own.
 *
 * Drizzle silently drops keys the table does not know, so a change made
 * entirely of fields the record has not got built `update "tasks" set  where
 * …` — malformed SQL rather than a query. And a string sent to any timestamp
 * column that nobody had added to a hand-kept list reached Drizzle's
 * `value.toISOString()`, which is a TypeError before the database is asked
 * anything at all.
 */
test("a change with nothing the record has says so", async () => {
  const made = await post("/api/tasks", { title: `Probe ${suffix}` });
  const { task } = (await made.json()) as { task: { id: string } };
  try {
    const res = await patch(`/api/tasks/${task.id}`, { amountCents: 5 });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/nothing here/i);
  } finally {
    await db.delete(schema.tasks).where(eq(schema.tasks.id, task.id));
  }
});

test("a string where a moment belongs is named, on any timestamp column", async () => {
  const made = await post("/api/contacts", { name: `Probe ${suffix}` });
  const { contact } = (await made.json()) as { contact: { id: string } };
  try {
    // `createdAt` was on no list, which is how it reached Drizzle and threw.
    const res = await patch(`/api/contacts/${contact.id}`, {
      createdAt: "not-a-date",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("createdAt");
  } finally {
    await db.delete(schema.contacts).where(eq(schema.contacts.id, contact.id));
  }
});

test("and an ordinary create still works", async () => {
  const res = await post("/api/deals", {
    name: `Real ${suffix}`,
    stage: "opportunity",
  });
  expect(res.status).toBe(201);
  const { deal } = (await res.json()) as { deal: { id: string } };
  await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
});
