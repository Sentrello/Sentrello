import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, eq, schema } from "@sentrello/db";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import { Hono } from "hono";
import crm from "./index";

const suffix = crypto.randomUUID().slice(0, 8);
const email = `crm-dash-${suffix}@example.test`;
const app = new Hono<SentrelloEnv>();

let orgId: string;
let headers: Headers;

const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);

beforeAll(async () => {
  crm.register({
    app,
    entitled: () => true,
    registerNav: () => {},
    registerPermission: () => {},
    registerSummary: () => {},
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
    body: { name: `CRM dash ${suffix}`, slug: `crm-dash-${suffix}` },
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
  for (const table of [
    schema.activities,
    schema.tasks,
    schema.deals,
    schema.contacts,
  ]) {
    await db.delete(table).where(eq(table.organizationId, orgId));
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

const dashboard = async () => {
  const res = await app.request("http://localhost/api/crm/dashboard", {
    headers,
  });
  expect(res.status).toBe(200);
  return (await res.json()) as {
    hotContacts: { id: string; name: string }[];
    dealOutcomes: {
      month: string;
      wonCount: number;
      wonCents: number;
      lostCount: number;
      lostCents: number;
    }[];
    upcoming: {
      totalCents: number;
      overdue: { count: number; totalCents: number };
    };
    latestActivity: { id: string; type: string }[];
    tasks: { id: string; title: string; overdue: boolean }[];
    goingCold: number;
  };
};

test("it ranks contacts by what is actually happening, not the alphabet", async () => {
  const [quiet] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Aaron Quiet", status: "hot" })
    .returning();
  const [busy] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Zoe Busy", status: "hot" })
    .returning();

  await db.insert(schema.activities).values({
    organizationId: orgId,
    contactId: busy?.id,
    type: "call",
    body: "talked through the quote",
    occurredAt: days(-1),
  });

  const body = await dashboard();
  expect(body.hotContacts[0]?.name).toBe("Zoe Busy");
  // Somebody nobody has ever spoken to is not hot. A list that opens with
  // them is a list people learn to ignore.
  expect(body.hotContacts.map((c) => c.id)).not.toContain(quiet?.id);

  await db
    .delete(schema.activities)
    .where(eq(schema.activities.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
});

/**
 * A deal counts in the month it was decided, not the month it was last touched.
 *
 * The chart used to read `updatedAt`, which moves whenever anybody edits
 * anything — so adding a note to a deal won in June dragged it into the current
 * month and six months of history quietly rewrote itself.
 */
test("editing an old won deal does not move it between months", async () => {
  const june = new Date();
  june.setMonth(june.getMonth() - 2);

  const created = await app.request("http://localhost/api/deals", {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: "Won a while ago",
      stage: "won",
      amountCents: 250_000,
      decidedAt: june.toISOString(),
    }),
  });
  expect(created.status).toBe(201);
  const { deal } = (await created.json()) as { deal: { id: string } };

  const monthOf = (d: Date) =>
    `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

  const before = await dashboard();
  expect(
    before.dealOutcomes.find((m) => m.month === monthOf(june))?.wonCents,
  ).toBe(250_000);

  // Somebody adds a note today. The books of the pipeline must not move.
  await app.request(`http://localhost/api/deals/${deal.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ description: "Client rang about the next one." }),
  });

  const after = await dashboard();
  expect(
    after.dealOutcomes.find((m) => m.month === monthOf(june))?.wonCents,
  ).toBe(250_000);
  expect(
    after.dealOutcomes.find((m) => m.month === monthOf(new Date()))?.wonCents,
  ).toBe(0);

  await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
});

/**
 * The panel is called hot contacts, so it lists the hot ones.
 *
 * It used to rank every contact by last activity and call the top eight hot,
 * which meant the busiest relationship in the business appeared there whether
 * anybody had marked it hot or not — and the status column, which somebody had
 * gone to the trouble of setting, did nothing at all.
 */
test("hot contacts are the ones marked hot, not merely the busiest", async () => {
  const [warm] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Wendy Warm", status: "warm" })
    .returning();
  const [hot] = await db
    .insert(schema.contacts)
    .values({ organizationId: orgId, name: "Harry Hot", status: "hot" })
    .returning();

  // The warm one is the more recently touched of the two, so ranking alone
  // would put it first.
  await db.insert(schema.activities).values([
    {
      organizationId: orgId,
      contactId: hot?.id,
      type: "call",
      body: "quote discussed",
      occurredAt: days(-3),
    },
    {
      organizationId: orgId,
      contactId: warm?.id,
      type: "email",
      body: "sent the brochure",
      occurredAt: days(-1),
    },
  ]);

  if (!hot || !warm) throw new Error("the test contacts were not created");

  const body = await dashboard();
  const ids = body.hotContacts.map((c) => c.id);
  expect(ids).toContain(hot.id);
  expect(ids).not.toContain(warm.id);

  await db
    .delete(schema.activities)
    .where(eq(schema.activities.organizationId, orgId));
  await db
    .delete(schema.contacts)
    .where(eq(schema.contacts.organizationId, orgId));
});

/**
 * Upcoming revenue is what says it will land inside the horizon — not a
 * probability-weighted forecast, which is a number nobody can check.
 */
test("upcoming revenue counts what closes soon, and nothing else", async () => {
  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Closing this month",
      amountCents: 250_000,
      expectedCloseOn: days(10).toISOString().slice(0, 10),
    },
    {
      organizationId: orgId,
      name: "Next quarter",
      amountCents: 900_000,
      expectedCloseOn: days(120).toISOString().slice(0, 10),
    },
    {
      organizationId: orgId,
      name: "No date yet",
      amountCents: 400_000,
    },
  ]);

  const body = await dashboard();
  expect(body.upcoming.totalCents).toBe(250_000);
});

