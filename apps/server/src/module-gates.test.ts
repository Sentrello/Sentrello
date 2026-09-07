import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, inArray, schema } from "@sentrello/db";
import accounting from "@sentrello/module-accounting";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import invoicing from "@sentrello/module-invoicing";
import { registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";

/**
 * No route in any Free module answers somebody who may not use it.
 *
 * Features are gated twice, by design: modules load only when entitled, and
 * routes guard with `requirePermission`. The Users
 * console's own review found twenty-one of its twenty-nine gates could be
 * deleted with the whole suite still green — not because they were wrong, but
 * because nothing in the suite ever called a route as somebody who lacked the
 * permission. Every module here had the same hole.
 *
 * Rather than a table per module — six of them, 164 gates, and a seventh
 * module tomorrow — this asks Hono for the routes each module actually
 * registered and walks every one. A route added next year is covered the day
 * it is written, by nobody remembering anything.
 *
 * **403, not "did not succeed".** An earlier version of this checked for a
 * non-2xx and proved nothing: every path here names a fictional id, so a route
 * whose gate had been deleted answered 404 from its own lookup and looked
 * exactly like one that had refused. Insisting on 403 also pins something
 * worth pinning — the guard runs *before* the record is looked up, so a
 * refusal never depends on whether the record exists, and never tells an
 * unauthorised caller whether it does.
 */

const MODULES = {
  crm,
  invoicing,
  accounting,
  settings,
  dashboard,
};

/**
 * Routes that answer anybody, on purpose. Each is reachable without a session
 * by design, so 403 is the wrong answer and this list is what says so.
 *
 * **This list is the product's entire anonymous surface**, which is why the
 * sweep below covers routes outside `/api` as well. It used to stop at `/api`,
 * and the four public pages — the customer portal, a shared document, the
 * letterhead logo, the embed script — were pinned by nothing at all: a fifth
 * could have been added and no test would have noticed. Adding one now fails
 * this test until somebody writes it down here, which is the point.
 *
 * Every entry has been read. What each is authenticated by, since none of them
 * has a session to check:
 */
const PUBLIC_BY_DESIGN = new Set([
  // A mail provider posting a reply into the CRM. Authenticated by the secret
  // in the path — there is no session to have, because the caller is a robot
  // at another company.
  "POST /api/crm/inbound-email/:orgId/:secret",
  // A form embedded on somebody's public website: the visitor filling it in is
  // a member of nothing and must never be asked to sign in. Rate-limited, and
  // protected by a honeypot.
  "GET /api/embed/forms/:key",
  "POST /api/embed/forms/:key",
  // The script that renders those forms on a third-party page. Static, carries
  // no data, and reads nothing about who asked for it.
  "GET /embed.js",
  // The customer portal. Authenticated by a 32-byte token that is the whole
  // credential, compared in constant time (`db/portal.ts`) — a customer of a
  // small business will not register an account to read an invoice.
  "GET /portal/:token",
  "POST /portal/:token/quotes/:id/accept",
  // A document someone was sent a link to. A 24-byte token, per document,
  // revocable by rotating it.
  "GET /share/invoice/:token",
  "GET /share/quote/:token",
  // The letterhead on those documents. Keyed by template id rather than a
  // token on purpose: the person reading a shared invoice has the link, not
  // the business's session, and the logo is already printed on everything that
  // business sends. Rate-limited, `default-src 'none'`, and `nosniff`.
  "GET /share/template/:id/logo",
]);

const suffix = crypto.randomUUID().slice(0, 8);
const ownerEmail = `gates-sweep-owner-${suffix}@example.test`;
const memberEmail = `gates-sweep-member-${suffix}@example.test`;

let orgId: string;
let memberHeaders: Headers;
let ownerId: string;
let memberId: string;

beforeAll(async () => {
  const owner = await signUpAsOwner({
    email: ownerEmail,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const ownerCookie = owner.headers.get("set-cookie");
  if (!ownerCookie) throw new Error("sign-up returned no session cookie");
  ownerId = owner.response.user.id;

  const org = await auth.api.createOrganization({
    body: { name: `Gate sweep ${suffix}`, slug: `gate-sweep-${suffix}` },
    headers: new Headers({
      cookie: ownerCookie,
      "content-type": "application/json",
    }),
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  // A real member of the business holding the compiled `member` role, which
  // carries no statement for any module — an ordinary employee before anybody
  // has given them anything, or a customer with a portal account.
  const member = await signUpAsOwner({
    email: memberEmail,
    password: "correct-horse-battery-staple",
    name: "An Employee",
  });
  const memberCookie = member.headers.get("set-cookie");
  if (!memberCookie) throw new Error("sign-up returned no session cookie");
  memberId = member.response.user.id;
  memberHeaders = new Headers({
    cookie: memberCookie,
    "content-type": "application/json",
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: memberId,
    role: "member",
    baseRole: "member",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: memberHeaders,
  });
});

afterAll(async () => {
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db
    .delete(schema.session)
    .where(inArray(schema.session.userId, [ownerId, memberId]));
  await db
    .delete(schema.account)
    .where(inArray(schema.account.userId, [ownerId, memberId]));
  await db
    .delete(schema.user)
    .where(inArray(schema.user.id, [ownerId, memberId]));
});

test("no Free module answers a member who holds no permissions", async () => {
  const answered: string[] = [];
  let checked = 0;

  for (const [name, mod] of Object.entries(MODULES)) {
    const app = registerForTest(mod) as unknown as {
      routes?: { method: string; path: string }[];
      request: (url: string, init?: RequestInit) => Promise<Response>;
    };

    const seen = new Set<string>();
    for (const route of app.routes ?? []) {
      // `ALL` entries are the middleware Hono records beside each route.
      if (route.method === "ALL") continue;
      const key = `${route.method} ${route.path}`;
      if (seen.has(key) || PUBLIC_BY_DESIGN.has(key)) continue;
      seen.add(key);
      checked += 1;

      // Fictional ids throughout: a refusal must not depend on the record
      // existing, and this is also what makes the 403 assertion meaningful.
      const path = route.path.replace(/:[A-Za-z]+/g, "nothing");
      const res = await app.request(`http://localhost${path}`, {
        method: route.method,
        headers: memberHeaders,
        ...(route.method === "GET" || route.method === "DELETE"
          ? {}
          : { body: "{}" }),
      });
      if (res.status !== 403) {
        answered.push(`${name}: ${key} → ${res.status}`);
      }
    }
  }

  // The count is asserted so an enumeration that quietly returns nothing
  // cannot pass as "every route refused".
  expect(checked).toBeGreaterThan(100);
  // Named rather than counted, so a regression says which door opened.
  expect(answered).toEqual([]);
}, 120_000);
