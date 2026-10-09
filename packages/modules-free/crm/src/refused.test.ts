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

/**
 * And the other half: a value the column would have taken.
 *
 * An object sent as a contact's `name` is *accepted* — the driver
 * stringifies it — so the record is saved as `[object Object]` and the list
 * draws it. Nothing fails. The only sign is a row in somebody's book that
 * cannot be searched for, or corrected, by name. Found by probing the API
 * with wrong shapes and then watching the screens walk fail on the mess it
 * had left behind.
 */
test("an object where text belongs is refused, not stringified", async () => {
  for (const name of [{ a: 1 }, ["a"], {}]) {
    const res = await post("/api/contacts", { name });
    expect(res.status, `${JSON.stringify(name)} was accepted`).toBe(400);
    expect((await res.json()).error).toContain("name");
  }

  // A number still reads back as what somebody meant.
  const fine = await post("/api/contacts", { name: 123 });
  expect(fine.status).toBe(201);
  const { contact } = (await fine.json()) as {
    contact: { id: string; name: string };
  };
  expect(contact.name).toBe("123");
  await db.delete(schema.contacts).where(eq(schema.contacts.id, contact.id));
});

/**
 * A list where a date belongs, which the language reads as a date.
 *
 * `String(["500"])` is "500", and "500" parses as the first of January in the
 * year 500 — so a one-element list sent as a task's due date was stored as one,
 * on every timestamp column the generic CRUD writes. Eight of them, found on a
 * fresh instance by sending nonsense at every collection and reading back what
 * moved. A list of one real day did the same thing to a plain date column.
 */
test("a list or an object where a date belongs is refused, not coerced", async () => {
  for (const dueAt of [["500"], [], {}]) {
    const res = await post("/api/tasks", { title: `Due ${suffix}`, dueAt });
    expect(res.status, `${JSON.stringify(dueAt)} was accepted`).toBe(400);
    expect((await res.json()).error).toContain("dueAt");
  }
  const res = await post("/api/deals", {
    name: `Closing ${suffix}`,
    expectedCloseOn: ["2026-11-02"],
  });
  expect(res.status, "a list of one day was accepted as the day").toBe(400);
  expect((await res.json()).error).toContain("expectedCloseOn");
});

/**
 * A list where a number belongs, read by the driver as its one element.
 *
 * `["500"]` became a deal worth $5 and a company of 500 people, on the same
 * probe that found the year 500 in the dates above. A 400 naming the field.
 */
test("a list or an object where a number belongs is refused, not unwrapped", async () => {
  const made = await post("/api/deals", { name: `Worth ${suffix}` });
  const { deal } = (await made.json()) as { deal: { id: string } };
  try {
    for (const amountCents of [["500"], [], {}]) {
      const res = await patch(`/api/deals/${deal.id}`, { amountCents });
      expect(res.status, `${JSON.stringify(amountCents)} was accepted`).toBe(
        400,
      );
      expect((await res.json()).error).toContain("amountCents");
    }
    const create = await post("/api/companies", {
      name: `Size ${suffix}`,
      size: ["500"],
    });
    expect(create.status).toBe(400);
  } finally {
    await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
  }
});

/**
 * A contact's other emails, in the shape everything that reads them expects.
 *
 * A jsonb column, so neither floor applies, and `{}` was stored as sent — the
 * export then mapped over it and failed for every contact in the book.
 */
test("other emails and phones that are not labelled values are refused", async () => {
  for (const emails of [{}, ["500"], [{ label: "Work" }]]) {
    const res = await post("/api/contacts", {
      name: `Listed ${suffix}`,
      emails,
    });
    expect(res.status, `${JSON.stringify(emails)} was accepted`).toBe(400);
    expect((await res.json()).error).toContain("emails");
  }
  const fine = await post("/api/contacts", {
    name: `Listed ${suffix}`,
    phones: [{ label: "Mobile", value: "212 555 0101" }],
  });
  expect(fine.status).toBe(201);
  const { contact } = (await fine.json()) as { contact: { id: string } };
  try {
    const res = await patch(`/api/contacts/${contact.id}`, { phones: {} });
    expect(res.status).toBe(400);
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
