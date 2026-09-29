import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { dayIn } from "@sentrello/db/day";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { invoicingAccountFigures } from "./account-section";
import invoicing from "./index";
import { invoicingDashboard, invoicingFigures } from "./summary";

/**
 * An invoice due today is not late today — on every surface at once.
 *
 * The product had one definition of overdue, `dueDate < now`, arrived at after
 * three screens were found disagreeing by an instant. It was still wrong: a due
 * date is stored as midnight UTC because it names a day, so an invoice due on
 * the 29th was late from one second past midnight on the 29th — and from eight
 * o'clock on the evening of the 28th for a business in New York, which is the
 * first market.
 *
 * Six surfaces answer this question about the same invoice: the overdue tab,
 * the tab counts, the figures at the top of Invoicing, the late list on its
 * dashboard, the customer's own account page, and the badge. A fix to one of
 * them is not a fix, so the assertions are made together — and against a
 * business whose timezone is set, because that is what decides what day it is.
 *
 * The clock cannot be moved for a route, so the invoices are dated *from* the
 * business's today. Between midnight and four in the morning UTC those dates
 * are not the dates a UTC reading would pick, which makes the same assertions
 * stricter for four hours a day rather than weaker.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const email = `due-today-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();
const ZONE = "America/New_York";
const DAY_MS = 86_400_000;

let orgId: string;
let headers: Headers;
let contactId: string;
let dueToday: string;
let dueYesterday: string;

beforeAll(async () => {
  invoicing.register({
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
    body: { name: `Due today ${suffix}`, slug: `due-today-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
  // Where the business is. Without it the answer is UTC, which is right for a
  // business that has not said and wrong for one that has.
  await db
    .update(schema.organizations)
    .set({ timezone: ZONE })
    .where(eq(schema.organizations.id, orgId));

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Acme Ltd" })
    .returning();
  if (!contact) throw new Error("could not create contact");
  contactId = contact.id;

  const today = dayIn(new Date(), ZONE);
  const rows = await db
    .insert(schema.invoices)
    .values([
      {
        organizationId: orgId,
        contactId,
        number: `TODAY-${suffix}`,
        status: "open",
        dueDate: today,
        subtotalCents: 10_000,
        taxCents: 0,
        totalCents: 10_000,
      },
      {
        organizationId: orgId,
        contactId,
        number: `LATE-${suffix}`,
        status: "open",
        dueDate: new Date(today.getTime() - DAY_MS),
        subtotalCents: 5_000,
        taxCents: 0,
        totalCents: 5_000,
      },
    ])
    .returning();
  const [first, second] = rows;
  if (!first || !second) throw new Error("could not create invoices");
  dueToday = first.id;
  dueYesterday = second.id;
});

afterAll(async () => {
  // Every row this file planted, and the business and user behind it. A suite
  // that leaves an organization in the shared test database makes the next
  // one's bootstrap fail with a 409 that has nothing to do with it.
  for (const [table, column] of [
    [schema.payments, schema.payments.organizationId],
    [schema.invoices, schema.invoices.organizationId],
    [schema.contacts, schema.contacts.organizationId],
    [schema.invoicingSettings, schema.invoicingSettings.organizationId],
  ] as const) {
    await db.delete(table).where(eq(column, orgId));
  }
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  const [owner] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, email));
  if (owner) {
    await db.delete(schema.session).where(eq(schema.session.userId, owner.id));
    await db.delete(schema.account).where(eq(schema.account.userId, owner.id));
    await db.delete(schema.user).where(eq(schema.user.id, owner.id));
  }
});

test("the overdue tab holds yesterday's invoice and not today's", async () => {
  const res = await app.request("http://localhost/api/invoices?tab=overdue", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { invoices: { id: string }[] };
  const ids = body.invoices.map((i) => i.id);
  expect(ids).toContain(dueYesterday);
  expect(ids).not.toContain(dueToday);
});

test("the tab counts agree with the tab", async () => {
  const res = await app.request("http://localhost/api/invoices/counts", {
    headers,
  });
  const { counts } = (await res.json()) as { counts: Record<string, number> };
  expect(counts.overdue).toBe(1);
  // Both are still unpaid, which is the number the business lives in.
  expect(counts.unpaid).toBe(2);
});

test("the list flags yesterday's invoice as late and today's as not", async () => {
  const res = await app.request("http://localhost/api/invoices?tab=unpaid", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    invoices: { id: string; overdue: boolean }[];
  };
  const late = (id: string) =>
    body.invoices.find((invoice) => invoice.id === id)?.overdue;
  expect(late(dueToday)).toBe(false);
  // And yesterday's still turns red — a guard that passes by calling nobody
  // late would be no guard at all.
  expect(late(dueYesterday)).toBe(true);
});

test("the figures and the late list count only yesterday", async () => {
  const figures = await invoicingFigures(orgId);
  const late = figures.find((f) => /late|overdue/i.test(f.label));
  // 5,000 cents is yesterday's invoice alone; 15,000 would be both.
  if (late) expect(late.value).not.toContain("150");

  const dashboard = await invoicingDashboard(orgId);
  const ids = dashboard.late.map((row) => row.id);
  expect(ids).toContain(dueYesterday);
  expect(ids).not.toContain(dueToday);
  // And it is one day late, not two and not nought.
  expect(dashboard.late.find((r) => r.id === dueYesterday)?.daysLate).toBe(1);
});

test("the customer's own account page says the same", async () => {
  const figures = await invoicingAccountFigures(orgId, contactId);
  const overdue = figures.find((f) => /overdue/i.test(String(f.label)));
  expect(overdue).toBeDefined();
  // Yesterday's 5,000 cents, and not today's 10,000 with it.
  expect(overdue?.value).toBe(5_000);
  const owed = figures.find((f) => /you owe/i.test(String(f.label)));
  expect(owed?.value).toBe(15_000);
});
