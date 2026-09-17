import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema, watchQueries } from "@sentrello/db";
import type { ComputedColumns, SentrelloEnv } from "@sentrello/module-sdk";
import {
  addComputedColumns,
  clearComputedColumns,
} from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

/**
 * A column a module works out, arriving with the records the list already
 * loads.
 *
 * The case this exists for: a computed field that only ever appeared on the
 * screen where it was defined. Somebody looks at their contacts, companies and
 * deals in the lists, so a column that is not there is a column nobody sees.
 *
 * Every test here registers its provider by hand rather than loading one,
 * because the modules that define computed fields are in other repositories
 * and Core must not know their names. That is the point of the registration
 * point, and a fake provider exercises exactly what a real one does.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `computed-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

process.env.SENTRELLO_DATA_DIR = `/tmp/sentrello-test-${crypto.randomUUID().slice(0, 8)}`;

/** How many rows a page holds here — enough to prove a per-row query. */
const ROWS = 40;

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
    body: { name: `Computed ${suffix}`, slug: `computed-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  await db.insert(schema.contacts).values(
    Array.from({ length: ROWS }, (_, i) => ({
      organizationId: orgId,
      name: `Person ${i}`,
      email: `person-${i}-${suffix}@example.test`,
    })),
  );
});

afterEach(() => {
  clearComputedColumns();
});

afterAll(async () => {
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (user) {
    await db.delete(schema.session).where(eq(schema.session.userId, user.id));
    await db.delete(schema.account).where(eq(schema.account.userId, user.id));
    await db.delete(schema.user).where(eq(schema.user.id, user.id));
  }
});

/** A provider of the shape a module registers, with no database of its own. */
function fake(
  load: ComputedColumns["load"],
  entity = "contact",
): ComputedColumns & { moduleId: string } {
  return { id: "test:columns", entity, moduleId: "test", load };
}

/** Values worked out from a column that is already on the row. */
const nameLength = fake(async (_orgId, rows) => ({
  columns: [{ key: "len", label: "Name length", kind: "whole" as const }],
  values: Object.fromEntries(
    rows.map((row) => [
      String(row.id),
      { len: { value: String(row.name).length } },
    ]),
  ),
}));

const list = async (path = "/api/contacts?perPage=100") =>
  (await app.request(`http://localhost${path}`, { headers })).json() as Promise<
    Record<string, unknown>
  >;

test("a list carries the columns a module works out", async () => {
  addComputedColumns(nameLength);

  const body = await list();
  const rows = body.contacts as {
    name: string;
    computed: Record<string, { value: number }>;
  }[];

  expect(rows.length).toBe(ROWS);
  expect(body.computedColumns).toEqual([
    { key: "len", label: "Name length", kind: "whole" },
  ]);
  for (const row of rows) {
    expect(row.computed.len?.value).toBe(row.name.length);
  }
});

test("a Free instance's list is exactly what it always was", async () => {
  // Nothing registered — which is every instance without the module that
  // defines computed fields.
  const body = await list();
  const rows = body.contacts as Record<string, unknown>[];

  expect(rows.length).toBe(ROWS);
  expect("computedColumns" in body).toBe(false);
  for (const row of rows) expect("computed" in row).toBe(false);
});

test("a column that cannot be worked out loses one cell, not the list", async () => {
  addComputedColumns(
    fake(async (_orgId, rows) => ({
      columns: [{ key: "weighted", label: "Weighted", kind: "money" as const }],
      values: Object.fromEntries(
        rows.map((row, i) => [
          String(row.id),
          i === 0
            ? { weighted: { value: null, reason: "no value for Value" } }
            : { weighted: { value: 1_000 } },
        ]),
      ),
    })),
  );

  const body = await list();
  const rows = body.contacts as {
    computed: Record<string, { value: number | null; reason?: string }>;
  }[];

  expect(rows.length).toBe(ROWS);
  expect(rows[0]?.computed.weighted).toEqual({
    value: null,
    reason: "no value for Value",
  });
  for (const row of rows.slice(1)) {
    expect(row.computed.weighted?.value).toBe(1_000);
  }
});

test("a provider that throws leaves the list intact", async () => {
  addComputedColumns(
    fake(async () => {
      throw new Error("the formulas table is missing");
    }),
  );

  const body = await list();
  expect((body.contacts as unknown[]).length).toBe(ROWS);
  expect("computedColumns" in body).toBe(false);
});

test("the page costs the same queries with the columns as without", async () => {
  const count = async () => {
    let queries = 0;
    watchQueries.onQuery = () => {
      queries += 1;
    };
    await list();
    watchQueries.onQuery = undefined;
    return queries;
  };

  const bare = await count();

  let calls = 0;
  addComputedColumns(
    fake(async (orgId, rows) => {
      calls += 1;
      return nameLength.load(orgId, rows);
    }),
  );
  const withColumns = await count();

  // One call for the page, not one per row — and no query behind it, since a
  // computed column reads what the row already carries.
  expect(calls).toBe(1);
  expect(withColumns).toBe(bare);

  /*
   * And a provider that does have something to look up — the definitions of
   * its own columns, say — looks it up once for the page rather than once for
   * each row. That is the failure this contract exists to prevent, and the
   * number that proves it is one, not forty.
   */
  clearComputedColumns();
  addComputedColumns(
    fake(async (orgId, rows) => {
      await db
        .select({ id: schema.crmSettings.organizationId })
        .from(schema.crmSettings)
        .where(eq(schema.crmSettings.organizationId, orgId));
      return nameLength.load(orgId, rows);
    }),
  );
  expect(await count()).toBe(bare + 1);
});

test("a provider registered for another entity stays off this list", async () => {
  addComputedColumns(fake(nameLength.load, "deal"));

  const body = await list();
  expect("computedColumns" in body).toBe(false);
});
