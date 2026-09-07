import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import { registerForTest } from "@sentrello/module-sdk";

/**
 * No Free module hands one business another business's rows.
 *
 * Every business query is `organizationId`-scoped — one organization per self-host today, and the
 * filter is what keeps a hosted tier possible later. It is also the invariant
 * a test database cannot check by accident: with one business in it, a scoped
 * query and an unscoped one return exactly the same thing. Sampling found the
 * filters held by nothing in both the Users module and CRM.
 *
 * The companion to `module-gates.test.ts`, asking the opposite question of the
 * same route enumeration: that one checks a caller who may not be here at all,
 * this one checks a caller who may be here but is in the wrong business — and
 * who holds every permission, so the routes run rather than refuse.
 *
 * **The seed goes through each module's own create route, not an INSERT.** A
 * first attempt at this seeded `contacts` directly and could not be made to
 * fail even with the filter removed, because the row did not satisfy what the
 * list expects and never appeared in any response. A test that cannot be shown
 * to catch its own bug is worth less than nothing, so it was thrown away and
 * rebuilt from a leak proven visible first: create through the route, neuter
 * `listWhere`, watch the marker cross.
 *
 * **What this does not cover**, said plainly rather than left to be assumed: a
 * leak that is a *number*. A dashboard total or a ledger sum quietly counting
 * both businesses has no marker in it and would pass. Those want assertions
 * where the figures are computed.
 */

const MODULES = { crm, invoicing };

const suffix = crypto.randomUUID().slice(0, 8);
/** In the second business's rows, and in none of the first's. */
const MARKER = `zztenant${suffix}`;

/**
 * One create per module, chosen because the thing it makes is what that
 * module's screens list. A module with nothing here still has every one of its
 * reads swept — it just contributes no marker of its own.
 */
const SEEDS: [keyof typeof MODULES, string, Record<string, unknown>][] = [
  ["crm", "/api/contacts", { name: MARKER }],
  ["crm", "/api/companies", { name: MARKER }],
];

let aHeaders: Headers;
let bHeaders: Headers;
let aOrgId: string;
let bOrgId: string;
let aUserId: string;
let bUserId: string;

async function business(label: string) {
  const signUp = await signUpAsOwner({
    email: `tenancy-${label}-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: label,
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `${label} ${suffix}`, slug: `${label}-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return { headers, orgId: org.id, userId: signUp.response.user.id };
}

beforeAll(async () => {
  const a = await business("alpha");
  aHeaders = a.headers;
  aOrgId = a.orgId;
  aUserId = a.userId;

  const b = await business("beta");
  bHeaders = b.headers;
  bOrgId = b.orgId;
  bUserId = b.userId;

  // The second business's owner carries the marker too, which covers the
  // tables the whole platform shares — members, users, groups, roles.
  await db
    .update(schema.user)
    .set({ name: MARKER })
    .where(eq(schema.user.id, bUserId));

  for (const [module, path, body] of SEEDS) {
    const app = registerForTest(MODULES[module]);
    const res = await app.request(`http://localhost${path}`, {
      method: "POST",
      headers: bHeaders,
      body: JSON.stringify(body),
    });
    // Loudly, because a seed that silently failed is how the previous attempt
    // at this passed while proving nothing.
    if (res.status >= 400) {
      throw new Error(`seeding ${path} answered ${res.status}`);
    }
  }
});

afterAll(async () => {
  for (const orgId of [aOrgId, bOrgId]) {
    await db
      .delete(schema.contacts)
      .where(eq(schema.contacts.organizationId, orgId));
    await db
      .delete(schema.companies)
      .where(eq(schema.companies.organizationId, orgId));
    await db
      .delete(schema.member)
      .where(eq(schema.member.organizationId, orgId));
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, orgId));
  }
  await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, [aUserId, bUserId]));
  await db
    .delete(schema.account)
    .where(inArray(schema.account.userId, [aUserId, bUserId]));
  await db
    .delete(schema.user)
    .where(inArray(schema.user.id, [aUserId, bUserId]));
});

test("the business that owns the rows can see them", async () => {
  // The other half of the pair, and the one that keeps the sweep honest: if
  // the seed stopped working, everything below would pass by returning
  // nothing at all, exactly as the discarded first attempt did.
  const app = registerForTest(crm);
  const mine = await app.request("http://localhost/api/contacts", {
    headers: bHeaders,
  });
  expect(await mine.text()).toContain(MARKER);
});

test("no read in any Free module returns another business's rows", async () => {
  const leaked: string[] = [];
  let checked = 0;

  for (const [name, mod] of Object.entries(MODULES)) {
    const app = registerForTest(mod) as unknown as {
      routes?: { method: string; path: string }[];
      request: (url: string, init?: RequestInit) => Promise<Response>;
    };

    const seen = new Set<string>();
    for (const route of app.routes ?? []) {
      // Reads only: this asks what a caller can *see*, and a POST with a
      // fictional body would mostly be answering a validation error.
      if (route.method !== "GET" || !route.path.startsWith("/api")) continue;
      if (seen.has(route.path)) continue;
      seen.add(route.path);
      checked += 1;

      const path = route.path.replace(/:[A-Za-z]+/g, "nothing");
      const res = await app.request(`http://localhost${path}`, {
        headers: aHeaders,
      });
      if ((await res.text()).includes(MARKER)) {
        leaked.push(`${name}: GET ${route.path} → ${res.status}`);
      }
    }
  }

  expect(checked).toBeGreaterThan(20);
  // Named rather than counted, so a regression says which door opened.
  expect(leaked).toEqual([]);
}, 120_000);
