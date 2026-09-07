import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";
import { invoicingDashboard, invoicingFigures } from "./summary";

/**
 * Invoicing's own front page, against a business with a history.
 *
 * It had no test at all, and it was the screen that broke on a demo seeded to
 * look like three months of trading — several months of invoices, some late,
 * some still drafts. Every case below is one of those.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;

beforeAll(async () => {
  invoicing.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerJob: () => {},
  });

  const signUp = await signUpAsOwner({
    email: `invoicing-summary-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Summary ${suffix}`, slug: `summary-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });

  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Halloway", email: "ap@h.test" })
    .returning();
  if (!contact) throw new Error("could not create test contact");
  contactId = contact.id;
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const ids = entries.map((e) => e.id);
  if (ids.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, ids));
    await db
      .delete(schema.journalEntries)
      .where(eq(schema.journalEntries.organizationId, orgId));
  }
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
});

async function makeInvoice(cents: number, issueDate?: Date, draft = false) {
  const created = await app.request("http://localhost/api/invoices", {
    method: "POST",
    headers,
    body: JSON.stringify({
      contactId,
      currency: "USD",
      ...(issueDate ? { issueDate: issueDate.toISOString() } : {}),
      ...(draft ? { status: "draft" } : {}),
      lines: [
        {
          description: "Advice",
          quantity: 1,
          unitPrice: cents,
          taxRateBp: 0,
        },
      ],
    }),
  });
  expect(created.status).toBe(201);
  const { invoice } = (await created.json()) as { invoice: { id: string } };
  return invoice.id;
}

test("the dashboard answers for a business with months of history", async () => {
  const now = new Date();
  const monthsAgo = (n: number) =>
    new Date(now.getFullYear(), now.getMonth() - n, 12);

  // Three months of issued work, one of them late, and a draft nobody sent.
  const old = await makeInvoice(120_000, monthsAgo(3));
  const middle = await makeInvoice(90_000, monthsAgo(2));
  const late = await makeInvoice(45_000, monthsAgo(1));
  await makeInvoice(30_000, undefined, true);

  // One of them past its date, which is the row the late list is built from.
  await db
    .update(schema.invoices)
    .set({ dueDate: new Date(now.getTime() - 9 * 24 * 60 * 60 * 1000) })
    .where(eq(schema.invoices.id, late));

  const dashboard = await invoicingDashboard(orgId);

  expect(dashboard.figures.length).toBe(4);
  // Several months, and each one a month rather than a day.
  expect(dashboard.months.length).toBeGreaterThan(1);
  for (const month of dashboard.months) {
    expect(month.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Number.isInteger(month.billedCents)).toBe(true);
  }
  // The late row carries a whole number of days, not an object the screen
  // then has to guess at.
  expect(dashboard.late.length).toBe(1);
  expect(dashboard.late[0]?.daysLate).toBe(9);
  expect(dashboard.drafts.length).toBe(1);
});

test("a business with nothing in it still answers", async () => {
  const [empty] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Empty ${suffix}`,
      slug: `empty-${suffix}`,
      createdAt: new Date(),
    })
    .returning();
  if (!empty) throw new Error("could not create empty organization");

  // `finally`, because a leftover organization is not a tidiness problem: the
  // bootstrap suite refuses to claim an instance that already has one, and a
  // failure here reappears as five unrelated tests failing in another file.
  try {
    const figures = await invoicingFigures(empty.id);
    expect(figures.every((f) => f.value === 0)).toBe(true);

    const dashboard = await invoicingDashboard(empty.id);
    expect(dashboard.months).toEqual([]);
    expect(dashboard.late).toEqual([]);
    expect(dashboard.drafts).toEqual([]);
  } finally {
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, empty.id));
  }
});
