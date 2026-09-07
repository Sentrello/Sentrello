import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, inArray, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import crm, { displayName, toCsv } from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

// Attachments are written under the data directory, which defaults to /data —
// not somewhere a test may write.
process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
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
    body: { name: `CRM ${suffix}`, slug: `crm-${suffix}` },
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
  /**
   * Notes, tasks and activities as well as the contacts they hang from.
   *
   * They are keyed by organization but nothing deleted them, so a few hundred
   * accumulated across runs — invisible until another module's test asked the
   * database a question and got somebody else's rows back.
   */
  // Taggables are keyed by the tag rather than by the organization, so they go
  // with the tags they hang from.
  const tags = await db
    .select({ id: schema.tags.id })
    .from(schema.tags)
    .where(eq(schema.tags.organizationId, orgId));
  if (tags.length > 0) {
    await db.delete(schema.taggables).where(
      inArray(
        schema.taggables.tagId,
        tags.map((t) => t.id),
      ),
    );
  }

  for (const [table, column] of [
    [schema.notes, schema.notes.organizationId],
    [schema.tasks, schema.tasks.organizationId],
    [schema.activities, schema.activities.organizationId],
    [schema.tags, schema.tags.organizationId],
    [schema.deals, schema.deals.organizationId],
    [schema.companies, schema.companies.organizationId],
    [schema.contacts, schema.contacts.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

test("create returns the row under a singular key and scopes it to the org", async () => {
  const res = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Acme Ltd", email: "ap@acme.test" }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as {
    contact: { id: string; organizationId: string };
  };
  expect(body.contact.organizationId).toBe(orgId);
});

test("list returns rows under a plural key", async () => {
  const res = await app.request("http://localhost/api/contacts", { headers });
  const body = (await res.json()) as { contacts: { name: string }[] };
  expect(body.contacts.map((c) => c.name)).toContain("Acme Ltd");
});

test("a row belonging to another organization is invisible and unpatchable", async () => {
  const [foreign] = await db
    .insert(schema.contacts)
    .values({ organizationId: `other-org-${suffix}`, name: "Not Yours" })
    .returning();
  if (!foreign) throw new Error("could not create foreign contact");

  const list = await app.request("http://localhost/api/contacts", { headers });
  const body = (await list.json()) as { contacts: { id: string }[] };
  expect(body.contacts.some((c) => c.id === foreign.id)).toBe(false);

  const patch = await app.request(
    `http://localhost/api/contacts/${foreign.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ name: "Hijacked" }) },
  );
  expect(patch.status).toBe(404);

  const [after] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, foreign.id));
  expect(after?.name).toBe("Not Yours");

  await db.delete(schema.contacts).where(eq(schema.contacts.id, foreign.id));
});

test("a patch cannot move a row into another organization", async () => {
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Movable" }),
  });
  const { contact } = (await created.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ name: "Moved", organizationId: "somewhere-else" }),
  });
  expect(res.status).toBe(200);

  const [after] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact.id));
  expect(after?.organizationId).toBe(orgId);
  expect(after?.name).toBe("Moved");
});

test("delete removes only this organization's row", async () => {
  const created = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Temporary" }),
  });
  const { contact } = (await created.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "DELETE",
    headers,
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ deleted: contact.id });

  const again = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    { method: "DELETE", headers },
  );
  expect(again.status).toBe(404);
});

test("a customer with no history deletes cleanly", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Mistyped entry" })
    .returning();

  const res = await app.request(
    `http://localhost/api/contacts/${contact?.id}`,
    { method: "DELETE", headers },
  );
  expect(res.status).toBe(200);

  const rows = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, contact?.id ?? ""));
  expect(rows).toHaveLength(0);
});

/**
 * JSON has no date type, so a client can only send a string — and the column
 * is a timestamp. Drizzle handed the string to the driver, which called
 * `.toISOString()` on it and threw, so every client that sent a date got a 500
 * and no indication why.
 */
test("a date sent as a string is accepted, because that is the only way to send one", async () => {
  const contact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Date Test" }),
  });
  const { contact: c } = (await contact.json()) as { contact: { id: string } };

  const res = await app.request("http://localhost/api/activities", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId: c.id,
      type: "note",
      body: "Called about the gutters",
      occurredAt: "2026-08-13T09:30:00.000Z",
    }),
  });
  expect(res.status).toBe(201);

  const { activity } = (await res.json()) as {
    activity: { occurredAt: string };
  };
  expect(new Date(activity.occurredAt).toISOString()).toBe(
    "2026-08-13T09:30:00.000Z",
  );
});

test("a date that is not a date is refused, not a 500", async () => {
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Bad date", dueAt: "next Tuesday-ish" }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain("dueAt");
});

test("an omitted date is still omitted", async () => {
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "No due date" }),
  });
  expect(res.status).toBe(201);
});

/** A task to act on, with a due date a week out. */
async function madeTask(title: string, dueInDays = 7) {
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({
      title,
      dueAt: new Date(Date.now() + dueInDays * 86_400_000).toISOString(),
    }),
  });
  const { task } = (await res.json()) as {
    task: { id: string; dueAt: string; done: boolean };
  };
  return task;
}

test("ticking a task off records when it was done", async () => {
  const task = await madeTask("Send the engagement letter");
  expect(task.done).toBe(false);

  const res = await app.request(
    `http://localhost/api/tasks/${task.id}/complete`,
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  const [row] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id));
  expect(row?.done).toBe(true);
  // Without the timestamp a finished task cannot be read back in order, and
  // "what did we get done last week" has no answer.
  expect(row?.doneAt).not.toBeNull();
});

test("a completed task can be put back", async () => {
  // Ticked the wrong row. Without this the only way back is the database.
  const task = await madeTask("Chase the searches");
  await app.request(`http://localhost/api/tasks/${task.id}/complete`, {
    method: "POST",
    headers,
  });

  const res = await app.request(
    `http://localhost/api/tasks/${task.id}/complete`,
    { method: "POST", headers, body: JSON.stringify({ done: false }) },
  );
  expect(res.status).toBe(200);

  const [row] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id));
  expect(row?.done).toBe(false);
  expect(row?.doneAt).toBeNull();
});

