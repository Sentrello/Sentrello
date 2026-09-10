import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema, watchQueries } from "@sentrello/db";
import { eq, inArray, sql } from "@sentrello/db/orm";
import accounting from "@sentrello/module-accounting";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import invoicing from "@sentrello/module-invoicing";
import profile from "@sentrello/module-profile";
import { personalDataSources, registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";

/**
 * Every business read names the business.
 *
 * The sibling sweeps ask what a caller can *see* — `module-tenancy.test.ts`
 * puts a marked row in a second business and looks for it in the first
 * business's responses. That is the property that matters, and it is held
 * back by the one thing a response body cannot supply: a marker has to exist
 * in the table the query reads. A business with no bank feed, no HMRC
 * connection, no budget and no fixed asset contributes no marker to any of
 * those tables, so the reads that serve them are swept and nothing is ever
 * found.
 *
 * Measured rather than assumed, on 2026-09-10: every `organizationId` filter
 * in a read query was neutered one file at a time, whole suite per mutant.
 * **Twenty-seven files could lose every one of their filters with all 1,287
 * tests still green** — among them the subject-access export in all three
 * modules that hold personal data, the HMRC connection with its access token,
 * the payment-processor credentials, and every bank-feed read in accounting.
 * Not twenty-seven bugs. Twenty-seven places where a wrong one ships unseen.
 *
 * So this test reads the **query** instead of the answer. It watches the SQL
 * each route runs and asks one thing of it: a select that reads a table
 * carrying `organization_id` must mention `organization_id`. No seed, no
 * marker, no second business — which is exactly why it reaches the routes the
 * marker never could, and why a route added next year is covered the day it
 * is written.
 *
 * Which table is org-scoped is asked of the database rather than listed here,
 * so a table added by a migration is covered without anybody remembering to
 * write it down.
 *
 * **What it cannot see, measured the same way.** The sweep was run again over
 * every file, with the pattern widened to catch the generic CRUD helper's
 * `eq(table.organizationId, orgId)` — which the first pass had never matched,
 * so thirty-six filters serving contacts, companies, deals, notes and tasks
 * had gone unmeasured while looking measured. Sixty-seven files of
 * seventy-six now fail when their read filters go.
 *
 * **Seven still do not**, and they have one thing in common: no route and no
 * export reads them. They are helpers on the write path and shared code in
 * `packages/db` that a job reaches — `taxes`, three files in invoicing's
 * document lifecycle, `consent`, `documents`, `payments`. A sweep of what a
 * caller can read cannot reach code that only runs while something is being
 * written, and calling every write to find out would send mail and delete
 * rows.
 *
 * It reads the shape of the query, not its meaning: a filter naming the wrong
 * business, or `organization_id` mentioned in a join
 * that leaves the other side unscoped, both satisfy it. The ledger join is
 * scoped on both sides on purpose, and this test would accept it with either
 * side gone — `module-tenancy.test.ts` is what stands behind that. The two
 * belong together; neither is sufficient alone.
 */

const MODULES = {
  crm,
  invoicing,
  accounting,
  users,
  dashboard,
  settings,
  profile,
};

/**
 * Routes that answer somebody who is in no business at all, so there is no
 * business for their queries to name.
 *
 * `module-gates.test.ts` holds the full list of what is reachable without a
 * session and what authenticates each one; this is the subset of it that
 * reaches the database. A form embedded on a public website is fetched by its
 * key — the visitor filling it in is a member of nothing, and the key is the
 * whole credential.
 */
const PUBLIC_BY_DESIGN = new Set([
  "/api/embed/forms/:key",
  // The letterhead on a shared invoice, keyed by template id rather than by a
  // token on purpose: whoever opens that link has the link and not the
  // business's session, and the logo is already printed on everything that
  // business sends.
  "/share/template/:id/logo",
]);

/**
 * Tables that carry `organization_id` but are read without it, for a reason.
 *
 * Every entry has been read, and each is a table the *platform* owns rather
 * than a module: the caller's own identity, resolved before anybody knows
 * which business is being asked about. A module read of one of these is not
 * covered here — `packages/modules-free/users/src/tenancy.test.ts` covers
 * those behaviourally, with two businesses and a marker.
 */
const PLATFORM_TABLES = new Set([
  // Who is asking, and which business they have open. Better Auth resolves
  // the session by its token and the membership by user id — there is no
  // organization to filter by until this query has answered.
  "member",
  "session",
]);

const suffix = crypto.randomUUID().slice(0, 8);
const email = `scoping-${suffix}@example.test`;

let headers: Headers;
let orgId: string;
let userId: string;
/** Every table in the database that carries an `organization_id`. */
let scoped: Set<string>;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  userId = signUp.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Scoping ${suffix}`, slug: `scoping-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });

  /*
   * Asked of the database rather than mirrored from the schema files: this is
   * the list of tables that *are* org-scoped, so a table added by a migration
   * is covered without anybody adding it to a list here.
   */
  const rows = await db.execute<{ table_name: string }>(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'organization_id'
  `);
  scoped = new Set([...rows].map((r) => r.table_name));
});

afterAll(async () => {
  watchQueries.onQuery = undefined;
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, [userId]));
  await db
    .delete(schema.account)
    .where(inArray(schema.account.userId, [userId]));
  await db.delete(schema.user).where(inArray(schema.user.id, [userId]));
});

/** The tables a statement reads, from its `from` and `join` clauses. */
function tablesRead(query: string): string[] {
  return [...query.matchAll(/(?:from|join)\s+"([a-z_]+)"/g)].flatMap(
    (m) => m[1] ?? [],
  );
}

test("no read runs a query that leaves out the business", async () => {
  const unscoped: string[] = [];
  let queries = 0;

  /** Every select in `captured`, judged. */
  const inspect = (what: string, captured: string[]) => {
    for (const query of captured) {
      const text = query.toLowerCase();
      if (!text.startsWith("select")) continue;
      queries += 1;
      /*
       * From the first `from` onwards, because `select *` lists every column
       * and `organization_id` is one of them. Reading the whole statement
       * passed an unscoped query on its own column list — the first version
       * of this test did, and caught nothing.
       */
      const clauses = text.slice(text.indexOf(" from "));
      if (clauses.includes("organization_id")) continue;
      for (const table of tablesRead(clauses)) {
        if (!scoped.has(table) || PLATFORM_TABLES.has(table)) continue;
        unscoped.push(`${what} reads "${table}"`);
      }
    }
  };

  for (const [name, mod] of Object.entries(MODULES)) {
    const app = registerForTest(mod) as unknown as {
      routes?: { method: string; path: string }[];
      request: (url: string, init?: RequestInit) => Promise<Response>;
    };

    const seen = new Set<string>();
    for (const route of app.routes ?? []) {
      if (route.method !== "GET" || !route.path.startsWith("/api")) continue;
      if (seen.has(route.path)) continue;
      seen.add(route.path);

      const captured: string[] = [];
      watchQueries.onQuery = (q) => captured.push(q);
      const path = route.path.replace(/:[A-Za-z]+/g, "nothing");
      await app.request(`http://localhost${path}`, { headers });
      watchQueries.onQuery = undefined;

      if (PUBLIC_BY_DESIGN.has(route.path)) continue;
      inspect(`${name}: GET ${route.path}`, captured);
    }
  }

  /*
   * The host's own routes, which belong to no module and were swept by
   * nothing.
   *
   * `/api/_meta` is the one that matters: it decides what the browser is
   * offered — which optional modules this business has switched on, which
   * role the caller holds, what a custom role permits — and it reads
   * `module_state`, `member` and `organization_role` to do it. A sweep built
   * out of module route tables cannot see it, and neither could the marker
   * sweep, because what it returns is a menu rather than anybody's rows.
   *
   * Better Auth's own surface under `/api/auth` is left alone: it is not ours,
   * it is covered in `packages/auth`, and a GET there can end a session.
   */
  const host = (await import("./index")).app as unknown as {
    routes?: { method: string; path: string }[];
    request: (url: string, init?: RequestInit) => Promise<Response>;
  };
  const hostSeen = new Set<string>();
  for (const route of host.routes ?? []) {
    if (route.method !== "GET" || route.path.startsWith("/api/auth")) continue;
    if (hostSeen.has(route.path)) continue;
    hostSeen.add(route.path);

    const captured: string[] = [];
    watchQueries.onQuery = (q) => captured.push(q);
    const path = route.path.replace(/:[A-Za-z]+/g, "nothing");
    await host.request(`http://localhost${path}`, { headers });
    watchQueries.onQuery = undefined;

    if (PUBLIC_BY_DESIGN.has(route.path)) continue;
    inspect(`host: GET ${route.path}`, captured);
  }

  /*
   * `/api/_meta` again, for somebody holding a role their business wrote.
   *
   * The permissions of a compiled role are in the binary; a custom one is a
   * row, and reading it is a branch an owner never takes — so the sweep above
   * runs `/api/_meta` without ever touching the query that reads it. Two
   * businesses that both call a role "Bookkeeper" is not a strange case, it is
   * the expected one, and an unscoped read there hands somebody the other
   * business's idea of what a bookkeeper may open.
   */
  const customRole = `role-${suffix}`;
  await db.insert(schema.organizationRole).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    role: customRole,
    permission: JSON.stringify({ crm: ["read"] }),
  });
  await db
    .update(schema.member)
    .set({ role: customRole })
    .where(eq(schema.member.userId, userId));

  const customCaptured: string[] = [];
  watchQueries.onQuery = (q) => customCaptured.push(q);
  await host.request("http://localhost/api/_meta", { headers });
  watchQueries.onQuery = undefined;
  inspect("host: GET /api/_meta as a custom role", customCaptured);

  await db
    .delete(schema.organizationRole)
    .where(eq(schema.organizationRole.organizationId, orgId));
  await db
    .update(schema.member)
    .set({ role: "owner" })
    .where(eq(schema.member.userId, userId));

  /*
   * And the reads that belong to no route at all.
   *
   * A subject access request runs every source a module registered, and those
   * functions are called by the privacy screen rather than served as routes —
   * so a sweep of the route table walks straight past them. All three modules
   * that hold personal data were among the filters nothing held, and a leak
   * here is the one that gets written down and handed to a regulator: a
   * business asking "what do you have about this person" and being given
   * another business's answer.
   *
   * `export` is read-only by contract, which is why it can be swept and
   * `erase` cannot.
   */
  for (const source of personalDataSources()) {
    const captured: string[] = [];
    watchQueries.onQuery = (q) => captured.push(q);
    // By email alone, which is how a request actually arrives — and the ids
    // this platform issues are not uuids, so handing one to a source that
    // looks up a contact by id is an error about types rather than tenancy.
    await source.export(orgId, { email });
    watchQueries.onQuery = undefined;
    inspect(`subject access: ${source.id}`, captured);
  }

  // A sweep that quietly ran nothing would otherwise pass as "every read is
  // scoped". Counted per source, because the host's routes were read off the
  // wrong export for a while and that loop ran zero times without a word.
  expect(queries).toBeGreaterThan(50);
  expect(hostSeen.size).toBeGreaterThan(2);
  // Named rather than counted, so a regression says which query opened.
  expect([...new Set(unscoped)].sort()).toEqual([]);
}, 120_000);
