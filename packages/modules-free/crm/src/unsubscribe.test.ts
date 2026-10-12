import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { dropOrganization, makeOrganization } from "@sentrello/db/testing";
import {
  contactForUnsubscribeToken,
  contactUnsubscribeUrl,
  unsubscribeToken,
} from "@sentrello/db/unsubscribe";
import {
  MARKETING_OPT_OUT,
  provideService,
  registerForTest,
  removeService,
} from "@sentrello/module-sdk";
import { and, eq } from "drizzle-orm";
import crm from "./index";

/**
 * The link at the foot of a marketing email: signed, read-only on GET, and
 * recorded once however many times it is pressed.
 */

process.env.SENTRELLO_SECRET_KEY ||= "a-test-instance-key";
process.env.SENTRELLO_BASE_URL ||= "https://example.test";

const suffix = crypto.randomUUID().slice(0, 8);
const orgA = `unsub-a-${suffix}`;
const orgB = `unsub-b-${suffix}`;
const app = registerForTest(crm);
const contacts: Record<string, string> = {};

async function contact(org: string, email: string): Promise<string> {
  const [row] = await db
    .insert(schema.contacts)
    .values({ organizationId: org, name: email, email, hasNewsletter: true })
    .returning({ id: schema.contacts.id });
  if (!row) throw new Error("no contact");
  return row.id;
}

async function ticked(id: string): Promise<boolean | undefined> {
  const [row] = await db
    .select({ on: schema.contacts.hasNewsletter })
    .from(schema.contacts)
    .where(eq(schema.contacts.id, id));
  return row?.on;
}

async function withdrawals(org: string, id: string) {
  return db
    .select()
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.organizationId, org),
        eq(schema.consentRecords.subjectId, id),
      ),
    );
}

beforeAll(async () => {
  await makeOrganization(orgA);
  await makeOrganization(orgB);
  contacts.form = await contact(orgA, `form-${suffix}@example.test`);
  contacts.oneClick = await contact(orgA, `click-${suffix}@example.test`);
  contacts.other = await contact(orgB, `other-${suffix}@example.test`);
});

afterAll(async () => {
  await dropOrganization(orgA, orgB);
});

const req = (path: string, init?: RequestInit) =>
  app.request(`http://localhost${path}`, init);

test("a token round-trips to its contact, and the url carries it", async () => {
  const id = contacts.form as string;
  const token = unsubscribeToken(orgA, id) as string;
  expect((await contactForUnsubscribeToken(token))?.id).toBe(id);
  expect(contactUnsubscribeUrl(orgA, id)).toBe(
    `${process.env.SENTRELLO_BASE_URL?.replace(/\/+$/, "")}/unsubscribe/${token}`,
  );
});

test("a mac made for another organization, or tampered, is refused", async () => {
  const id = contacts.form as string;
  const foreign = unsubscribeToken(orgB, id) as string;
  expect(await contactForUnsubscribeToken(foreign)).toBeNull();

  const good = unsubscribeToken(orgA, id) as string;
  const last = good.at(-1) === "A" ? "B" : "A";
  expect(await contactForUnsubscribeToken(good.slice(0, -1) + last)).toBeNull();
  expect(await contactForUnsubscribeToken(`${id}.short`)).toBeNull();
  expect(await contactForUnsubscribeToken("nonsense")).toBeNull();

  const res = await req(`/unsubscribe/${foreign}`);
  expect(res.status).toBe(404);
  expect(await res.text()).toContain("This link does not work");
});

test("GET draws a button and changes nothing", async () => {
  const id = contacts.form as string;
  const res = await req(`/unsubscribe/${unsubscribeToken(orgA, id)}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  expect(res.headers.get("x-robots-tag")).toBe("noindex");
  const body = await res.text();
  expect(body).toContain('<form method="post"');
  expect(body).toContain("Stop marketing email to");
  expect(await ticked(id)).toBe(true);
  expect(await withdrawals(orgA, id)).toHaveLength(0);
});

for (const [name, key, body] of [
  ["the page's form", "form", "x=1"],
  ["a provider's one-click", "oneClick", "List-Unsubscribe=One-Click"],
] as const) {
  test(`POST from ${name} unsubscribes once, and only once`, async () => {
    const id = contacts[key] as string;
    const path = `/unsubscribe/${unsubscribeToken(orgA, id)}`;
    const post = () =>
      req(path, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });

    expect((await post()).status).toBe(200);
    expect(await ticked(id)).toBe(false);
    const records = await withdrawals(orgA, id);
    expect(records).toHaveLength(1);
    expect(records[0]?.granted).toBe(false);
    expect(records[0]?.purpose).toBe("marketing.email");

    expect((await post()).status).toBe(200);
    expect(await withdrawals(orgA, id)).toHaveLength(1);

    const notes = await db
      .select()
      .from(schema.activities)
      .where(eq(schema.activities.contactId, id));
    expect(notes.map((n) => n.body)).toEqual([
      "Unsubscribed from marketing email",
    ]);

    // And the page now says so, with no button.
    const again = await (await req(path)).text();
    expect(again).toContain("already unsubscribed");
    expect(again).not.toContain("<form");
  });
}

test("a module's own list is told too, even when the tick was already off", async () => {
  const id = await contact(orgA, `list-${suffix}@example.test`);
  const told: unknown[] = [];
  const was = removeService(MARKETING_OPT_OUT);
  provideService(MARKETING_OPT_OUT, async (...args: unknown[]) => {
    told.push(args);
  });
  try {
    const post = () =>
      req(`/unsubscribe/${unsubscribeToken(orgA, id)}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "x=1",
      });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
  } finally {
    removeService(MARKETING_OPT_OUT);
    if (was !== undefined) provideService(MARKETING_OPT_OUT, was);
  }
  const who = { contactId: id, email: `list-${suffix}@example.test` };
  expect(told).toEqual([
    [orgA, who, { page: "/unsubscribe", method: "page" }],
    [orgA, who, { page: "/unsubscribe", method: "page" }],
  ]);
});

test("the other organization's contact was never touched", async () => {
  expect(await ticked(contacts.other as string)).toBe(true);
});

test("no instance secret, no link", () => {
  const saved = {
    a: process.env.SENTRELLO_SECRET_KEY,
    b: process.env.BETTER_AUTH_SECRET,
  };
  process.env.SENTRELLO_SECRET_KEY = "";
  process.env.BETTER_AUTH_SECRET = "";
  try {
    expect(contactUnsubscribeUrl(orgA, contacts.form as string)).toBeNull();
    expect(unsubscribeToken(orgA, contacts.form as string)).toBeNull();
  } finally {
    for (const [name, value] of [
      ["SENTRELLO_SECRET_KEY", saved.a],
      ["BETTER_AUTH_SECRET", saved.b],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