test("postponing moves the due date by a day or by a week", async () => {
  const task = await madeTask("Call about the lease", 3);
  const started = new Date(task.dueAt).getTime();

  const day = await app.request(
    `http://localhost/api/tasks/${task.id}/postpone`,
    { method: "POST", headers, body: JSON.stringify({ by: "day" }) },
  );
  expect(day.status).toBe(200);

  const [afterDay] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id));
  expect(afterDay?.dueAt?.getTime()).toBe(started + 86_400_000);

  await app.request(`http://localhost/api/tasks/${task.id}/postpone`, {
    method: "POST",
    headers,
    body: JSON.stringify({ by: "week" }),
  });
  const [afterWeek] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id));
  expect(afterWeek?.dueAt?.getTime()).toBe(started + 8 * 86_400_000);
});

test("postponing a task with no due date puts one on it", async () => {
  // Otherwise the button does nothing at all, silently, which reads as broken.
  const res = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Someday" }),
  });
  const { task } = (await res.json()) as { task: { id: string } };

  await app.request(`http://localhost/api/tasks/${task.id}/postpone`, {
    method: "POST",
    headers,
    body: JSON.stringify({ by: "week" }),
  });

  const [row] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, task.id));
  expect(row?.dueAt).not.toBeNull();
});

test("postponing by something that is not a day or a week is refused", async () => {
  const task = await madeTask("Whatever");
  const res = await app.request(
    `http://localhost/api/tasks/${task.id}/postpone`,
    { method: "POST", headers, body: JSON.stringify({ by: "fortnight" }) },
  );
  expect(res.status).toBe(400);
});

test("task actions cannot reach into another organization", async () => {
  // The whole tenancy rule in one place: a task id is a uuid somebody could
  // hold, and holding it must not be enough.
  const [theirs] = await db
    .insert(schema.tasks)
    .values({
      organizationId: `not-${orgId}`,
      title: "Someone else's business",
      dueAt: new Date(),
    })
    .returning();
  if (!theirs) throw new Error("could not create the other org's task");

  for (const action of ["complete", "postpone"]) {
    const res = await app.request(
      `http://localhost/api/tasks/${theirs.id}/${action}`,
      { method: "POST", headers, body: JSON.stringify({ by: "day" }) },
    );
    expect(res.status).toBe(404);
  }

  const [untouched] = await db
    .select()
    .from(schema.tasks)
    .where(eq(schema.tasks.id, theirs.id));
  expect(untouched?.done).toBe(false);
  expect(untouched?.title).toBe("Someone else's business");

  await db.delete(schema.tasks).where(eq(schema.tasks.id, theirs.id));
});

/**
 * A task that belongs to the account rather than to a person.
 *
 * "Renew the retainer" is owed by the company. Filed against whichever contact
 * answered the phone last time, it disappears the day that person leaves.
 */
test("a task can belong to a company, and lists under that company", async () => {
  const madeCompany = async (name: string) => {
    const res = await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name }),
    });
    const { company } = (await res.json()) as { company: { id: string } };
    return company.id;
  };

  const mine = await madeCompany("Retainer Holdings");
  const theirs = await madeCompany("Somebody Else Ltd");

  const created = await app.request("http://localhost/api/tasks", {
    method: "POST",
    headers,
    body: JSON.stringify({ title: "Renew the retainer", companyId: mine }),
  });
  expect(created.status).toBe(201);
  const { task } = (await created.json()) as {
    task: { id: string; companyId: string };
  };
  expect(task.companyId).toBe(mine);

  const listed = await app.request(
    `http://localhost/api/tasks?companyId=${mine}`,
    { headers },
  );
  const { tasks } = (await listed.json()) as { tasks: { id: string }[] };
  expect(tasks.map((t) => t.id)).toContain(task.id);

  // And it does not show up under a company it has nothing to do with.
  const other = await app.request(
    `http://localhost/api/tasks?companyId=${theirs}`,
    { headers },
  );
  const elsewhere = (await other.json()) as { tasks: { id: string }[] };
  expect(elsewhere.tasks.map((t) => t.id)).not.toContain(task.id);
});

/**
 * The display name is written, not computed.
 *
 * Invoices, quotes and the customer portal select `name` directly, so an
 * invoice addressed to nobody because somebody edited a surname would surface
 * far from the CRM that caused it.
 */
test("a contact's display name follows its first and last name", () => {
  expect(displayName({ firstName: "Ada", lastName: "Lovelace" })).toBe(
    "Ada Lovelace",
  );
  expect(displayName({ firstName: "  Ada  ", lastName: "" })).toBe("Ada");
});

test("an edit that never mentions a name does not wipe it", () => {
  // Most existing contacts are a single string with no first or last name at
  // all; a PATCH changing a phone number must leave that alone.
  expect(displayName({ name: "Redwood Handyman Co." })).toBe(
    "Redwood Handyman Co.",
  );
  expect(displayName({ phone: "0117 496 0000" })).toBeUndefined();
});

/**
 * Moving a card on the kanban. Stage and position travel together because
 * dragging is one action — two calls would leave a card that changed column
 * but not order if the second failed.
 */
test("a deal moves column and position in one call", async () => {
  const created = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Roof repair", amountCents: 120_000 }),
  });
  expect(created.status).toBe(201);
  const { deal } = (await created.json()) as { deal: { id: string } };

  const moved = await app.request(
    `http://localhost/api/deals/${deal.id}/move`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ stage: "won", position: 2 }),
    },
  );
  expect(moved.status).toBe(200);
  const body = (await moved.json()) as {
    deal: { stage: string; position: number };
  };
  expect(body.deal.stage).toBe("won");
  expect(body.deal.position).toBe(2);
});

test("a move that says nothing is refused rather than silently doing nothing", async () => {
  const created = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Gutter clean" }),
  });
  const { deal } = (await created.json()) as { deal: { id: string } };

  const res = await app.request(`http://localhost/api/deals/${deal.id}/move`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(400);
});

/**
 * A contact that cannot show what it is attached to is a row in a table. This
 * endpoint is what the UI reads to stop the application looking like unrelated
 * parts.
 */
