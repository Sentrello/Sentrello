import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import { postJournalEntry } from "@sentrello/db/ledger";
import accounting from "@sentrello/module-accounting";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import invoicing from "@sentrello/module-invoicing";
import { registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";

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
 * **A leak that is a number is covered too, since 2026-09-09.** A report total
 * quietly counting both businesses carries no name to search for, so the
 * marker is an *amount*: the second business posts a journal entry for a sum
 * nothing else would produce, and no figure the first business is shown may
 * contain it. Same sweep, same shape, a different kind of marker.
 *
 * **What is still not covered**: a leak that is neither a name nor this
 * amount — a count, an average, a figure this entry does not move. Those want
 * assertions where they are computed.
 */

/*
 * Which modules are swept.
 *
 * Accounting and Users were added on 2026-09-09: the test was named for "any
 * Free module" and enumerated two of them, so the routes that read a ledger or
 * an account list were checked by nothing here.
 */
/*
 * Every Free module that reads business data.
 *
 * `dashboard` and `settings` were added on 2026-09-09. The dashboard is the
 * first screen anybody opens and summarises invoices, quotes and tasks — and
 * unscoping one of its queries was caught only by two *arithmetic* tests
 * reacting to rows a previous run had left behind. Incidental coverage is not
 * coverage; it holds until the database is clean.
 *
 * `profile` is deliberately absent: it reads only the caller's own account, so
 * there is no second business's row for it to return.
 */
const MODULES = { crm, invoicing, accounting, users, dashboard, settings };

const suffix = crypto.randomUUID().slice(0, 8);
/** In the second business's rows, and in none of the first's. */
const MARKER = `zztenant${suffix}`;
/**
 * The other kind of marker: a sum no real figure would land on.
 *
 * £8,675,309.11 — large enough that no seeded row or default reaches it, and
 * odd enough that a rounded total cannot arrive at it by chance.
 */
const AMOUNT = 867_530_911;

/**
 * One create per module, chosen because the thing it makes is what that
 * module's screens list. A module with nothing here still has every one of its
 * reads swept — it just contributes no marker of its own.
 */
const SEEDS: [keyof typeof MODULES, string, Record<string, unknown>][] = [
  ["crm", "/api/contacts", { name: MARKER }],
  ["crm", "/api/companies", { name: MARKER }],
  /*
   * A tag, because tags take a different road out of the CRM.
   *
   * A resource with no list spec is served by a separate branch — every row,
   * unordered, unpaged — and that branch has its own `organizationId` filter.
   * Removing it leaked nothing this test could see, because nothing it seeded
   * was a tag. The marker has to exist in the table the query reads, or the
   * sweep walks past the open door.
   */
  ["crm", "/api/tags", { name: MARKER }],
  ["crm", "/api/deals", { name: MARKER }],
];

let aHeaders: Headers;
let bHeaders: Headers;
let aOrgId: string;
let bOrgId: string;
let aUserId: string;
let bUserId: string;
/**
 * Every id the second business owns, whatever kind of thing it names.
 *
 * The write sweep tries each of them in every path parameter of every write
 * route, rather than matching a kind of id to a kind of route. A contact id
 * offered to the route that archives a deal is a wasted call and costs
 * milliseconds; deciding by hand which id belongs where is how the one route
 * nobody thought about goes unswept.
 */
const bIds: string[] = [];

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

  /*
   * Money for the second business, in a sum nothing else would produce.
   *
   * `postJournalEntry` because that is the funnel every module's money goes
   * through, so a report reading the ledger reads this the same way it reads
   * anything real. Two accounts of its own, created through the route that
   * creates accounts.
   */
  for (const [code, name, type] of [
    ["9101", "Tenancy marker debit", "asset"],
    ["9102", "Tenancy marker credit", "income"],
  ] as const) {
    const made = await registerForTest(accounting).request(
      "http://localhost/api/accounts",
      {
        method: "POST",
        headers: bHeaders,
        body: JSON.stringify({ code, name, type }),
      },
    );
    if (made.status >= 400) {
      throw new Error(`seeding account ${code} answered ${made.status}`);
    }
  }
  const bAccounts = await db
    .select({ id: schema.accounts.id, code: schema.accounts.code })
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, bOrgId));
  const debit = bAccounts.find((a) => a.code === "9101");
  const credit = bAccounts.find((a) => a.code === "9102");
  if (!debit || !credit) throw new Error("the marker accounts went missing");

  await postJournalEntry(bOrgId, "tenancy marker", "test", [
    { accountId: debit.id, debitCents: AMOUNT },
    { accountId: credit.id, creditCents: AMOUNT },
  ]);

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
    // The id of whatever was just made, whatever the route calls the thing:
    // every create here answers with a single object under a single key.
    const made = (await res.json()) as Record<string, { id?: string }>;
    for (const value of Object.values(made)) {
      if (value && typeof value === "object" && typeof value.id === "string") {
        bIds.push(value.id);
      }
    }
  }

  const bAccountIds = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(eq(schema.accounts.organizationId, bOrgId));
  bIds.push(...bAccountIds.map((a) => a.id), bOrgId, bUserId);
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

