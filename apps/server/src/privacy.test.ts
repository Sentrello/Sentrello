import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import { clearPersonalData, registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";

/**
 * A subject access request, answered across more than one module.
 *
 * This is the whole point of the registry and the only thing worth testing
 * about it. A person asks once; the CRM holds their contact record and
 * invoicing holds their invoices, and the answer has to contain both without
 * Core naming either module.
 *
 * **All three modules are real.** A stub registration would prove the loop runs
 * over an array. What it would not prove is that a module's own export actually
 * finds anything, or that invoicing genuinely refuses to erase — which is the
 * behaviour a business would be relying on when it tells somebody what it kept.
 */
const suffix = crypto.randomUUID().slice(0, 8);

// The registry is module-level state and other suites in this process register
// into it too. Cleared first, so this file asserts on its own three modules
// rather than on whatever ran before it.
clearPersonalData();
const app = registerForTest(settings);
registerForTest(crm, app);
registerForTest(invoicing, app);

let headers: Headers;
let orgId: string;
const email = `subject-${suffix}@example.test`;

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, { headers, ...init });
const post = (path: string, body: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body) });
const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;

beforeAll(async () => {
  const signUp = await signUpAsOwner({
    email: `owner-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Privacy ${suffix}`, slug: `privacy-${suffix}` },
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
  const tidy = async (run: () => Promise<unknown>) => {
    await run().catch(() => {});
  };
  // Written out rather than looped: invoice lines hang off an invoice and have
  // no organization of their own, so one loop over "tables with an org column"
  // does not describe them.
  await tidy(async () => {
    const invoices = await db
      .select({ id: schema.invoices.id })
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, orgId));
    for (const i of invoices) {
      await db
        .delete(schema.invoiceLines)
        .where(eq(schema.invoiceLines.invoiceId, i.id));
    }
  });
  await tidy(() =>
    db.delete(schema.invoices).where(eq(schema.invoices.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.notes).where(eq(schema.notes.organizationId, orgId)),
  );
  await tidy(() =>
    db
      .delete(schema.activities)
      .where(eq(schema.activities.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.contacts).where(eq(schema.contacts.organizationId, orgId)),
  );
  await tidy(() =>
    db
      .delete(schema.securityEvents)
      .where(eq(schema.securityEvents.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.member).where(eq(schema.member.organizationId, orgId)),
  );
  await tidy(() =>
    db.delete(schema.organizations).where(eq(schema.organizations.id, orgId)),
  );
});

test("every module that holds personal data says so, with a retention period", async () => {
  const { sources } = await json<{
    sources: { id: string; retention: string; canErase: boolean }[];
  }>(await req("/api/privacy/sources"));

  const ids = sources.map((s) => s.id);
  expect(ids).toContain("crm");
  expect(ids).toContain("invoicing");

  // Required, because a record of processing that cannot say how long data is
  // kept is not a record of processing.
  for (const s of sources) expect(s.retention.length).toBeGreaterThan(10);

  // And invoicing says out loud that it cannot erase, rather than offering an
  // erasure that would quietly do nothing.
  expect(sources.find((s) => s.id === "invoicing")?.canErase).toBe(false);
  expect(sources.find((s) => s.id === "crm")?.canErase).toBe(true);
});

test("one request gathers what two modules hold about the same person", async () => {
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: `Okafor ${suffix}`, email })
    .returning();
  if (!contact) throw new Error("no contact");

  await db.insert(schema.notes).values({
    organizationId: orgId,
    entityType: "contact",
    entityId: contact.id,
    text: "Prefers a morning appointment",
  });

  const made = await post("/api/invoices", {
    contactId: contact.id,
    status: "draft",
    lines: [{ description: "Kitchen", quantity: 1, unitPrice: 50_000 }],
  });
  expect(made.status).toBe(201);

  const dump = await json<{
    total: number;
    sources: { source: string; records: { kind: string }[]; error?: string }[];
  }>(await post("/api/privacy/export", { email }));

  // No module may fail silently: an export missing one module's records is a
  // legal answer that is wrong.
  for (const s of dump.sources) expect(s.error).toBeUndefined();

  const kinds = dump.sources.flatMap((s) => s.records.map((r) => r.kind));
  expect(kinds).toContain("Contact");
  expect(kinds).toContain("Note");
  expect(kinds).toContain("Invoice");
});

test("erasure removes what may go, keeps what may not, and says which", async () => {
  const erased = await post("/api/privacy/erase", {
    email,
    note: "replied from the address on file",
  });
  expect(erased.status).toBe(200);
  const result = await json<{
    sources: {
      source: string;
      removed: string[];
      kept: { what: string; why: string }[];
    }[];
  }>(erased);

  const crmResult = result.sources.find((s) => s.source === "crm");
  expect(crmResult?.removed.join(" ")).toContain("contact record");

  /**
   * The part that makes the answer lawful rather than merely reassuring.
   *
   * Invoicing must appear in the result saying what it kept and why. A business
   * that tells somebody "everything is gone" while the ledger still names them
   * has made a false statement in writing, and this is the line that stops the
   * screen implying it.
   */
  const invoiceResult = result.sources.find((s) => s.source === "invoicing");
  expect(invoiceResult?.removed).toEqual([]);
  expect(invoiceResult?.kept.length).toBeGreaterThan(0);
  expect(invoiceResult?.kept[0]?.why.length).toBeGreaterThan(10);

  // And the contact really is gone, not merely reported as gone.
  const left = await db
    .select()
    .from(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
  expect(left.filter((c) => c.email === email)).toHaveLength(0);
});

test("an erasure will not run without a note saying how it was verified", async () => {
  const refused = await post("/api/privacy/erase", { email });
  expect(refused.status).toBe(400);
});

test("what was done is written down, because it will be asked about", async () => {
  const { requests } = await json<{
    requests: { action: string; detail: Record<string, unknown> | null }[];
  }>(await req("/api/privacy/requests"));

  const actions = requests.map((r) => r.action);
  expect(actions).toContain("privacy.exported");
  expect(actions).toContain("privacy.erased");

  const erasure = requests.find((r) => r.action === "privacy.erased");
  expect(erasure?.detail?.verifiedBy).toBe("replied from the address on file");
});