test("a contact comes back with everything it connects to", async () => {
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Ada", lastName: "Lovelace" }),
  });
  const { contact } = (await madeContact.json()) as {
    contact: { id: string; name: string };
  };
  expect(contact.name).toBe("Ada Lovelace");

  await app.request("http://localhost/api/notes", {
    method: "POST",
    headers,
    body: JSON.stringify({
      entityType: "contact",
      entityId: contact.id,
      text: "Wants a quote for the roof",
    }),
  });
  await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Roof", contactIds: [contact.id] }),
  });

  const res = await app.request(
    `http://localhost/api/contacts/${contact.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const related = (await res.json()) as {
    notes: unknown[];
    deals: { name: string }[];
  };
  expect(related.notes).toHaveLength(1);
  expect(related.deals.map((d) => d.name)).toEqual(["Roof"]);
});

test("another organisation's contact is not found", async () => {
  // The org filter is the tenant boundary; a related-records endpoint that
  // spans five tables is exactly where forgetting it would leak most.
  const res = await app.request(
    "http://localhost/api/contacts/00000000-0000-0000-0000-000000000000/related",
    { headers },
  );
  expect(res.status).toBe(404);
});

test("a deal is created with the fields the caller sent", async () => {
  // The demo seed hit a 500 here: every column inserted as its default, so the
  // NOT NULL name failed. Worth pinning the whole body rather than one field.
  const res = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Cellar damp works",
      companyId: null,
      contactIds: [],
      stage: "proposal",
      amountCents: 220_000,
      category: "Repair",
      position: 0,
    }),
  });
  expect(res.status).toBe(201);
  const { deal } = (await res.json()) as {
    deal: { name: string; stage: string; amountCents: number };
  };
  expect(deal.name).toBe("Cellar damp works");
  expect(deal.stage).toBe("proposal");
  expect(deal.amountCents).toBe(220_000);
});

/**
 * The far side of the link on a contact. A company name that opened a list of
 * every company would look like a connection and behave like a dead end.
 */
test("a company comes back with its people and its deals", async () => {
  const madeCo = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ellesmere Dental", sector: "Healthcare" }),
  });
  const { company } = (await madeCo.json()) as { company: { id: string } };

  await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Sunniva",
      lastName: "Restrepo",
      companyId: company.id,
    }),
  });
  await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Surgery 3 fit-out",
      companyId: company.id,
      amountCents: 1_150_000,
    }),
  });

  const res = await app.request(
    `http://localhost/api/companies/${company.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    contacts: { name: string }[];
    deals: { name: string }[];
  };
  expect(body.contacts.map((p) => p.name)).toEqual(["Sunniva Restrepo"]);
  expect(body.deals.map((d) => d.name)).toEqual(["Surgery 3 fit-out"]);
});

/**
 * Tags. `taggables` has no organizationId of its own — it is scoped through
 * the tag it points at, so these routes are the only thing standing between a
 * guessed id and labelling another business's records.
 */
test("a tag can be put on a contact and taken off again", async () => {
  const madeTag = await app.request("http://localhost/api/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Repeat customer", color: "#22c55e" }),
  });
  const { tag } = (await madeTag.json()) as { tag: { id: string } };

  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Vernon", lastName: "Achebe" }),
  });
  const { contact } = (await madeContact.json()) as {
    contact: { id: string };
  };

  const attached = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags`,
    { method: "POST", headers, body: JSON.stringify({ tagId: tag.id }) },
  );
  expect(attached.status).toBe(201);

  let related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: { id: string }[] };
  expect(related.tags.map((t) => t.id)).toEqual([tag.id]);

  const removed = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags/${tag.id}`,
    { method: "DELETE", headers },
  );
  expect(removed.status).toBe(204);

  related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: { id: string }[] };
  expect(related.tags).toHaveLength(0);
});

test("tagging twice does not label the record twice", async () => {
  // Somebody clicks twice. A duplicate row would show the same label on the
  // record two times over.
  const madeTag = await app.request("http://localhost/api/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Urgent" }),
  });
  const { tag } = (await madeTag.json()) as { tag: { id: string } };
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Twice", lastName: "Clicked" }),
  });
  const { contact } = (await madeContact.json()) as { contact: { id: string } };

  for (let i = 0; i < 2; i += 1) {
    await app.request(`http://localhost/api/contacts/${contact.id}/tags`, {
      method: "POST",
      headers,
      body: JSON.stringify({ tagId: tag.id }),
    });
  }

  const related = (await (
    await app.request(`http://localhost/api/contacts/${contact.id}/related`, {
      headers,
    })
  ).json()) as { tags: unknown[] };
  expect(related.tags).toHaveLength(1);
});

test("a tag that is not this organisation's cannot be attached", async () => {
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Someone", lastName: "Else" }),
  });
  const { contact } = (await madeContact.json()) as { contact: { id: string } };

  const res = await app.request(
    `http://localhost/api/contacts/${contact.id}/tags`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        tagId: "00000000-0000-0000-0000-000000000000",
      }),
    },
  );
  expect(res.status).toBe(404);
});

/**
 * The board links to a deal, so this endpoint is what stops every card being a
 * dead end — the same failure a contact's company link had before companies
 * got a screen.
 */
test("a deal comes back with its company and the people on it", async () => {
  const madeCo = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "The Brixton Tap" }),
  });
  const { company } = (await madeCo.json()) as { company: { id: string } };

  const madePerson = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Dermot", lastName: "Kavanagh" }),
  });
  const { contact } = (await madePerson.json()) as { contact: { id: string } };

  const madeDeal = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Cellar damp works",
      companyId: company.id,
      contactIds: [contact.id],
      amountCents: 220_000,
    }),
  });
  const { deal } = (await madeDeal.json()) as { deal: { id: string } };

  const res = await app.request(
    `http://localhost/api/deals/${deal.id}/related`,
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    company: { name: string } | null;
    contacts: { name: string }[];
  };
  expect(body.company?.name).toBe("The Brixton Tap");
  expect(body.contacts.map((p) => p.name)).toEqual(["Dermot Kavanagh"]);
});

test("a deal only returns the contacts actually on it", async () => {
  // Contacts are gathered in memory from a jsonb array, so the filter is the
  // thing doing the work — get it wrong and every contact appears on every
  // deal.
  await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ firstName: "Not", lastName: "Involved" }),
  });
  const madeDeal = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Nobody's deal", contactIds: [] }),
  });
  const { deal } = (await madeDeal.json()) as { deal: { id: string } };

  const res = await app.request(
    `http://localhost/api/deals/${deal.id}/related`,
    { headers },
  );
  const body = (await res.json()) as { contacts: unknown[] };
  expect(body.contacts).toHaveLength(0);
});

