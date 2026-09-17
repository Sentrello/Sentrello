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
