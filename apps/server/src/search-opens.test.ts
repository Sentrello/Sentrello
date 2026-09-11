import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import { clearSearchProviders, searchEverything } from "@sentrello/module-sdk";
import { Hono } from "hono";

/**
 * Every result opens something that exists.
 *
 * A search hit names the screen it opens by id, and that id is typed by hand
 * into a provider far away from the nav entry it refers to. Get it wrong and
 * the result looks perfect, the row is real, and pressing it does nothing at
 * all — the same failure as a menu entry pointing at a screen nobody built,
 * which this codebase has met before.
 *
 * It was met again writing these providers: invoicing's nav entry is
 * `invoicing`, the provider said `invoices`, and every invoice anybody found
 * would have opened nothing. Nothing else would have caught it, which is why
 * this exists.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono();
const navIds = new Set<string>();

let orgId: string;
let userId: string;
let headers: Headers;

beforeAll(async () => {
  clearSearchProviders();

  const context = {
    // biome-ignore lint/suspicious/noExplicitAny: a host standing in for the real one
    app: app as any,
    entitled: () => true,
    registerNav: (entry: { id: string }) => void navIds.add(entry.id),
    registerPermission: () => {},
    registerSummary: () => {},
    registerPersonalData: () => {},
    registerSearch: (provider: unknown) => {
      // Registered for real, so the sweep below asks the same providers a
      // running instance would.
      const { addSearchProvider } = require("@sentrello/module-sdk");
      addSearchProvider(provider);
    },
    provide: () => {},
    registerJob: () => {},
  };
  // biome-ignore lint/suspicious/noExplicitAny: as above
  crm.register(context as any);
  // biome-ignore lint/suspicious/noExplicitAny: as above
  invoicing.register(context as any);

  const signUp = await signUpAsOwner({
    email: `opens-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  userId = signUp.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Opens ${suffix}`, slug: `opens-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;

  // One of everything the providers can find, all sharing a word nothing else
  // in the database has.
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: `Hendersonia ${suffix}` })
    .returning();
  await db
    .insert(schema.companies)
    .values({ organizationId: orgId, name: `Hendersonia Ltd ${suffix}` });
  await db.insert(schema.deals).values({
    organizationId: orgId,
    name: `Hendersonia job ${suffix}`,
    stage: "lead",
  });
  await db.insert(schema.invoices).values({
    organizationId: orgId,
    contactId: contact?.id ?? null,
    number: `Hendersonia-${suffix}`,
    status: "draft",
    currency: "USD",
    subtotalCents: 0,
    taxCents: 0,
    totalCents: 0,
  });
});

afterAll(async () => {
  clearSearchProviders();
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db.delete(schema.deals).where(eq(schema.deals.organizationId, orgId));
  await db
    .delete(schema.companies)
    .where(eq(schema.companies.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await db.delete(schema.account).where(eq(schema.account.userId, userId));
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

test("everything findable opens a screen that exists", async () => {
  const hits = await searchEverything({
    organizationId: orgId,
    q: "Hendersonia",
    limit: 50,
    may: () => true,
  });

  // The seed is deliberately one of each: a sweep that found nothing would
  // pass the assertion below while proving nothing at all.
  expect(hits.map((hit) => hit.kind).sort()).toEqual([
    "Company",
    "Contact",
    "Deal",
    "Invoice",
  ]);

  const wrong = hits
    .filter((hit) => !navIds.has(hit.opens.moduleId))
    .map((hit) => `${hit.kind} opens "${hit.opens.moduleId}"`);
  expect(wrong).toEqual([]);
});

/** And every one of them names the record, or pressing it opens a list. */
test("everything findable names the record it opens", async () => {
  const hits = await searchEverything({
    organizationId: orgId,
    q: "Hendersonia",
    limit: 50,
    may: () => true,
  });
  const anonymous = hits.filter((hit) => !hit.opens.recordId);
  expect(anonymous).toEqual([]);
});