/**
 * Editing has to be able to clear a field as well as set one. An empty string
 * where a null belongs leaves "" in the database, which reads back as a value
 * and prints as a blank line on an invoice.
 */
test("a contact's details can be corrected, including cleared", async () => {
  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Marguerite",
      lastName: "Osei",
      title: "Owner",
      phone: "503 555 0142",
    }),
  });
  const { contact } = (await made.json()) as { contact: { id: string } };

  const res = await app.request(`http://localhost/api/contacts/${contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      firstName: "Marguerite",
      lastName: "Osei-Bonsu",
      title: null,
      phones: [{ label: "mobile", value: "503 555 0187" }],
    }),
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    contact: {
      name: string;
      title: string | null;
      phones: { value: string }[] | null;
    };
  };
  // The display name follows the surname change, because invoices read it.
  expect(body.contact.name).toBe("Marguerite Osei-Bonsu");
  expect(body.contact.title).toBeNull();
  expect(body.contact.phones?.[0]?.value).toBe("503 555 0187");
});

test("a company can be corrected after it is created", async () => {
  const made = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Brixton Tap" }),
  });
  const { company } = (await made.json()) as { company: { id: string } };

  const res = await app.request(
    `http://localhost/api/companies/${company.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({ name: "The Brixton Tap", size: 12, sector: null }),
    },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    company: { name: string; size: number | null; sector: string | null };
  };
  expect(body.company.name).toBe("The Brixton Tap");
  expect(body.company.size).toBe(12);
  expect(body.company.sector).toBeNull();
});

test("a deal's company and people can be changed after it exists", async () => {
  // They could only be set at creation, so a deal recorded against the wrong
  // customer could not be fixed — only deleted, taking its notes with it.
  const co = (await (
    await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Right Company" }),
    })
  ).json()) as { company: { id: string } };

  const person = (await (
    await app.request("http://localhost/api/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({ firstName: "Late", lastName: "Addition" }),
    })
  ).json()) as { contact: { id: string } };

  const made = (await (
    await app.request("http://localhost/api/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Misfiled job", contactIds: [] }),
    })
  ).json()) as { deal: { id: string } };

  const res = await app.request(`http://localhost/api/deals/${made.deal.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      companyId: co.company.id,
      contactIds: [person.contact.id],
    }),
  });
  expect(res.status).toBe(200);

  const related = (await (
    await app.request(`http://localhost/api/deals/${made.deal.id}/related`, {
      headers,
    })
  ).json()) as {
    company: { name: string } | null;
    contacts: { name: string }[];
  };
  expect(related.company?.name).toBe("Right Company");
  expect(related.contacts.map((p) => p.name)).toEqual(["Late Addition"]);
});

test("a contact can be moved to a different company", async () => {
  const first = (await (
    await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Old Employer" }),
    })
  ).json()) as { company: { id: string } };
  const second = (await (
    await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "New Employer" }),
    })
  ).json()) as { company: { id: string } };

  const made = (await (
    await app.request("http://localhost/api/contacts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        firstName: "Moved",
        lastName: "Jobs",
        companyId: first.company.id,
      }),
    })
  ).json()) as { contact: { id: string } };

  await app.request(`http://localhost/api/contacts/${made.contact.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ companyId: second.company.id }),
  });

  const related = (await (
    await app.request(
      `http://localhost/api/contacts/${made.contact.id}/related`,
      { headers },
    )
  ).json()) as { company: { name: string } | null };
  expect(related.company?.name).toBe("New Employer");
});

/**
 * CSV quoting. A note reading `Called, no answer` becomes two columns without
 * it, and every row from there down is shifted by one — which looks like the
 * export lost data rather than mangled it.
 */
test("fields containing commas, quotes or newlines survive the round trip", () => {
  const csv = toCsv(
    ["Name", "Note"],
    [
      ["Osei", "Called, no answer"],
      ["Kavanagh", 'Said "next week"'],
      ["Achebe", "Line one\nLine two"],
    ],
  );
  expect(csv).toContain('"Called, no answer"');
  expect(csv).toContain('"Said ""next week"""');
  expect(csv).toContain('"Line one\nLine two"');
});

test("empty and missing values are blank, not the word null", () => {
  expect(toCsv(["A", "B"], [[null, undefined]])).toBe("A,B\r\n,\r\n");
});

test("rows end with CRLF, which is what a spreadsheet expects", () => {
  // A bare newline opens as one long row in Excel on some platforms.
  expect(toCsv(["A"], [["x"]])).toBe("A\r\nx\r\n");
});

test("contacts export as something a person could read", async () => {
  const co = (await (
    await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Ellesmere Dental" }),
    })
  ).json()) as { company: { id: string } };

  await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      firstName: "Sunniva",
      lastName: "Restrepo",
      companyId: co.company.id,
      email: "office@ellesmere.example",
      phones: [{ label: "mobile", value: "503 555 0187" }],
    }),
  });

  const res = await app.request("http://localhost/api/contacts/export.csv", {
    headers,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/csv");

  const body = await res.text();
  expect(body).toContain("Sunniva,Restrepo");
  // The company's name, not its id: a spreadsheet of uuids is unreadable and
  // cannot be imported anywhere else.
  expect(body).toContain("Ellesmere Dental");
  expect(body).not.toContain(co.company.id);
  expect(body).toContain("mobile: 503 555 0187");
});

/**
 * Import. Without it a trial starts with an empty CRM and a re-typing job,
 * which is where most trials end.
 */
test("a spreadsheet of contacts comes in, creating companies as it goes", async () => {
  const res = await app.request("http://localhost/api/contacts/import", {
    method: "POST",
    headers,
    body: JSON.stringify({
      rows: [
        {
          firstName: "Dermot",
          lastName: "Kavanagh",
          company: "Brixton Tap Ltd",
          email: "d@example.com",
        },
        // Same company, spelled differently. Matching on the exact string
        // would create it twice and split the customer in two.
        {
          firstName: "Nuala",
          lastName: "Byrne",
          company: "brixton tap ltd",
        },
      ],
    }),
  });
  expect(res.status).toBe(200);

  const body = (await res.json()) as {
    imported: number;
    companiesCreated: number;
  };
  expect(body.imported).toBe(2);
  expect(body.companiesCreated).toBe(1);
});