/**
 * Everything the second business owns, in a form two of them can be compared.
 *
 * Ordered by id so the comparison is about content rather than the order a
 * database felt like returning rows in.
 */
async function whatBeeHas(): Promise<string> {
  const rows = await Promise.all([
    db
      .select()
      .from(schema.contacts)
      .where(eq(schema.contacts.organizationId, bOrgId))
      .orderBy(schema.contacts.id),
    db
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.organizationId, bOrgId))
      .orderBy(schema.companies.id),
    db
      .select()
      .from(schema.deals)
      .where(eq(schema.deals.organizationId, bOrgId))
      .orderBy(schema.deals.id),
    db
      .select()
      .from(schema.tags)
      .where(eq(schema.tags.organizationId, bOrgId))
      .orderBy(schema.tags.id),
    db
      .select()
      .from(schema.accounts)
      .where(eq(schema.accounts.organizationId, bOrgId))
      .orderBy(schema.accounts.id),
    db
      .select()
      .from(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, bOrgId))
      .orderBy(schema.journalEntries.id),
    db.select().from(schema.member).where(eq(schema.member.userId, bUserId)),
    db.select().from(schema.user).where(eq(schema.user.id, bUserId)),
  ]);
  return JSON.stringify(rows);
}

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

/*
 * Named for what it can see.
 *
 * The sweep visits every GET route in the modules above, and can only *detect*
 * a leak where the other business has a row carrying the marker. A module with
 * no seed still has its reads swept and contributes nothing to catch them
 * with — which is why the seed list matters more than the module list, and why
 * it grew on 2026-09-09 after a removed filter went unnoticed.
 */
test("no read returns another business's marked rows", async () => {
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
      const body = await res.text();
      if (body.includes(MARKER)) {
        leaked.push(`${name}: GET ${route.path} → ${res.status}`);
      } else if (body.includes(String(AMOUNT))) {
        // The figure rather than the name: a total counting both businesses
        // has nobody's name in it.
        leaked.push(
          `${name}: GET ${route.path} → ${res.status} (the other business's money)`,
        );
      }
    }
  }

  expect(checked).toBeGreaterThan(20);
  // Named rather than counted, so a regression says which door opened.
  expect(leaked).toEqual([]);
}, 120_000);

/**
 * The dashboard is a screen of *figures*, and both markers are blind to it.
 *
 * It returns counts and totals, so a name never appears and the marker amount
 * is not one of the sums it makes — unscoping its contact query and its
 * invoice query in turn changed nothing the sweep above could see. That is
 * exactly the case every one of these files says wants "assertions where the
 * figures are computed", and this is one.
 *
 * The assertion is that **the first business's dashboard is empty**, because
 * the first business has nothing: no invoice, no quote, no task, no deal. Any
 * query that stops being scoped brings in the second business's rows — or a
 * previous run's — and something stops being zero.
 *
 * Shape-independent on purpose. Naming the fields would pin today's payload
 * and quietly stop covering whatever is added next; walking it means a figure
 * added tomorrow is covered the day it is written.
 */
