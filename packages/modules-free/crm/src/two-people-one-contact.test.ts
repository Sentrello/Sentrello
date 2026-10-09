/**
 * Two people with the same record open, on the CRM side.
 *
 * Invoicing answered this in May and the CRM did not, which made the shape of
 * the loss worse here than there: a contact is the record two people are most
 * likely to be editing at once, because everybody in the business has a reason
 * to touch it. Sales corrects the phone number, accounts corrects the billing
 * address, and whoever saves second quietly deletes the other's work. Both get
 * a 200. Neither is told.
 *
 * One case per resource the CRUD generator serves, because the generator is
 * one function and a guard inside it is either on for all of them or on for
 * none — and that is exactly the assumption worth measuring rather than
 * assuming.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

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
    email: `moved-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Moved",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Moved ${suffix}`, slug: `moved-${suffix}` },
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

const send = (method: string, path: string, body: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });

/**
 * Every resource the generator serves that keeps a modification time, with the
 * one field each of them is edited through.
 */
const RESOURCES = [
  {
    path: "contacts",
    singular: "contact",
    field: "name",
    make: async () => ({ name: "Ruth Adeyemi" }),
  },
  {
    path: "companies",
    singular: "company",
    field: "name",
    make: async () => ({ name: "Okonjo Roofing" }),
  },
  {
    path: "deals",
    singular: "deal",
    field: "name",
    make: async () => ({ name: "Flat roof" }),
  },
  {
    path: "tasks",
    singular: "task",
    field: "title",
    make: async () => ({ title: "Call Ruth" }),
  },
  {
    path: "notes",
    singular: "note",
    field: "text",
    // A note is always about something, so it needs one of the above first.
    make: async () => {
      const made = await send("POST", "/api/contacts", { name: "Subject" });
      const contact = (await made.json()).contact as { id: string };
      return {
        entityType: "contact",
        entityId: contact.id,
        text: "Rang, no answer",
      };
    },
  },
] as const;

for (const { path, singular, field, make } of RESOURCES) {
  /** The row as created, with the version the first person is holding. */
  async function create() {
    const made = await send("POST", `/api/${path}`, await make());
    expect(made.status).toBe(201);
    const row = (await made.json())[singular] as {
      id: string;
      updatedAt: string;
    };
    expect(row.updatedAt).toBeTruthy();
    return row;
  }

  test(`a stale save on a ${singular} is refused rather than applied`, async () => {
    const row = await create();

    // Somebody else saves first, so the version the first person is holding is
    // no longer the version on the row.
    const theirs = await send("PATCH", `/api/${path}/${row.id}`, {
      [field]: "Theirs",
    });
    expect(theirs.status).toBe(200);

    const stale = await send("PATCH", `/api/${path}/${row.id}`, {
      [field]: "Mine",
      expectedUpdatedAt: row.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toMatch(/Somebody else changed this/);

    // And nothing of theirs was lost on the way to being told. Read from the
    // table rather than back through the API, because being told is only worth
    // anything if the row really is still theirs.
    const table = schema[path] as typeof schema.contacts;
    const [after] = await db.select().from(table).where(eq(table.id, row.id));
    expect((after as unknown as Record<string, unknown>)[field]).toBe("Theirs");
  });

  /*
   * Five saves of one version together: one lands. The version was read
   * without a lock and written by id, so all five passed and the last won.
   */
  test(`five saves of one ${singular} version at once: one lands`, async () => {
    const row = await create();
    const answers = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        send("PATCH", `/api/${path}/${row.id}`, {
          [field]: `Person ${i}`,
          expectedUpdatedAt: row.updatedAt,
        }),
      ),
    );
    expect(answers.map((r) => r.status).sort()).toEqual([
      200, 409, 409, 409, 409,
    ]);
  });

  test(`a save on a ${singular} that claims the current version is applied`, async () => {
    const row = await create();
    const res = await send("PATCH", `/api/${path}/${row.id}`, {
      [field]: "Agreed",
      expectedUpdatedAt: row.updatedAt,
    });
    expect(res.status).toBe(200);
    const saved = (await res.json())[singular] as Record<string, unknown>;
    expect(saved[field]).toBe("Agreed");
    // The claim is a question about the row, not a column of it.
    expect(saved.expectedUpdatedAt).toBeUndefined();
  });
}

test("a caller that claims no version keeps the behaviour it had", async () => {
  const made = await send("POST", "/api/contacts", { name: "Script" });
  const row = (await made.json()).contact as { id: string; updatedAt: string };
  await send("PATCH", `/api/contacts/${row.id}`, { name: "Someone else" });

  // An integration written before any of this existed, saving against a
  // version it never read. It is not refused, because refusing it would be a
  // breaking change nobody asked for.
  const res = await send("PATCH", `/api/contacts/${row.id}`, {
    name: "Script",
  });
  expect(res.status).toBe(200);
});

test("a tag cannot be asked a question it does not keep the answer to", async () => {
  const made = await send("POST", "/api/tags", { name: `t-${suffix}` });
  expect(made.status).toBe(201);
  const tag = (await made.json()).tag as { id: string };

  const res = await send("PATCH", `/api/tags/${tag.id}`, {
    name: `u-${suffix}`,
    expectedUpdatedAt: new Date().toISOString(),
  });
  // Silently ignoring it would be worse than refusing: the request would look
  // protected, answer 200, and have been checked against nothing.
  expect(res.status).toBe(400);
  expect((await res.json()).error).toMatch(/modification time/);
});

/**
 * A claim nobody can read, which the first version of this ignored.
 *
 * `movedSince` answered "has it moved: yes or no", so a claim it could not
 * parse — a millisecond timestamp, an object, a date that is not one — came back
 * no and the write went through. The request looked protected, answered 200, and
 * had been checked against nothing: the same silence this whole mechanism exists
 * to remove, inside the mechanism. Found by sending wrong shapes at a running
 * instance, which is the only way it would ever have shown up.
 */
const UNREADABLE: unknown[] = [
  // The mistake somebody actually makes: the stamp as a number.
  1762440000000,
  { at: "2026-10-06T00:00:00.000Z" },
  ["2026-10-06T00:00:00.000Z"],
  "not a date",
  "",
  "   ",
  "2026-13-45T99:99:99Z",
  true,
];

for (const claimed of UNREADABLE) {
  test(`a claim of ${JSON.stringify(claimed)} is answered, not ignored`, async () => {
    const made = await send("POST", "/api/contacts", { name: "Shapes" });
    const row = (await made.json()).contact as { id: string };

    const res = await send("PATCH", `/api/contacts/${row.id}`, {
      name: "Mine",
      expectedUpdatedAt: claimed,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/expectedUpdatedAt/);

    // And nothing was written, which is the half that matters.
    const [after] = await db
      .select({ name: schema.contacts.name })
      .from(schema.contacts)
      .where(eq(schema.contacts.id, row.id));
    expect(after?.name).toBe("Shapes");
  });
}

/**
 * Null is asking nothing rather than asking badly.
 *
 * A caller that holds no version and serialises that as null — a new record, a
 * form field never filled — is in the same position as one that never heard of
 * this, and gets the behaviour it had.
 */
test("a null claim is no claim", async () => {
  const made = await send("POST", "/api/contacts", { name: "Null" });
  const row = (await made.json()).contact as { id: string };
  await send("PATCH", `/api/contacts/${row.id}`, { name: "Someone else" });

  const res = await send("PATCH", `/api/contacts/${row.id}`, {
    name: "Mine",
    expectedUpdatedAt: null,
  });
  expect(res.status).toBe(200);
});