test("nameless rows are reported, not silently dropped", async () => {
  // The blank lines at the bottom of every spreadsheet. Saying nothing about
  // them means somebody imports 500 rows, gets 480 contacts, and cannot tell
  // which twenty are missing.
  const res = await app.request("http://localhost/api/contacts/import", {
    method: "POST",
    headers,
    body: JSON.stringify({
      rows: [
        { firstName: "Real", lastName: "Person" },
        { firstName: "", lastName: "", email: "" },
      ],
    }),
  });
  const body = (await res.json()) as {
    imported: number;
    skipped: { row: number; why: string }[];
  };
  expect(body.imported).toBe(1);
  expect(body.skipped).toEqual([{ row: 3, why: "no name" }]);
});

test("an import that would take too long is refused rather than hanging", async () => {
  const rows = Array.from({ length: 5001 }, (_, i) => ({
    firstName: "A",
    lastName: String(i),
  }));
  const res = await app.request("http://localhost/api/contacts/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ rows }),
  });
  expect(res.status).toBe(413);
});

test("an empty import says so instead of reporting success", async () => {
  const res = await app.request("http://localhost/api/contacts/import", {
    method: "POST",
    headers,
    body: JSON.stringify({ rows: [] }),
  });
  expect(res.status).toBe(400);
});

/**
 * Attachments end to end. The upload path is where a filename could reach the
 * filesystem, and the download path is where an uploaded file could execute
 * against this origin — so both are exercised rather than only the happy one.
 */
test("a file attaches to a note and comes back as a download", async () => {
  const made = (await (
    await app.request("http://localhost/api/notes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityType: "contact",
        entityId: "00000000-0000-0000-0000-000000000001",
        text: "Quote attached",
      }),
    })
  ).json()) as { note: { id: string } };

  const form = new FormData();
  form.append(
    "file",
    new File(["<script>alert(1)</script>"], "../../evil.html", {
      type: "text/html",
    }),
  );
  const up = await app.request(
    `http://localhost/api/notes/${made.note.id}/attachments`,
    // Only the cookie: FormData sets its own content-type with the multipart
    // boundary, and overriding it makes the body unparseable.
    {
      method: "POST",
      headers: { cookie: headers.get("cookie") ?? "" },
      body: form,
    },
  );
  expect(up.status).toBe(201);

  const body = (await up.json()) as {
    note: { attachments: { name: string; path: string }[] };
  };
  const [file] = body.note.attachments;
  // The displayed name loses its directory, and the stored path is ours.
  expect(file?.name).toBe("evil.html");
  expect(file?.path).not.toContain("..");

  const down = await app.request(
    `http://localhost/api/notes/${made.note.id}/attachments/0`,
    { headers },
  );
  expect(down.status).toBe(200);
  // Never text/html, whatever was uploaded — otherwise this runs as us.
  expect(down.headers.get("content-type")).toBe("application/octet-stream");
  expect(down.headers.get("content-disposition")).toContain("attachment");
  expect(down.headers.get("x-content-type-options")).toBe("nosniff");
});

test("an attachment on another organisation's note is not found", async () => {
  const res = await app.request(
    "http://localhost/api/notes/00000000-0000-0000-0000-000000000000/attachments/0",
    { headers },
  );
  expect(res.status).toBe(404);
});

test("an index that does not exist is not found rather than a crash", async () => {
  const made = (await (
    await app.request("http://localhost/api/notes", {
      method: "POST",
      headers,
      body: JSON.stringify({
        entityType: "contact",
        entityId: "00000000-0000-0000-0000-000000000002",
        text: "No files here",
      }),
    })
  ).json()) as { note: { id: string } };

  const res = await app.request(
    `http://localhost/api/notes/${made.note.id}/attachments/7`,
    { headers },
  );
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// Searching, filtering, sorting and paging the lists
// ---------------------------------------------------------------------------

/** A contact, straight through the route the browser uses. */
async function makeContact(body: Record<string, unknown>): Promise<string> {
  const res = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const made = (await res.json()) as { contact: { id: string } };
  return made.contact.id;
}

async function listContacts(query: string) {
  const res = await app.request(`http://localhost/api/contacts?${query}`, {
    headers,
  });
  return (await res.json()) as {
    contacts: { id: string; name: string; status: string }[];
    total: number;
    page?: number;
    perPage?: number;
  };
}

test("a contact list search looks through background, not only the name", async () => {
  // The sentence somebody actually remembers is rarely in the name field.
  const id = await makeContact({
    firstName: "Priya",
    lastName: "Raman",
    background: "Met at the Denver trade show, introduced by Dave",
  });

  const byName = await listContacts("q=Priya");
  expect(byName.contacts.map((c) => c.id)).toContain(id);

  const byBackground = await listContacts("q=Denver+trade+show");
  expect(byBackground.contacts.map((c) => c.id)).toContain(id);
});

test("a search term containing % matches that character, not everything", async () => {
  // "50% Ltd" is a real name, and % is ilike's wildcard. Searching for a bare
  // "%" is the case that tells the two apart: escaped, it finds only the names
  // actually containing one; unescaped, it matches every row in the table
  // while looking like a search that worked.
  const withPercent = await makeContact({
    firstName: "Fifty",
    lastName: "50% Ltd",
  });
  const withoutPercent = await makeContact({
    firstName: "Unrelated",
    lastName: "Person",
  });

  const found = await listContacts("q=%25");
  const ids = found.contacts.map((c) => c.id);
  expect(ids).toContain(withPercent);
  expect(ids).not.toContain(withoutPercent);
});

test("a search term containing _ matches that character, not any character", async () => {
  // The other wildcard, and the one people hit by pasting a database key or a
  // file name into the search box.
  const underscored = await makeContact({
    firstName: "Ops",
    lastName: "back_office",
  });
  const decoy = await makeContact({
    firstName: "Ops",
    lastName: "backXoffice",
  });

  const found = await listContacts("q=back_office");
  const ids = found.contacts.map((c) => c.id);
  expect(ids).toContain(underscored);
  expect(ids).not.toContain(decoy);
});

test("the status filter narrows to that status", async () => {
  const hot = await makeContact({
    firstName: "Hot",
    lastName: "Lead",
    status: "hot",
  });
  const cold = await makeContact({
    firstName: "Cold",
    lastName: "Lead",
    status: "cold",
  });

  const found = await listContacts("status=hot");
  const ids = found.contacts.map((c) => c.id);
  expect(ids).toContain(hot);
  expect(ids).not.toContain(cold);
});

test("a sort field the server does not know is ignored, not obeyed", async () => {
  // The sort arrives from the browser. Anything not on the allow-list has to
  // fall back to the default rather than reach the query builder.
  const res = await app.request(
    "http://localhost/api/contacts?sort=name%3B+drop+table+contacts&order=asc",
    { headers },
  );
  expect(res.status).toBe(200);

  // And the table is still there.
  const after = await listContacts("");
  expect(after.contacts.length).toBeGreaterThan(0);
});

test("paging returns a page and the total behind it", async () => {
  for (let i = 0; i < 3; i++) {
    await makeContact({ firstName: `Page${i}`, lastName: "Tester" });
  }

  const page = await listContacts("page=1&perPage=2");
  expect(page.contacts).toHaveLength(2);
  expect(page.page).toBe(1);
  expect(page.perPage).toBe(2);
  // The total counts everything matching, not what fitted on the page.
  expect(page.total).toBeGreaterThan(2);
});

test("a page past the end still reports how many there are", async () => {
  // A window function would return no rows and therefore no count here,
  // leaving the browser unable to say "you are past the end of 40".
  const page = await listContacts("page=9999&perPage=25");
  expect(page.contacts).toHaveLength(0);
  expect(page.total).toBeGreaterThan(0);
});

test("asking for no page still returns everything, for the callers that need it", async () => {
  // The deal board and the invoicing customer picker read the whole list. A
  // silent default page would truncate both without any error.
  const all = await listContacts("");
  expect(all.page).toBeUndefined();
  expect(all.contacts.length).toBe(all.total);
  expect(all.total).toBeGreaterThan(3);
});

test("a deal is found by its company's name, not only its own", async () => {
  const company = (await (
    await app.request("http://localhost/api/companies", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Henderson Roofing" }),
    })
  ).json()) as { company: { id: string } };

  const deal = (await (
    await app.request("http://localhost/api/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Phase two",
        companyId: company.company.id,
      }),
    })
  ).json()) as { deal: { id: string } };

  const res = await app.request("http://localhost/api/deals?q=Henderson", {
    headers,
  });
  const found = (await res.json()) as { deals: { id: string }[] };
  expect(found.deals.map((d) => d.id)).toContain(deal.deal.id);
});

