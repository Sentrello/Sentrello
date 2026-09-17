import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dropOrganization, dropUsers } from "@sentrello/db/testing";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { and, eq, isNotNull } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";

/**
 * Deleting a record takes what was only ever about it.
 *
 * The one that matters is the task: it carries a due date and an organization,
 * which is the shape every sweep in the platform reads across all of them. A
 * task about a customer the CRM can no longer show is a reminder somebody is
 * still sent, for a person nobody can look up.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-cascade-${suffix}@example.test`;
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
  });

  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Cascade ${suffix}`, slug: `cascade-${suffix}` },
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
  await dropOrganization(orgId);
  await dropUsers(email);
});

async function create(path: string, body: Record<string, unknown>) {
  const res = await app.request(`http://localhost/api/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status >= 400) {
    throw new Error(`creating a ${path} answered ${res.status}`);
  }
  const json = (await res.json()) as Record<string, { id: string }>;
  return Object.values(json)[0]?.id as string;
}

/** Tasks in this organization that still carry a due date. */
async function duedTasks() {
  return db
    .select({ id: schema.tasks.id, title: schema.tasks.title })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.organizationId, orgId),
        isNotNull(schema.tasks.dueAt),
      ),
    );
}

test("deleting a contact takes its tasks, notes and activities with it", async () => {
  const contactId = await create("contacts", { name: `Dave ${suffix}` });
  await create("tasks", {
    title: "Call Dave about the leak",
    contactId,
    dueAt: new Date().toISOString(),
  });
  await create("notes", {
    entityType: "contact",
    entityId: contactId,
    text: "He rang about the leak",
  });
  await create("activities", { type: "call", contactId, body: "Rang him" });

  expect((await duedTasks()).length).toBe(1);

  const res = await app.request(`http://localhost/api/contacts/${contactId}`, {
    method: "DELETE",
    headers,
  });
  expect(res.status).toBe(200);

  expect(await duedTasks()).toEqual([]);
  const notes = await db
    .select({ id: schema.notes.id })
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.organizationId, orgId),
        eq(schema.notes.entityId, contactId),
      ),
    );
  expect(notes).toEqual([]);
  const activities = await db
    .select({ id: schema.activities.id })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.organizationId, orgId),
        eq(schema.activities.contactId, contactId),
      ),
    );
  expect(activities).toEqual([]);
});

test("deleting a deal takes the tasks that were about it", async () => {
  const dealId = await create("deals", { name: `The job ${suffix}` });
  await create("tasks", {
    title: "Send the revised figure",
    dealId,
    dueAt: new Date().toISOString(),
  });
  expect((await duedTasks()).length).toBe(1);

  const res = await app.request(`http://localhost/api/deals/${dealId}`, {
    method: "DELETE",
    headers,
  });
  expect(res.status).toBe(200);
  expect(await duedTasks()).toEqual([]);
});

test("a company with people on it is not deletable", async () => {
  const companyId = await create("companies", { name: `Acme ${suffix}` });
  const contactId = await create("contacts", {
    name: `Staff ${suffix}`,
    companyId,
  });

  const refused = await app.request(
    `http://localhost/api/companies/${companyId}`,
    { method: "DELETE", headers },
  );
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({
    error: expect.stringContaining("1 contact"),
  });

  // Moved out of the way, it goes — and takes its own tasks with it.
  await app.request(`http://localhost/api/contacts/${contactId}`, {
    method: "DELETE",
    headers,
  });
  await create("tasks", {
    title: "Renew the retainer",
    companyId,
    dueAt: new Date().toISOString(),
  });
  const gone = await app.request(
    `http://localhost/api/companies/${companyId}`,
    { method: "DELETE", headers },
  );
  expect(gone.status).toBe(200);
  expect(await duedTasks()).toEqual([]);
});

/**
 * Putting one back needs what went with it, and the trail is gone by then.
 *
 * The delete takes the notes, calls, follow-ups and tag links in its own
 * transaction — which is right, and which commits before anything reads the
 * change feed. Anything that restores a deleted record therefore cannot go
 * looking for them afterwards: there is nothing left to find. So the delete
 * says what it took, on the event, and a restore is a matter of reading it.
 *
 * Without that the paid tier's thirty-day restore brings a contact back bare —
 * no notes, no calls, no follow-ups, no tags — and says nothing about it,
 * which is a worse promise than not offering a restore at all.
 */

/** The stored row, ready to go back into its table. Dates come back as text. */
function rehydrate(table: unknown, stored: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(
    table as Record<string, { dataType?: string }>,
  )) {
    if (!column?.dataType) continue;
    const value = stored[key];
    if (value === undefined) continue;
    out[key] =
      column.dataType === "date" && typeof value === "string"
        ? new Date(value)
        : value;
  }
  return out;
}

