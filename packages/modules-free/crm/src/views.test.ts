import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import crm from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-views-${suffix}@example.test`;
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
    body: { name: `Views ${suffix}`, slug: `views-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  // A small book with known shape: two hot contacts, one cold; three deals
  // in two stages, one of them too small for the filter the view keeps.
  await db.insert(schema.contacts).values([
    { organizationId: orgId, name: "Hot One", status: "hot" },
    { organizationId: orgId, name: "Hot Two", status: "hot" },
    { organizationId: orgId, name: "Cold One", status: "cold" },
  ]);
  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Big Open",
      stage: "opportunity",
      amountCents: 700_000,
    },
    {
      organizationId: orgId,
      name: "Second Big Open",
      stage: "proposal-sent",
      amountCents: 900_000,
    },
    {
      organizationId: orgId,
      name: "Small Open",
      stage: "opportunity",
      amountCents: 100_000,
    },
  ]);
});

afterAll(async () => {
  for (const [table, column] of [
    [schema.savedViews, schema.savedViews.organizationId],
    [schema.recordEvents, schema.recordEvents.organizationId],
    [schema.deals, schema.deals.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.crmSettings, schema.crmSettings.organizationId],
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

test("a saved view round-trips its state and returns the same rows", async () => {
  // The rows as the screen currently shows them.
  const direct = await app.request(
    "http://localhost/api/contacts?status=hot&sort=name&order=asc",
    { headers },
  );
  const before = (await direct.json()) as { contacts: { name: string }[] };
  expect(before.contacts.map((c) => c.name)).toEqual(["Hot One", "Hot Two"]);

  const saved = await app.request("http://localhost/api/views", {
    method: "POST",
    headers,
    body: JSON.stringify({
      resource: "contacts",
      name: "Hot people",
      view: {
        q: "",
        sort: "name",
        order: "asc",
        filters: { status: "hot" },
      },
    }),
  });
  expect(saved.status).toBe(201);

  // Read it back the way the screen would, and replay it.
  const listed = await app.request(
    "http://localhost/api/views?resource=contacts",
    { headers },
  );
  const { views } = (await listed.json()) as {
    views: {
      id: string;
      name: string;
      view: {
        sort: string;
        order: string;
        filters: Record<string, string>;
      };
    }[];
  };
  const mine = views.find((v) => v.name === "Hot people");
  expect(mine).toBeDefined();
  if (!mine) throw new Error("the view was not listed");
  expect(mine.view.filters).toEqual({ status: "hot" });

  const replayed = await app.request(
    `http://localhost/api/contacts?${new URLSearchParams({
      sort: mine.view.sort,
      order: mine.view.order,
      ...mine.view.filters,
    })}`,
    { headers },
  );
  const after = (await replayed.json()) as { contacts: { name: string }[] };
  expect(after.contacts.map((c) => c.name)).toEqual(
    before.contacts.map((c) => c.name),
  );
});

test("a view belongs to its person: a colleague's views are not listed", async () => {
  await db.insert(schema.savedViews).values({
    organizationId: orgId,
    userId: `someone-else-${suffix}`,
    resource: "contacts",
    name: "Their worries",
    view: { filters: { status: "cold" } },
  });

  const listed = await app.request(
    "http://localhost/api/views?resource=contacts",
    { headers },
  );
  const { views } = (await listed.json()) as { views: { name: string }[] };
  expect(views.some((v) => v.name === "Their worries")).toBe(false);
});

test("updating a view replaces its state; deleting removes it", async () => {
  const listed = await app.request(
    "http://localhost/api/views?resource=contacts",
    { headers },
  );
  const { views } = (await listed.json()) as { views: { id: string }[] };
  const id = views[0]?.id;
  if (!id) throw new Error("no view to update");

  const patched = await app.request(`http://localhost/api/views/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ view: { filters: { status: "cold" } } }),
  });
  expect(patched.status).toBe(200);
  const { view } = (await patched.json()) as {
    view: { view: { filters: Record<string, string> } };
  };
  expect(view.view.filters).toEqual({ status: "cold" });

  const deleted = await app.request(`http://localhost/api/views/${id}`, {
    method: "DELETE",
    headers,
  });
  expect(deleted.status).toBe(200);
  const again = await app.request(
    "http://localhost/api/views?resource=contacts",
    { headers },
  );
  const remaining = (await again.json()) as { views: { id: string }[] };
  expect(remaining.views.some((v) => v.id === id)).toBe(false);
});

test("grouping a list answers with counts over the whole filtered set", async () => {
  const res = await app.request(
    "http://localhost/api/contacts?groupBy=status&page=1&perPage=1",
    { headers },
  );
  const body = (await res.json()) as {
    contacts: unknown[];
    groups: { value: string | null; count: number }[];
  };
  // One row on the page; the groups still describe all three contacts.
  expect(body.contacts).toHaveLength(1);
  const byValue = new Map(body.groups.map((g) => [g.value, g.count]));
  expect(byValue.get("hot")).toBe(2);
  expect(byValue.get("cold")).toBe(1);
});

test("deal groups carry the money, and honour the filters", async () => {
  const res = await app.request(
    "http://localhost/api/deals?groupBy=stage&minAmountCents=500000",
    { headers },
  );
  const body = (await res.json()) as {
    deals: { name: string }[];
    groups: { value: string; count: number; amountCents: number }[];
  };
  // The small deal is outside the filter, so it is in neither rows nor sums.
  expect(body.deals.map((d) => d.name).sort()).toEqual([
    "Big Open",
    "Second Big Open",
  ]);
  const byStage = new Map(body.groups.map((g) => [g.value, g]));
  expect(byStage.get("opportunity")?.count).toBe(1);
  expect(byStage.get("opportunity")?.amountCents).toBe(700_000);
  expect(byStage.get("proposal-sent")?.amountCents).toBe(900_000);
});

test("a field not on the allow-list groups nothing rather than erroring", async () => {
  const res = await app.request(
    "http://localhost/api/contacts?groupBy=portalToken",
    { headers },
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { groups?: unknown };
  expect(body.groups).toBeUndefined();
});

/**
 * Money's own lists are lists too.
 *
 * Saved views were built for contacts, companies and deals and addressed as
 * `/api/crm/views` behind `crm: read`. The table was always generic; the only
 * thing that made this the CRM's feature was the door. So the invoice and
 * quote lists — the two a business actually opens on a Monday morning — could
 * not save a question, and a bookkeeper with no CRM permission could not have
 * saved one even if they could reach it.
 */
test("an invoice list's view is saved and comes back with its filters", async () => {
  const saved = await app.request("http://localhost/api/views", {
    method: "POST",
    headers,
    body: JSON.stringify({
      resource: "invoices",
      name: "Overdue, oldest first",
      view: {
        sort: "dueDate",
        order: "asc",
        filters: { tab: "overdue" },
      },
    }),
  });
  expect(saved.status).toBe(201);
  const { view } = (await saved.json()) as {
    view: { id: string; resource: string };
  };
  expect(view.resource).toBe("invoices");

  const mine = await app.request(
    "http://localhost/api/views?resource=invoices",
    { headers },
  );
  const { views } = (await mine.json()) as {
    views: {
      name: string;
      view: { sort?: string; filters?: Record<string, string> };
    }[];
  };
  expect(views.map((v) => v.name)).toEqual(["Overdue, oldest first"]);
  expect(views[0]?.view.sort).toBe("dueDate");
  expect(views[0]?.view.filters).toEqual({ tab: "overdue" });

  // And the contact list is not shown somebody's invoice views: the resource
  // is what a view belongs to, not decoration on it.
  const contacts = await app.request(
    "http://localhost/api/views?resource=contacts",
    { headers },
  );
  const theirs = (await contacts.json()) as { views: { name: string }[] };
  expect(theirs.views.map((v) => v.name)).not.toContain(
    "Overdue, oldest first",
  );

  await app.request(`http://localhost/api/views/${view.id}`, {
    method: "DELETE",
    headers,
  });
});

test("a list views do not exist for is refused rather than stored", async () => {
  const res = await app.request("http://localhost/api/views", {
    method: "POST",
    headers,
    body: JSON.stringify({ resource: "payroll", name: "Anything" }),
  });
  expect(res.status).toBe(400);
});