test("a deal is found by a contact attached to it", async () => {
  const contactId = await makeContact({
    firstName: "Marguerite",
    lastName: "Okonkwo",
  });

  const deal = (await (
    await app.request("http://localhost/api/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Unmemorable name",
        contactIds: [contactId],
      }),
    })
  ).json()) as { deal: { id: string } };

  const res = await app.request("http://localhost/api/deals?q=Okonkwo", {
    headers,
  });
  const found = (await res.json()) as { deals: { id: string }[] };
  expect(found.deals.map((d) => d.id)).toContain(deal.deal.id);
});

test("archived deals stay off the board unless asked for", async () => {
  const deal = (await (
    await app.request("http://localhost/api/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Finished last year" }),
    })
  ).json()) as { deal: { id: string } };

  await db
    .update(schema.deals)
    .set({ archivedAt: new Date() })
    .where(eq(schema.deals.id, deal.deal.id));

  const board = (await (
    await app.request("http://localhost/api/deals", { headers })
  ).json()) as { deals: { id: string }[] };
  expect(board.deals.map((d) => d.id)).not.toContain(deal.deal.id);

  const archived = (await (
    await app.request("http://localhost/api/deals?archived=1", { headers })
  ).json()) as { deals: { id: string }[] };
  expect(archived.deals.map((d) => d.id)).toContain(deal.deal.id);
});

test("an export carries only the rows the filter left on screen", async () => {
  // The list route and the export used to build their own conditions. The
  // export ignored every filter, so somebody who narrowed to nine hot leads
  // and clicked Export was handed the whole table with nothing to say so.
  const hot = await makeContact({
    firstName: "Exportable",
    lastName: "Hotlead",
    status: "hot",
  });
  await makeContact({
    firstName: "Excluded",
    lastName: "Coldlead",
    status: "cold",
  });

  const res = await app.request(
    "http://localhost/api/contacts/export.csv?status=hot",
    { headers },
  );
  const csv = await res.text();
  expect(csv).toContain("Hotlead");
  expect(csv).not.toContain("Coldlead");
  expect(hot).toBeTruthy();
});

test("a deal export is filtered the same way the board is", async () => {
  const deal = (await (
    await app.request("http://localhost/api/deals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Exportable deal",
        stage: "proposal",
        amountCents: 125_00,
      }),
    })
  ).json()) as { deal: { id: string } };

  await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Other stage deal", stage: "opportunity" }),
  });

  const res = await app.request(
    "http://localhost/api/deals/export.csv?stage=proposal",
    { headers },
  );
  const csv = await res.text();
  expect(csv).toContain("Exportable deal");
  expect(csv).not.toContain("Other stage deal");
  // Money leaves as a decimal, because every spreadsheet would read cents as
  // whole currency units.
  expect(csv).toContain("125.00");
  expect(deal.deal.id).toBeTruthy();
});

test("a blank status falls back to the default rather than being stored", async () => {
  // NOT NULL DEFAULT only covers an absent field, not a present blank one —
  // and a blank one is exactly what an unfilled select sends. Stored, it
  // renders as "—" and matches none of the status filters, so the contact is
  // invisible to every one of them while looking normal in the list.
  const id = await makeContact({
    firstName: "Blank",
    lastName: "Status",
    status: "",
  });

  const [row] = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.id, id));
  expect(row?.status).toBe("cold");

  const found = await listContacts("status=cold");
  expect(found.contacts.map((c) => c.id)).toContain(id);
});

/**
 * Email capture, end to end.
 *
 * The endpoint holds no session, so these are the tests that matter: the
 * secret, what happens when nobody matches, and that turning it off actually
 * turns it off.
 */
