import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import { dropOrganization } from "@sentrello/db/testing";
import accounting from "@sentrello/module-accounting";
import crm from "@sentrello/module-crm";
import invoicing from "@sentrello/module-invoicing";
import { registerForTest } from "@sentrello/module-sdk";

/**
 * A write that names another business's record by id is refused, and refused
 * in the very words an id nobody has is refused.
 *
 * `module-tenancy.test.ts` puts the other business's ids in every *path*. This
 * is the other half: an id in a *body* — a catalogue item on an invoice line, a
 * record to hang a tag on, a receipt file — which a path sweep never sends.
 * Each case was found by sending business B's id from business A on a
 * licensed instance and reading back what was stored.
 *
 * The two refusals must match, status and body, or the answer says that the
 * id exists somewhere else on the instance.
 */
const suffix = crypto.randomUUID().slice(0, 8);
const crmApp = registerForTest(crm);
const invoicingApp = registerForTest(invoicing);
const accountingApp = registerForTest(accounting);

async function business(label: string) {
  const signUp = await signUpAsOwner({
    email: `foreign-${label}-${suffix}@example.test`,
    password: "correct-horse-battery-staple",
    name: label,
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const headers = new Headers({ cookie, "content-type": "application/json" });
  const org = await auth.api.createOrganization({
    body: { name: `${label} ${suffix}`, slug: `foreign-${label}-${suffix}` },
    headers,
  });
  if (!org) throw new Error("could not create organization");
  await auth.api.setActiveOrganization({
    body: { organizationId: org.id },
    headers,
  });
  return { headers, orgId: org.id };
}

let a: { headers: Headers; orgId: string };
let b: { headers: Headers; orgId: string };

const call = async (
  app: ReturnType<typeof registerForTest>,
  who: { headers: Headers },
  method: string,
  path: string,
  body?: unknown,
) => {
  const res = await app.request(`http://localhost${path}`, {
    method,
    headers: who.headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return {
    status: res.status,
    // Every answer read here is `{ <thing>: { id, … } }`.
    body: (await res.json().catch(() => null)) as Record<
      string,
      { id: string }
    >,
  };
};

/** Send the same request with B's id and with an invented one; both answers. */
const both = async (
  send: (id: string) => Promise<{ status: number; body: unknown }>,
  foreign: string,
) => {
  const invented = crypto.randomUUID();
  const theirs = await send(foreign);
  const nobody = await send(invented);
  const scrub = (v: unknown, id: string) =>
    JSON.stringify(v).replaceAll(id, "<id>");
  return {
    theirs,
    nobody,
    same: scrub(theirs.body, foreign) === scrub(nobody.body, invented),
  };
};

let aContact = "";
let bContact = "";
let bItem = "";
let bDeal = "";

beforeAll(async () => {
  a = await business("alpha");
  b = await business("beta");
  aContact =
    (
      await call(crmApp, a, "POST", "/api/contacts", {
        name: "Alpha's customer",
      })
    ).body.contact?.id ?? "";
  bContact =
    (
      await call(crmApp, b, "POST", "/api/contacts", {
        name: "Beta's customer",
      })
    ).body.contact?.id ?? "";
  bDeal =
    (await call(crmApp, b, "POST", "/api/deals", { name: "Beta's deal" })).body
      .deal?.id ?? "";
  const item = await call(invoicingApp, b, "POST", "/api/invoicing/items", {
    name: "Beta's item",
    unitPriceCents: 1000,
  });
  bItem = item.body?.item?.id ?? item.body?.billableItem?.id ?? "";
  if (!bItem)
    throw new Error(`no item: ${item.status} ${JSON.stringify(item.body)}`);
});

afterAll(async () => {
  await dropOrganization(a?.orgId, b?.orgId);
});

test("an invoice line cannot name another business's catalogue item", async () => {
  const { theirs, nobody, same } = await both(
    (id) =>
      call(invoicingApp, a, "POST", "/api/invoices", {
        contactId: aContact,
        lines: [
          {
            description: "A line",
            quantity: 1,
            unitPriceCents: 1000,
            billableItemId: id,
          },
        ],
      }),
    bItem,
  );
  expect(theirs.status).toBe(400);
  expect(nobody.status).toBe(400);
  expect(same).toBe(true);
  const stored = await db
    .select()
    .from(schema.invoiceLines)
    .where(eq(schema.invoiceLines.billableItemId, bItem));
  expect(stored).toHaveLength(0);
});

test("a tag cannot be hung on another business's record", async () => {
  const tag =
    (
      await call(crmApp, a, "POST", "/api/tags", {
        name: `Alpha tag ${suffix}`,
      })
    ).body.tag?.id ?? "";
  for (const [plural, foreign] of [
    ["contacts", bContact],
    ["deals", bDeal],
  ] as const) {
    const { theirs, nobody, same } = await both(
      (id) =>
        call(crmApp, a, "POST", `/api/${plural}/${id}/tags`, { tagId: tag }),
      foreign,
    );
    expect(theirs.status).toBe(404);
    expect(nobody.status).toBe(404);
    expect(same).toBe(true);
  }
  const joined = await db
    .select()
    .from(schema.taggables)
    .where(eq(schema.taggables.tagId, tag));
  expect(joined).toHaveLength(0);
});

test("a deal's people are a list, so nothing slips past the filter", async () => {
  const res = await call(crmApp, a, "POST", "/api/deals", {
    name: "Smuggled",
    contactIds: { 0: bContact },
  });
  expect(res.status).toBe(400);
  const [deal] = await db
    .select()
    .from(schema.deals)
    .where(eq(schema.deals.name, "Smuggled"));
  expect(deal).toBeUndefined();
});

test("a transaction cannot be handed a receipt by naming its file", async () => {
  const key = `${b.orgId}/${crypto.randomUUID()}.pdf`;
  const made = await call(accountingApp, a, "POST", "/api/transactions", {
    kind: "expense",
    amountCents: 1840,
    description: "Postage",
    receiptFileKey: key,
  });
  expect(made.status).toBe(201);
  const id = made.body.transaction?.id ?? "";
  await call(accountingApp, a, "PATCH", `/api/transactions/${id}`, {
    receiptFileKey: key,
  });
  const [row] = await db
    .select({ key: schema.transactions.receiptFileKey })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id));
  expect(row?.key ?? null).toBeNull();

  // And a key outside this business's folder is never served, however it
  // reached the column.
  await db
    .update(schema.transactions)
    .set({ receiptFileKey: key })
    .where(eq(schema.transactions.id, id));
  const served = await call(
    accountingApp,
    a,
    "GET",
    `/api/transactions/${id}/receipt`,
  );
  expect(served.status).toBe(404);
});
