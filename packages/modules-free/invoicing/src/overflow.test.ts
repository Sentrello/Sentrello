import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";
import { invoicingDashboard, invoicingFigures } from "./summary";

/**
 * A business that has billed more than $21,474,836.47.
 *
 * That figure is 2,147,483,647 cents — the largest 32-bit integer — and the
 * totals across the top of a list screen sum every row the filter matches.
 * On the invoice list that is every invoice the business has ever raised, so
 * the ceiling is not annual revenue but lifetime billing: at $4.3M a year it
 * arrives in the fifth year, and `sum(total_cents)::int` then answers "integer
 * out of range" — a hard 500 on the invoice list, for ever, with no warning
 * and nothing to turn off.
 *
 * Every other test in this module uses figures of a few hundred dollars, which
 * is why five years of a real business found this and none of them did. The
 * assertions here are on the exact totals rather than on the absence of a
 * throw: a sum that came back as a string, or as a float that lost its last
 * digits, would not throw either.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();

/** $10,000,000.00, so three of them are comfortably past the ceiling. */
const TEN_MILLION = 1_000_000_000;

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
    email: `invoicing-overflow-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Overflow ${suffix}`, slug: `overflow-${suffix}` },
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

  // Three invoices of ten million dollars: $30M billed, one payment each
  // month of ten million received. Written directly, because what is being
  // proved is the reading rather than the raising.
  const now = new Date();
  const invoices = await db
    .insert(schema.invoices)
    .values(
      [0, 1, 2].map((n) => ({
        organizationId: orgId,
        contactId,
        number: `OF-${suffix}-${n}`,
        status: "open" as const,
        currency: "USD",
        subtotalCents: TEN_MILLION,
        taxCents: 0,
        totalCents: TEN_MILLION,
        issueDate: now,
        dueDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      })),
    )
    .returning({ id: schema.invoices.id });
  expect(invoices).toHaveLength(3);

  await db.insert(schema.payments).values(
    invoices.map((invoice) => ({
      organizationId: orgId,
      invoiceId: invoice.id,
      amountCents: TEN_MILLION,
      receivedAt: now,
      method: "bank" as const,
    })),
  );
});

afterAll(async () => {
  await db
    .delete(schema.payments)
    .where(eq(schema.payments.organizationId, orgId));
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

test("the invoice list totals thirty million dollars, exactly", async () => {
  const res = await app.request("http://localhost/api/invoices", { headers });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    billedCents: number;
    invoices: { balanceCents: number }[];
  };
  // Not "greater than zero": the exact figure, as an integer, past the point
  // where a 32-bit sum, a float or a string would each be wrong differently.
  expect(body.billedCents).toBe(3 * TEN_MILLION);
  expect(Number.isSafeInteger(body.billedCents)).toBe(true);
  // And the payments, summed per invoice through the same helper, settle
  // them: a string total would have left the balance at the full amount.
  for (const invoice of body.invoices) expect(invoice.balanceCents).toBe(0);
});

test("the dashboard figures are right past the ceiling too", async () => {
  const figures = await invoicingFigures(orgId);
  const received = figures.find((f) => f.label === "Paid this month");
  expect(received?.value).toBe(3 * TEN_MILLION);
  // Paid in full, so nothing is owed — and `owed` is arithmetic on the sums.
  expect(figures.find((f) => f.label === "Owed to you")?.value).toBe(0);

  const dashboard = await invoicingDashboard(orgId);
  const month = dashboard.months.at(-1);
  expect(month?.billedCents).toBe(3 * TEN_MILLION);
  expect(Number.isSafeInteger(month?.billedCents)).toBe(true);
});