async function captureOn(address: string): Promise<string> {
  const res = await app.request("http://localhost/api/crm/inbound", {
    method: "POST",
    headers,
    body: JSON.stringify({ address }),
  });
  const { webhookUrl } = (await res.json()) as { webhookUrl: string };
  return webhookUrl;
}

const post = (url: string, payload: Record<string, unknown>) =>
  app.request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

test("a CC'd email lands on the customer's record", async () => {
  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Dave Nunn", email: "dave@example.test" }),
  });
  const { contact } = (await made.json()) as { contact: { id: string } };

  const webhookUrl = await captureOn("capture@ours.test");
  const res = await post(webhookUrl, {
    From: "Dave Nunn <dave@example.test>",
    To: "sales@ours.test",
    Cc: "capture@ours.test",
    Subject: "Re: the quote",
    TextBody: "Looks fine, go ahead.",
    Attachments: [
      {
        Name: "signed.pdf",
        ContentType: "application/pdf",
        Content: Buffer.from("a signed job sheet").toString("base64"),
      },
    ],
  });
  expect(res.status).toBe(200);
  expect((await res.json()).matched).toBe(true);

  const notes = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.entityId, contact.id));
  expect(notes).toHaveLength(1);
  expect(notes[0]?.text).toContain("Re: the quote");
  expect(notes[0]?.text).toContain("Looks fine, go ahead.");
  // The file is on disk under a name we generated, not the one sent.
  expect(notes[0]?.attachments?.[0]?.name).toBe("signed.pdf");
  expect(notes[0]?.attachments?.[0]?.path).not.toContain("signed.pdf");

  const activity = await db
    .select()
    .from(schema.activities)
    .where(eq(schema.activities.contactId, contact.id));
  expect(activity.some((a) => a.type === "email")).toBe(true);
});

test("a wrong secret is a 404 and writes nothing", async () => {
  const webhookUrl = await captureOn("capture@ours.test");
  const before = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.organizationId, orgId));

  const guessed = `${webhookUrl.slice(0, -1)}${webhookUrl.endsWith("a") ? "b" : "a"}`;
  const res = await post(guessed, {
    From: "dave@example.test",
    Subject: "Should not land",
    TextBody: "…",
  });
  expect(res.status).toBe(404);

  // A prefix of the real secret is not a match either.
  const short = await post(webhookUrl.slice(0, -8), {
    From: "dave@example.test",
  });
  expect(short.status).toBe(404);

  const after = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

test("mail that matches nobody is dropped, not filed against a guess", async () => {
  // A private conversation on the wrong customer's record is a breach with a
  // paper trail. 200 so the provider stops rather than retrying for ever.
  const webhookUrl = await captureOn("capture@ours.test");
  const before = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.organizationId, orgId));

  const res = await post(webhookUrl, {
    From: "stranger@nowhere.test",
    To: "capture@ours.test",
    Subject: "Who is this",
    TextBody: "…",
  });
  expect(res.status).toBe(200);
  expect((await res.json()).matched).toBe(false);

  const after = await db
    .select()
    .from(schema.notes)
    .where(eq(schema.notes.organizationId, orgId));
  expect(after).toHaveLength(before.length);
});

test("turning capture off stops the URL that was already handed out", async () => {
  const webhookUrl = await captureOn("capture@ours.test");
  expect((await post(webhookUrl, { From: "dave@example.test" })).status).toBe(
    200,
  );

  await app.request("http://localhost/api/crm/inbound", {
    method: "DELETE",
    headers,
  });
  expect((await post(webhookUrl, { From: "dave@example.test" })).status).toBe(
    404,
  );

  // And rotating gives a different URL, which is how a leaked one is revoked.
  const rotated = await captureOn("capture@ours.test");
  expect(rotated).not.toBe(webhookUrl);
  expect((await post(webhookUrl, { From: "dave@example.test" })).status).toBe(
    404,
  );
  expect((await post(rotated, { From: "dave@example.test" })).status).toBe(200);
});

test("a contact's history is everything that happened, newest first", async () => {
  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Ada History", email: "ada@history.test" }),
  });
  const { contact } = (await made.json()) as { contact: { id: string } };

  await db.insert(schema.notes).values({
    organizationId: orgId,
    entityType: "contact",
    entityId: contact.id,
    text: "Talked through the quote",
    createdAt: new Date("2026-03-01T10:00:00Z"),
  });
  await db.insert(schema.activities).values({
    organizationId: orgId,
    contactId: contact.id,
    type: "email",
    body: "Re: the quote",
    occurredAt: new Date("2026-03-05T09:00:00Z"),
  });
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    contactId: contact.id,
    title: "Call about the second unit",
    done: true,
    doneAt: new Date("2026-03-03T12:00:00Z"),
  });

  const res = await app.request(
    `http://localhost/api/crm/history?contactId=${contact.id}`,
    { headers },
  );
  expect(res.status).toBe(200);
  const { history } = (await res.json()) as {
    history: { at: string; kind: string; title: string }[];
  };

  expect(history.map((h) => h.kind)).toEqual(["email", "task", "note"]);
  expect(history[1]?.title).toBe("Done: Call about the second unit");
});

test("a company's history is its people's history", async () => {
  // Nothing hangs off a company directly, so without gathering its contacts
  // the panel is permanently empty.
  const madeCompany = await app.request("http://localhost/api/companies", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "History Ltd" }),
  });
  const { company } = (await madeCompany.json()) as {
    company: { id: string };
  };
  const madeContact = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Bez Works-There",
      companyId: company.id,
    }),
  });
  const { contact } = (await madeContact.json()) as { contact: { id: string } };

  await db.insert(schema.notes).values({
    organizationId: orgId,
    entityType: "contact",
    entityId: contact.id,
    text: "Site visit booked",
  });

  const res = await app.request(
    `http://localhost/api/crm/history?companyId=${company.id}`,
    { headers },
  );
  const { history } = (await res.json()) as { history: { title: string }[] };
  expect(history.some((h) => h.title === "Site visit booked")).toBe(true);
});

