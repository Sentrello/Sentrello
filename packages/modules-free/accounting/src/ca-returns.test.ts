import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import { caTaxAccountCode } from "@sentrello/db/ca-tax";
import { postJournalEntry } from "@sentrello/db/ledger";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import ledgerModule from "./index";

/**
 * The Canadian returns route: the same figures the computation proves,
 * served where the filing screen reads them, with the words a person needs
 * beside numbers they are about to attest to. The arithmetic itself is
 * proven in `@sentrello/db` and in the invoicing flow; what this pins down
 * is the wiring — the route answers, scoped to the session's organization,
 * and the notes match the returns actually present.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const email = `ca-returns-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

beforeAll(async () => {
  ledgerModule.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
    registerWidget: () => {},
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
    body: { name: `CA Returns ${suffix}`, slug: `ca-returns-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  orgId = org.id;
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers,
  });
});

afterAll(async () => {
  const entries = await db
    .select({ id: schema.journalEntries.id })
    .from(schema.journalEntries)
    .where(eq(schema.journalEntries.organizationId, orgId));
  const entryIds = entries.map((e) => e.id);
  if (entryIds.length > 0) {
    await db
      .delete(schema.journalLines)
      .where(inArray(schema.journalLines.entryId, entryIds));
  }
  for (const [table, column] of [
    [schema.journalEntries, schema.journalEntries.organizationId],
    [schema.taxDefinitions, schema.taxDefinitions.organizationId],
    [schema.accounts, schema.accounts.organizationId],
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

test("a business with no Canadian taxes gets no Canadian returns, and no lecture", async () => {
  const res = await app.request("http://localhost/api/accounting/ca-returns", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    gstHst: unknown;
    qst: unknown;
    pst: unknown[];
    notes: string[];
  };
  expect(body.gstHst).toBeNull();
  expect(body.qst).toBeNull();
  expect(body.pst).toHaveLength(0);
  // No GST/HST notes for a business that has no GST/HST to file.
  expect(body.notes.join(" ")).not.toContain("line 109");
});

test("the returns the definitions call for appear, dated notes beside them", async () => {
  // A Manitoba business: GST federally, RST to the province — defined the
  // way an import or a preset would write them, straight to the table.
  const [gst] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: "GST 5%",
      rateBp: 500,
      ratePpm: 50_000,
      regime: "ca",
      jurisdiction: "CA",
    })
    .returning();
  const [rst] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: "RST 7%",
      rateBp: 700,
      ratePpm: 70_000,
      regime: "ca",
      jurisdiction: "CA-MB",
      recoverable: false,
    })
    .returning();
  if (!gst || !rst) throw new Error("could not create tax definitions");

  // A sale posted the way the invoicing flow posts one — the Free tier
  // with no invoicing module still reaches these figures by journal.
  const account = async (code: string, name: string, type: string) => {
    const [row] = await db
      .insert(schema.accounts)
      .values({ organizationId: orgId, code, name, type })
      .returning();
    if (!row) throw new Error(`could not create account ${code}`);
    return row.id;
  };
  const ar = await account("1100", "Accounts Receivable", "asset");
  const income = await account("4000", "Sales", "income");
  const gstAccount = await account(
    caTaxAccountCode(gst.id),
    "Tax Payable — GST 5%",
    "liability",
  );
  const rstAccount = await account(
    caTaxAccountCode(rst.id),
    "Tax Payable — RST 7%",
    "liability",
  );
  await postJournalEntry(orgId, "Sale", `manual:${suffix}`, [
    { accountId: ar, debitCents: 112_000 },
    { accountId: income, creditCents: 100_000 },
    { accountId: gstAccount, creditCents: 5_000 },
    { accountId: rstAccount, creditCents: 7_000 },
  ]);

  const res = await app.request("http://localhost/api/accounting/ca-returns", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    gstHst: { line105CollectedCents: number; line109NetTaxCents: number };
    qst: unknown;
    pst: { jurisdiction: string; dueCents: number }[];
    notes: string[];
  };
  expect(body.gstHst.line105CollectedCents).toBe(5_000);
  expect(body.gstHst.line109NetTaxCents).toBe(5_000);
  expect(body.qst).toBeNull();
  expect(body.pst).toEqual([
    expect.objectContaining({ jurisdiction: "CA-MB", dueCents: 7_000 }),
  ]);

  const notes = body.notes.join(" ");
  // The words that matter: the zeroed federal lines, PST's refusal to
  // recover, the provincial commissions, and the date the forms were
  // checked — a return note without its date is a note going stale.
  expect(notes).toContain("line 109");
  expect(notes).toContain("recover nothing");
  expect(notes).toContain("15 September 2026");
  expect(notes).not.toContain("FPZ-500");
});