/**
 * A deal whose close date has passed is not upcoming revenue — it is a
 * conversation somebody has been avoiding. Adding it to the forecast hides the
 * one thing on this screen worth acting on.
 */
test("an overdue deal is counted separately, never in the forecast", async () => {
  await db.insert(schema.deals).values({
    organizationId: orgId,
    name: "Should have closed",
    amountCents: 700_000,
    expectedCloseOn: days(-14).toISOString().slice(0, 10),
  });

  const body = await dashboard();
  expect(body.upcoming.totalCents).toBe(250_000);
  expect(body.upcoming.overdue.count).toBe(1);
  expect(body.upcoming.overdue.totalCents).toBe(700_000);
});

test("tasks come back soonest first, and say which are late", async () => {
  await db.insert(schema.tasks).values([
    { organizationId: orgId, title: "Ring back Tuesday", dueAt: days(2) },
    { organizationId: orgId, title: "Chase the survey", dueAt: days(-3) },
    {
      organizationId: orgId,
      title: "Already done",
      dueAt: days(1),
      done: true,
    },
  ]);

  const body = await dashboard();
  expect(body.tasks[0]?.title).toBe("Chase the survey");
  expect(body.tasks[0]?.overdue).toBe(true);
  // A finished task is not something to do.
  expect(body.tasks.map((t) => t.title)).not.toContain("Already done");
});

test("another organization's CRM never appears on this one's dashboard", async () => {
  const theirs = `other-${crypto.randomUUID().slice(0, 8)}`;
  const [contact] = await db
    .insert(schema.contacts)
    .values({ organizationId: theirs, name: "Their Secret Contact" })
    .returning();
  await db.insert(schema.activities).values({
    organizationId: theirs,
    contactId: contact?.id,
    type: "call",
    body: "Their Secret Call",
  });
  await db.insert(schema.deals).values({
    organizationId: theirs,
    name: "Their Secret Deal",
    amountCents: 5_000_000,
    expectedCloseOn: days(5).toISOString().slice(0, 10),
  });

  const res = await app.request("http://localhost/api/crm/dashboard", {
    headers,
  });
  const text = await res.text();
  expect(text).not.toContain("Their Secret");
  expect(JSON.parse(text).upcoming.totalCents).toBe(250_000);

  for (const table of [schema.activities, schema.deals, schema.contacts]) {
    await db.delete(table).where(eq(table.organizationId, theirs));
  }
});

/**
 * A stage cannot be removed while deals are standing in it. The alternative is
 * a deal whose stage matches no column: invisible on the board, still in the
 * database, found when somebody asks where the job went.
 */