test("the dashboard shows a business nothing but its own", async () => {
  const app = registerForTest(dashboard);
  const res = await app.request("http://localhost/api/dashboard", {
    headers: aHeaders,
  });
  expect(res.status).toBe(200);
  const payload = (await res.json()) as unknown;

  const nonEmpty: string[] = [];
  const walk = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      // `widgets` and `tabs` are the screen's own furniture — what it can
      // show, not what this business has.
      if (!/widgets|tabs|startHere/.test(path) && value.length > 0) {
        nonEmpty.push(`${path} has ${value.length}`);
      }
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      return;
    }
    /*
     * `health` is the server, not the business — uptime, disk, memory, the
     * size of the database. The same numbers for everybody on this instance,
     * and nobody's data.
     */
    if (
      typeof value === "number" &&
      value !== 0 &&
      !/health|tier|Version/.test(path)
    ) {
      nonEmpty.push(`${path} is ${value}`);
    }
  };
  walk(payload, "dashboard");

  expect(nonEmpty).toEqual([]);
}, 60_000);

/**
 * And nothing one business does changes another business's records.
 *
 * Every sweep in this file until now has been about *reading*. A read that
 * crosses businesses shows somebody what they should not see; a write that
 * crosses businesses edits somebody else's books, and no sweep asked about
 * those at all. Only the Users module tried, by hand, with a list of fifteen
 * routes written out.
 *
 * Measured on 2026-09-10, the same way as everything else here: the
 * `organizationId` filter was removed from the update and delete queries in
 * each file in turn. Twenty-nine files of thirty-seven survived it with the
 * whole suite green, and the eight that did not were each caught by a test
 * written on purpose for exactly one route — which is the shape this
 * generalises.
 *
 * **That twenty-nine is not twenty-nine holes, and reading it as one would be
 * the mistake this file has already made once.** The chart of accounts is
 * typical: both its write routes call `ownedAccount(orgId, id)` first and
 * answer 404 before touching anything, so the filter on the update behind it
 * changes no behaviour when it goes. It is belt and braces, and a redundant
 * guard hides a missing one — the same lesson the ledger join taught on
 * 2026-09-09, in the other direction.
 *
 * So the mutation this stands against is a file losing tenancy *altogether*,
 * guard and filter together, which is what a wrong `orgId` or a copied helper
 * actually looks like. Done to CRM settings, it fails here by name.
 *
 * **The assertion is that B is untouched, not that A was refused.** A refusal
 * is easy to check and easy to get wrong in the flattering direction: a route
 * that answers 404 because a fictional id matched nothing looks identical to
 * one that refused, and a route with a path parameter that is not an id at all
 * — a settings key, a currency code — can answer 200 without anybody's rows
 * moving. What cannot be argued with is the second business's records before
 * and after, byte for byte.
 *
 * **Every id against every route**, rather than matching a kind of id to a
 * kind of route. Offering a contact id to the route that archives a deal
 * costs a millisecond and proves nothing; deciding by hand which id belongs
 * where is how the one route nobody thought about stays unswept.
 *
 * **What limits it is the seed list, again.** A route can only be caught
 * changing something the second business owns, so the price book — where B has
 * no items — survives having every filter in the file removed. The same was
 * true of tags until a tag was seeded, and of the ledger until a journal entry
 * was. The list at the top of this file is the reach of every sweep in it.
 *
 * The bodies are `{}`, which several routes reject before reaching their
 * query; a route whose validation refuses an empty body is swept without being
 * tried. Filling in a plausible body per route is the hand-written list this
 * deliberately is not.
 */
test("no write reaches another business's rows", async () => {
  const before = await whatBeeHas();
  let attempts = 0;

  for (const mod of Object.values(MODULES)) {
    const app = registerForTest(mod) as unknown as {
      routes?: { method: string; path: string }[];
      request: (url: string, init?: RequestInit) => Promise<Response>;
    };

    const seen = new Set<string>();
    for (const route of app.routes ?? []) {
      if (route.method === "GET" || route.method === "ALL") continue;
      if (!route.path.includes(":")) continue;
      const key = `${route.method} ${route.path}`;
      if (seen.has(key)) continue;
      seen.add(key);

      for (const id of bIds) {
        const path = route.path.replace(/:[A-Za-z]+/g, id);
        attempts += 1;
        await app.request(`http://localhost${path}`, {
          method: route.method,
          headers: aHeaders,
          ...(route.method === "DELETE" ? {} : { body: "{}" }),
        });
      }
    }
  }

  // A sweep that quietly tried nothing would otherwise pass as "nothing was
  // changed".
  expect(attempts).toBeGreaterThan(200);
  expect(await whatBeeHas()).toEqual(before);
}, 300_000);