test("history never crosses a company boundary", async () => {
  const theirOrg = crypto.randomUUID();
  const [theirContact] = await db
    .insert(schema.contacts)
    .values({ organizationId: theirOrg, name: "Not ours" })
    .returning();
  await db.insert(schema.notes).values({
    organizationId: theirOrg,
    entityType: "contact",
    entityId: theirContact?.id ?? "",
    text: "Their private note",
  });

  const res = await app.request(
    `http://localhost/api/crm/history?contactId=${theirContact?.id}`,
    { headers },
  );
  const { history } = (await res.json()) as { history: { title: string }[] };
  expect(history.some((h) => h.title === "Their private note")).toBe(false);

  await db
    .delete(schema.notes)
    .where(eq(schema.notes.organizationId, theirOrg));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, theirOrg));
});

test("somebody's history holds their deals and nobody else's", async () => {
  // The first version returned every deal the business had ever opened,
  // because a deal keeps its contacts in a JSON column and the query could
  // not filter on it. On an empty database that looked right.
  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Quiet Contact" }),
  });
  const { contact } = (await made.json()) as { contact: { id: string } };

  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Their own job",
      contactIds: [contact.id],
    },
    {
      organizationId: orgId,
      name: "Somebody else's job",
      contactIds: [crypto.randomUUID()],
    },
  ]);

  const res = await app.request(
    `http://localhost/api/crm/history?contactId=${contact.id}`,
    { headers },
  );
  const { history } = (await res.json()) as { history: { title: string }[] };
  expect(history.some((h) => h.title.includes("Their own job"))).toBe(true);
  expect(history.some((h) => h.title.includes("Somebody else's job"))).toBe(
    false,
  );
});

test("a business's own fields are stored on the record, and nothing else is", async () => {
  const settings = await app.request("http://localhost/api/crm/settings", {
    headers,
  });
  const current = (await settings.json()) as Record<string, unknown>;

  const saved = await app.request("http://localhost/api/crm/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...current,
      customFields: [
        { label: "Boiler model", type: "text", appliesTo: "contact" },
        { label: "Units", type: "number", appliesTo: "contact" },
      ],
    }),
  });
  expect(saved.status).toBe(200);

  const made = await app.request("http://localhost/api/contacts", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Custom Fields",
      customValues: {
        boiler_model: "Worcester 4000",
        units: "12",
        // No definition behind it: the request body is not a schema.
        smuggled: "should not be stored",
      },
    }),
  });
  const { contact } = (await made.json()) as {
    contact: { id: string; customValues: Record<string, unknown> };
  };
  expect(contact.customValues).toEqual({
    boiler_model: "Worcester 4000",
    units: 12,
  });

  // And the same on the way through an update, not only on the way in.
  const patched = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        customValues: { units: 30, smuggled: "still no" },
      }),
    },
  );
  const updated = (await patched.json()) as {
    contact: { customValues: Record<string, unknown> };
  };
  expect(updated.contact.customValues).toEqual({ units: 30 });

  // A form that knows nothing about custom fields must not wipe them.
  const renamed = await app.request(
    `http://localhost/api/contacts/${contact.id}`,
    { method: "PATCH", headers, body: JSON.stringify({ name: "Renamed" }) },
  );
  const after = (await renamed.json()) as {
    contact: { customValues: Record<string, unknown> };
  };
  expect(after.contact.customValues).toEqual({ units: 30 });
});

test("a bad field definition is refused and changes nothing", async () => {
  const before = (await (
    await app.request("http://localhost/api/crm/settings", { headers })
  ).json()) as Record<string, unknown>;

  const res = await app.request("http://localhost/api/crm/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      ...before,
      customFields: [{ label: "Access", type: "select", options: [] }],
    }),
  });
  expect(res.status).toBe(400);

  const after = (await (
    await app.request("http://localhost/api/crm/settings", { headers })
  ).json()) as Record<string, unknown>;
  expect(after.customFields).toEqual(before.customFields);
});

test("custom fields are Pro, and a Free instance keeps the ones it has", async () => {
  // The pipeline is sent back exactly as it stands, which is what the settings
  // screen does and what keeps this test from removing a stage other tests in
  // this file have deals standing in.
  const settings = (await (
    await app.request("http://localhost/api/crm/settings", { headers })
  ).json()) as Record<string, unknown>;
  const save = (to: typeof app, customFields: Record<string, unknown>[]) =>
    to.request("http://localhost/api/crm/settings", {
      method: "PUT",
      headers,
      body: JSON.stringify({ ...settings, customFields }),
    });

  const boiler = {
    id: "boiler_model",
    label: "Boiler model",
    type: "text",
    appliesTo: "contact",
  };

  // Defined while entitled, which is the state a lapsed licence leaves behind.
  expect((await save(app, [boiler])).status).toBe(200);

  const free = new Hono<SentrelloEnv>();
  crm.register({
    app: free,
    entitled: (need) => !("tier" in need && need.tier === "pro"),
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerJob: () => {},
  });

  // Still readable. This is the promise a lapsed licence has to keep, and the
  // half a gate most easily breaks by accident.
  const read = await free.request("http://localhost/api/crm/settings", {
    headers,
  });
  expect(read.status).toBe(200);
  expect((await read.json()) as { customFields: unknown[] }).toMatchObject({
    customFields: [{ id: "boiler_model" }],
  });

  // Saving anything else still works, with the fields sent back unchanged the
  // way the real screen does. Refusing this would take away six free things to
  // gate one — and it is the case `jsonb` key reordering silently breaks.
  expect((await save(free, [boiler])).status).toBe(200);

  // Adding one is refused, and says why rather than dropping the write.
  const added = await save(free, [
    boiler,
    {
      id: "site_access",
      label: "Site access",
      type: "text",
      appliesTo: "deal",
    },
  ]);
  expect(added.status).toBe(403);
  expect(((await added.json()) as { error: string }).error).toContain("Pro");

  // Renaming one is a change too, and the label is the tempting thing to let
  // through because nothing about the shape of the data moves.
  const renamed = await save(free, [{ ...boiler, label: "Boiler make" }]);
  expect(renamed.status).toBe(403);

  // And nothing was written: a refusal that half-saved would be worse than
  // either answer.
  const after = await free.request("http://localhost/api/crm/settings", {
    headers,
  });
  expect(
    ((await after.json()) as { customFields: { label: string }[] })
      .customFields,
  ).toEqual([expect.objectContaining({ label: "Boiler model" })]);
});