test("removing a stage that still holds deals is refused, and says how many", async () => {
  await db.insert(schema.deals).values([
    { organizationId: orgId, name: "Sitting in proposal", stage: "proposal" },
    { organizationId: orgId, name: "Also proposal", stage: "proposal" },
  ]);

  const res = await app.request("http://localhost/api/crm/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      dealStages: [
        { id: "opportunity", label: "Opportunity" },
        { id: "won", label: "Won" },
      ],
      taskTypes: ["call"],
    }),
  });

  expect(res.status).toBe(409);
  const body = (await res.json()) as {
    error: string;
    stranded: Record<string, number>;
  };
  expect(body.error).toContain("2 deals are still in");
  expect(body.stranded.proposal).toBe(2);

  // And nothing was saved: the board still draws the stage those deals are in.
  const after = (await (
    await app.request("http://localhost/api/crm/settings", { headers })
  ).json()) as { dealStages: { id: string }[] };
  expect(after.dealStages.map((s) => s.id)).toContain("proposal");
});

test("a renamed stage keeps its deals", async () => {
  const res = await app.request("http://localhost/api/crm/settings", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      dealStages: [
        { id: "opportunity", label: "Enquiry" },
        { id: "proposal", label: "Quote sent" },
        { id: "won", label: "Won" },
        { id: "lost", label: "Lost" },
        { id: "negotiation", label: "Negotiation" },
      ],
      taskTypes: ["call", "site visit"],
    }),
  });
  expect(res.status).toBe(200);

  const saved = (await res.json()) as {
    dealStages: { id: string; label: string }[];
    usingDefaults: boolean;
  };
  expect(saved.usingDefaults).toBe(false);
  expect(saved.dealStages[1]).toEqual({ id: "proposal", label: "Quote sent" });

  // The deals that were in "proposal" are still there, under its new name.
  const deals = (await (
    await app.request("http://localhost/api/deals", { headers })
  ).json()) as { deals: { stage: string }[] };
  expect(deals.deals.filter((d) => d.stage === "proposal").length).toBe(2);
});

/**
 * The chart that replaced the forecast.
 *
 * Won and lost are facts; "closing in 30 days" was a probability nobody could
 * check. The two things this has to get right are which stages count as which
 * — the business decides that, not the code — and that archived deals are
 * still counted, because a business files a won job away the week after it
 * lands.
 */
test("won and lost are counted by the stages this business calls won and lost", async () => {
  // A pipeline whose outcomes are not named "won" and "lost".
  await db
    .insert(schema.crmSettings)
    .values({
      organizationId: orgId,
      dealStages: [
        { id: "quoted", label: "Quoted" },
        { id: "installed", label: "Installed" },
        { id: "walked-away", label: "Walked away" },
      ],
      wonStages: ["installed"],
      lostStages: ["walked-away"],
    })
    .onConflictDoUpdate({
      target: schema.crmSettings.organizationId,
      set: { wonStages: ["installed"], lostStages: ["walked-away"] },
    });

  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Installed job",
      stage: "installed",
      amountCents: 500_000,
      // Written straight to the table rather than through the API, so the
      // decided date has to be set here — it is the API that stamps it.
      decidedAt: new Date(),
    },
    {
      organizationId: orgId,
      name: "Lost job",
      stage: "walked-away",
      amountCents: 300_000,
      decidedAt: new Date(),
    },
    {
      // Filed away, and still part of the history.
      organizationId: orgId,
      name: "Installed and archived",
      stage: "installed",
      amountCents: 200_000,
      archivedAt: new Date(),
      decidedAt: new Date(),
    },
  ]);

  const body = await dashboard();
  expect(body.dealOutcomes).toHaveLength(6);

  // Every month is present, including the quiet ones: a series that skips an
  // empty month draws a shape the business never had.
  const months = body.dealOutcomes.map((m) => m.month);
  expect([...months].sort()).toEqual(months);

  const thisMonth = body.dealOutcomes[body.dealOutcomes.length - 1];
  expect(thisMonth?.wonCents).toBe(700_000);
  expect(thisMonth?.wonCount).toBe(2);
  expect(thisMonth?.lostCents).toBe(300_000);
  expect(thisMonth?.lostCount).toBe(1);
});