async function deletedEvent(entityId: string) {
  const [event] = await db
    .select()
    .from(schema.recordEvents)
    .where(
      and(
        eq(schema.recordEvents.organizationId, orgId),
        eq(schema.recordEvents.entityId, entityId),
        eq(schema.recordEvents.action, "deleted"),
      ),
    );
  return event;
}

test("a deleted contact comes back with its notes, calls, tasks and tags", async () => {
  const contactId = await create("contacts", { name: `Restorable ${suffix}` });
  const tagId = await create("tags", { name: `Leaky ${suffix}` });
  await create("tasks", {
    title: "Ring back about the boiler",
    contactId,
    dueAt: new Date().toISOString(),
  });
  await create("notes", {
    entityType: "contact",
    entityId: contactId,
    text: "Prefers the afternoon",
  });
  await create("activities", {
    type: "call",
    contactId,
    body: "Spoke for ten minutes",
  });
  await db.insert(schema.taggables).values({
    tagId,
    entityType: "contact",
    entityId: contactId,
  });

  const res = await app.request(`http://localhost/api/contacts/${contactId}`, {
    method: "DELETE",
    headers,
  });
  expect(res.status).toBe(200);

  // Everything went, which is the property the delete is there for.
  expect(await duedTasks()).toEqual([]);

  // And the event says what went, whole, because nothing can look it up now.
  const event = await deletedEvent(contactId);
  if (!event) throw new Error("the deletion was not announced");
  const related = event.related;
  if (!related)
    throw new Error("the deletion took the trail and did not say so");
  expect(related.notes).toHaveLength(1);
  expect(related.activities).toHaveLength(1);
  expect(related.tasks).toHaveLength(1);
  expect(related.taggables).toHaveLength(1);
  expect(related.notes?.[0]?.text).toBe("Prefers the afternoon");
  expect(related.tasks?.[0]?.title).toBe("Ring back about the boiler");
  expect(related.activities?.[0]?.body).toBe("Spoke for ten minutes");

  // A restore is then a matter of reading it back.
  await db
    .insert(schema.contacts)
    .values(rehydrate(schema.contacts, event.before ?? {}) as never);
  for (const [name, rows] of Object.entries(related)) {
    const table = (schema as unknown as Record<string, unknown>)[name];
    if (!table || !rows.length)
      throw new Error(`nothing to put back in ${name}`);
    await db
      .insert(table as typeof schema.notes)
      .values(rows.map((r) => rehydrate(table, r)) as never[]);
  }

  const [backTask] = await duedTasks();
  expect(backTask?.title).toBe("Ring back about the boiler");
  const [backNote] = await db
    .select({ text: schema.notes.text })
    .from(schema.notes)
    .where(
      and(
        eq(schema.notes.organizationId, orgId),
        eq(schema.notes.entityId, contactId),
      ),
    );
  expect(backNote?.text).toBe("Prefers the afternoon");
  const [backCall] = await db
    .select({ body: schema.activities.body })
    .from(schema.activities)
    .where(
      and(
        eq(schema.activities.organizationId, orgId),
        eq(schema.activities.contactId, contactId),
      ),
    );
  expect(backCall?.body).toBe("Spoke for ten minutes");
  const backTags = await db
    .select({ tagId: schema.taggables.tagId })
    .from(schema.taggables)
    .where(eq(schema.taggables.entityId, contactId));
  expect(backTags.map((t) => t.tagId)).toEqual([tagId]);

  // Put back the way it was found, so the next test starts clean.
  await app.request(`http://localhost/api/contacts/${contactId}`, {
    method: "DELETE",
    headers,
  });
});

test("a company and a deal say what went with them too", async () => {
  const companyId = await create("companies", { name: `Trail Co ${suffix}` });
  await create("tasks", {
    title: "Renew the contract",
    companyId,
    dueAt: new Date().toISOString(),
  });
  const dealId = await create("deals", { name: `Trail job ${suffix}` });
  await create("activities", { type: "call", dealId, body: "Talked figures" });

  for (const [path, id] of [
    ["companies", companyId],
    ["deals", dealId],
  ] as const) {
    const res = await app.request(`http://localhost/api/${path}/${id}`, {
      method: "DELETE",
      headers,
    });
    expect(res.status).toBe(200);
  }

  expect((await deletedEvent(companyId))?.related?.tasks).toHaveLength(1);
  expect((await deletedEvent(dealId))?.related?.activities).toHaveLength(1);
  expect(await duedTasks()).toEqual([]);
});
