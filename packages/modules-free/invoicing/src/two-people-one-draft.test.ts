import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import invoicing from "./index";

/**
 * Two people editing one draft, which used to end with one of them losing an
 * afternoon.
 *
 * Both screens load the document, both press Save a minute apart, and the second
 * write landed on top of the first: two 200s, nothing said, and the lines the
 * first person typed were gone. It is rare, and it is the one kind of loss
 * somebody cannot recover by trying again — because they are never told it
 * happened. Flagged on 26 September as worth revisiting after launch; this is
 * that.
 *
 * A caller says which version it is editing and a write against a document that
 * has moved since is refused. The three cases below are the whole contract: a
 * stale claim is refused, a current one is applied, and a caller that claims
 * nothing keeps the behaviour it had — which is what stops this breaking
 * somebody's integration.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;
let contactId: string;
let userId: string;

const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
const call = (path: string, method: string, body?: unknown) =>
  app.request(`http://localhost${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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
    email: `one-draft-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  userId = signUp.response.user.id;
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `One Draft ${suffix}`, slug: `one-draft-${suffix}` },
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
    .values({ organizationId: orgId, name: "Brandt GmbH", email: "b@b.test" })
    .returning();
  if (!contact) throw new Error("could not create a test contact");
  contactId = contact.id;
});

afterAll(async () => {
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));
  await db.delete(schema.session).where(eq(schema.session.userId, userId));
  await db.delete(schema.account).where(eq(schema.account.userId, userId));
  await db.delete(schema.user).where(eq(schema.user.id, userId));
});

/** A draft, and the version two screens would both have loaded. */
async function aDraft() {
  const made = await json<{ invoice: { id: string } }>(
    await call("/api/invoices", "POST", {
      // A draft, because that is the only thing two people can both edit: an
      // issued invoice is in the books and the route refuses to change it at all.
      status: "draft",
      contactId,
      lines: [
        {
          description: "A day on site",
          quantityMilli: 1000,
          unitPriceCents: 50_000,
        },
      ],
    }),
  );
  const read = await json<{ invoice: { id: string; updatedAt: string } }>(
    await call(`/api/invoices/${made.invoice.id}`, "GET"),
  );
  return read.invoice;
}

test("the second person to save is told rather than ignored", async () => {
  const draft = await aDraft();

  // What both screens are holding.
  const bothSaw = draft.updatedAt;
  expect(typeof bothSaw).toBe("string");

  // The first person saves, which moves the document.
  const first = await call(`/api/invoices/${draft.id}`, "PATCH", {
    expectedUpdatedAt: bothSaw,
    notes: "Phoned the customer; they want it split in two.",
  });
  expect(first.status).toBe(200);

  // The second saves what their screen still holds.
  const second = await call(`/api/invoices/${draft.id}`, "PATCH", {
    expectedUpdatedAt: bothSaw,
    notes: "Agreed on the phone — one invoice after all.",
  });
  expect(second.status).toBe(409);
  expect((await json<{ error: string }>(second)).error).toContain(
    "Somebody else changed this",
  );

  // And the first person's work is still there, which is the whole point.
  const [row] = await db
    .select()
    .from(schema.invoices)
    .where(eq(schema.invoices.id, draft.id));
  expect(row?.notes).toBe("Phoned the customer; they want it split in two.");
});

test("a save that claims the current version is applied", async () => {
  const draft = await aDraft();
  const saved = await call(`/api/invoices/${draft.id}`, "PATCH", {
    expectedUpdatedAt: draft.updatedAt,
    notes: "Nobody else is in here.",
  });
  expect(saved.status).toBe(200);

  // And the same screen can save again, because it reads the version back.
  const again = await json<{ invoice: { updatedAt: string } }>(
    await call(`/api/invoices/${draft.id}`, "GET"),
  );
  const twice = await call(`/api/invoices/${draft.id}`, "PATCH", {
    expectedUpdatedAt: again.invoice.updatedAt,
    notes: "Still nobody.",
  });
  expect(twice.status).toBe(200);
});

/**
 * A caller that claims nothing is unchanged, deliberately.
 *
 * Somebody's own script against their own instance has never heard of this, and
 * refusing it would make a compatibility break out of a correctness fix. Our own
 * screens always claim a version, which is where two people actually collide.
 */
test("a caller that claims no version keeps the behaviour it had", async () => {
  const draft = await aDraft();
  await call(`/api/invoices/${draft.id}`, "PATCH", {
    expectedUpdatedAt: draft.updatedAt,
    notes: "Moved on.",
  });

  const blind = await call(`/api/invoices/${draft.id}`, "PATCH", {
    notes: "No claim at all.",
  });
  expect(blind.status).toBe(200);
});

/** A quote is the same document wearing another name, and the same rule. */
test("a quote refuses a stale save too", async () => {
  const made = await json<{ quote: { id: string } }>(
    await call("/api/quotes", "POST", {
      contactId,
      lines: [
        { description: "Scoping", quantityMilli: 1000, unitPriceCents: 20_000 },
      ],
    }),
  );
  const read = await json<{ quote: { id: string; updatedAt: string } }>(
    await call(`/api/quotes/${made.quote.id}`, "GET"),
  );

  const first = await call(`/api/quotes/${read.quote.id}`, "PATCH", {
    expectedUpdatedAt: read.quote.updatedAt,
    notes: "Sent for review.",
  });
  expect(first.status).toBe(200);

  const stale = await call(`/api/quotes/${read.quote.id}`, "PATCH", {
    expectedUpdatedAt: read.quote.updatedAt,
    notes: "Written over the top.",
  });
  expect(stale.status).toBe(409);
});

/**
 * A claim nobody can read, which this ignored until 6 October.
 *
 * The check answered "has it moved: yes or no", so a claim it could not parse —
 * a millisecond timestamp, an object, a date that is not one — came back no and
 * the write went through. A request that looks checked and is not is the fault
 * this mechanism exists to remove, and it was inside the mechanism. On an
 * invoice, where what the second save silently discards is a figure.
 */
for (const claimed of [
  1762440000000,
  { at: "2026-10-06T00:00:00.000Z" },
  "not a date",
  "",
  true,
] as unknown[]) {
  test(`an invoice refuses a claim of ${JSON.stringify(claimed)}`, async () => {
    const draft = await aDraft();
    const res = await call(`/api/invoices/${draft.id}`, "PATCH", {
      expectedUpdatedAt: claimed,
      notes: "Mine",
    });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toContain(
      "expectedUpdatedAt",
    );

    const [row] = await db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.id, draft.id));
    expect(row?.notes).not.toBe("Mine");
  });
}

test("a quote refuses one too", async () => {
  const made = await json<{ quote: { id: string } }>(
    await call("/api/quotes", "POST", {
      contactId,
      lines: [
        { description: "Scoping", quantityMilli: 1000, unitPriceCents: 20_000 },
      ],
    }),
  );
  const res = await call(`/api/quotes/${made.quote.id}`, "PATCH", {
    expectedUpdatedAt: 1762440000000,
    notes: "Mine",
  });
  expect(res.status).toBe(400);
});
