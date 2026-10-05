import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import {
  addOnboarding,
  addSummary,
  addWidget,
  allWidgets,
  clearOnboarding,
  clearSummaries,
  clearWidgets,
  registerForTest,
} from "@sentrello/module-sdk";
import { eq, inArray } from "drizzle-orm";
import dashboard from "./index";

const app = registerForTest(dashboard);
// The same module, on an instance with no Pro licence. One dashboard with two
// faces, so both faces have to be exercised.
const freeApp = registerForTest(dashboard, undefined, (need) => !need.tier);
let headers: Headers;
let orgId: string;

const suffix = crypto.randomUUID().slice(0, 8);

beforeAll(async () => {
  // The guide registry is shared across every test file in the process, and
  // the ad is gated on it being finished. Guides another module's tests left
  // behind would hide the ad here for reasons this file never registered.
  clearOnboarding();

  const signUp = await signUpAsOwner({
    email: `dash-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Owner",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  headers = new Headers({ cookie, "content-type": "application/json" });

  const org = await auth.api.createOrganization({
    body: { name: `Dash ${suffix}`, slug: `dash-${suffix}` },
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
  // And the registries this file filled, for the reason it clears them on the
  // way in: one array for the whole process, and the next file's list answers
  // with whatever this one left.
  clearOnboarding();
  clearSummaries();
  clearWidgets();
  // The owner has to go too. Leaving one behind makes the instance look
  // claimed, and every bootstrap test then fails on a database this one
  // dirtied — which reads as those tests breaking, not this one.
  await db
    .delete(schema.payments)
    .where(eq(schema.payments.organizationId, orgId));
  await db
    .delete(schema.invoices)
    .where(eq(schema.invoices.organizationId, orgId));
  await db.delete(schema.tasks).where(eq(schema.tasks.organizationId, orgId));
  await db
    .delete(schema.userPreferences)
    .where(eq(schema.userPreferences.organizationId, orgId));
  await db
    .delete(schema.organizationPreferences)
    .where(eq(schema.organizationPreferences.organizationId, orgId));
  await db
    .delete(schema.onboardingDismissals)
    .where(eq(schema.onboardingDismissals.organizationId, orgId));
  await db.delete(schema.member).where(eq(schema.member.organizationId, orgId));
  await db
    .delete(schema.organizations)
    .where(eq(schema.organizations.id, orgId));

  const [u] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, `dash-${suffix}@x.test`));
  if (u) {
    await db.delete(schema.session).where(eq(schema.session.userId, u.id));
    await db.delete(schema.account).where(eq(schema.account.userId, u.id));
    await db.delete(schema.user).where(eq(schema.user.id, u.id));
  }
});

const get = () => app.request("http://localhost/api/dashboard", { headers });

test("an empty instance reports zeroes rather than failing", async () => {
  // A brand new Free instance is the first thing anyone sees. A dashboard that
  // needs data to render is a broken first impression.
  const res = await get();
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    money: { owedCents: number };
    attention: unknown[];
  };
  expect(body.money.owedCents).toBe(0);
  expect(body.attention).toEqual([]);
});

/**
 * Owed and overdue are two numbers on purpose. "You are owed 8,000" and "6,000
 * of it is late" call for completely different afternoons.
 */
test("overdue is counted apart from merely unpaid", async () => {
  const yesterday = new Date(Date.now() - 86_400_000);
  const nextMonth = new Date(Date.now() + 30 * 86_400_000);

  await db.insert(schema.invoices).values([
    {
      organizationId: orgId,
      number: "INV-100",
      status: "sent",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 60_000,
      taxCents: 0,
      totalCents: 60_000,
    },
    {
      organizationId: orgId,
      number: "INV-101",
      status: "sent",
      currency: "USD",
      issueDate: new Date(),
      dueDate: nextMonth,
      subtotalCents: 20_000,
      taxCents: 0,
      totalCents: 20_000,
    },
    // Paid invoices are neither owed nor overdue; counting them would make the
    // headline number grow for ever.
    {
      organizationId: orgId,
      number: "INV-102",
      status: "paid",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 99_000,
      taxCents: 0,
      totalCents: 99_000,
    },
  ]);

  const body = (await (await get()).json()) as {
    money: {
      owedCents: number;
      overdueCents: number;
      unpaidCount: number;
      overdueCount: number;
    };
    attention: { kind: string; summary: string }[];
  };

  expect(body.money.owedCents).toBe(80_000);
  expect(body.money.overdueCents).toBe(60_000);
  expect(body.money.unpaidCount).toBe(2);
  expect(body.money.overdueCount).toBe(1);
  expect(body.attention.some((a) => a.summary.includes("INV-100"))).toBe(true);
  expect(body.attention.some((a) => a.summary.includes("INV-101"))).toBe(false);
});

test("a follow-up that was due yesterday needs attention", async () => {
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    title: "Chase the Brixton quote",
    dueAt: new Date(Date.now() - 86_400_000),
    done: false,
  });
  const body = (await (await get()).json()) as {
    attention: { kind: string; summary: string }[];
  };
  expect(
    body.attention.some(
      (a) => a.kind === "task" && a.summary === "Chase the Brixton quote",
    ),
  ).toBe(true);
});

/**
 * The upgrade prompt is the Free dashboard's job and only its job.
 *
 * Showing it to somebody who has already paid is worse than a wasted panel: it
 * makes the purchase feel unfinished, on the screen they open every morning.
 */
test("Pro is not sold to, Free is", async () => {
  const pro = (await (await get()).json()) as {
    tier: string;
    ad: unknown;
  };
  expect(pro.tier).toBe("pro");
  expect(pro.ad).toBeNull();

  const free = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as {
    tier: string;
    ad: { url: string; headline: string } | null;
  };
  expect(free.tier).toBe("free");
  expect(free.ad?.headline).toBeTruthy();
  expect(free.ad?.url.startsWith("https://")).toBe(true);
});

/** Both tiers get it: nobody else is watching the machine they self-host on. */
test("the server reports on itself", async () => {
  const body = (await (await get()).json()) as {
    health: {
      version: string;
      uptimeSeconds: number;
      database: { reachable: boolean };
    };
  };
  expect(body.health.database.reachable).toBe(true);
  expect(body.health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  expect(typeof body.health.version).toBe("string");
});

/**
 * The Pro half is not merely hidden on Free — it is not there.
 *
 * Hiding a panel in the browser while the endpoint still answers is how a paid
 * feature becomes a free one for anybody who opens the network tab.
 *
 * `insights` is that half: twelve months of ledger, which Free does not buy.
 * **Arranging is not**, since 2026-09-13 — the two tiers get the same screen,
 * and deciding which of your own panels you look at first was never the thing
 * being sold. What Pro sells is the panels there are to arrange.
 */
/**
 * The Free dashboard is the Pro dashboard.
 *
 * James, 2026-09-20. The twelve-month ledger charts were the paid half of
 * this module; every figure in them is computed by Core from tables every
 * instance has, so there was never anything to install, only something to
 * allow. The only thing Free carries that Pro does not is the promo block.
 *
 * What a licence still decides is which *modules* load, and the three report
 * panels whose routes live in `pro-accounting` — that is where the code is,
 * not a price.
 */
test("the ledger charts are answered on a Free instance too", async () => {
  const insights = await freeApp.request(
    "http://localhost/api/dashboard/insights",
    { headers },
  );
  expect(insights.status).toBe(200);

  expect((await get()).status).toBe(200);
  expect(
    (await app.request("http://localhost/api/dashboard/insights", { headers }))
      .status,
  ).toBe(200);
});

test("a free instance can arrange its own dashboard", async () => {
  const res = await freeApp.request("http://localhost/api/dashboard/layout", {
    headers,
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    tabs: { name: string; widgets: string[] }[];
  };
  expect(body.tabs.length).toBeGreaterThan(0);

  const saved = await freeApp.request("http://localhost/api/dashboard/layout", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      tabs: [{ name: "Mine", widgets: ["dashboard:money"] }],
    }),
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).tabs).toEqual([
    { name: "Mine", widgets: ["dashboard:money"] },
  ]);
});

test("insights cover every month in the window, including the quiet ones", async () => {
  const body = (await (
    await app.request("http://localhost/api/dashboard/insights", { headers })
  ).json()) as {
    months: { month: string; netCents: number }[];
    aging: { bucket: string; cents: number }[];
  };
  expect(body.months).toHaveLength(12);
  // Sorted and gapless: a series that skips an empty month draws a line
  // sloping through a gap the business never had.
  expect(
    [...body.months].sort((a, b) => a.month.localeCompare(b.month)),
  ).toEqual(body.months);
  // INV-100 is 60,000 and one day past its date; INV-101 is not yet due.
  const late = body.aging.find((a) => a.bucket === "1–30 days");
  expect(late?.cents).toBe(60_000);
  expect(body.aging.find((a) => a.bucket === "Not yet due")?.cents).toBe(
    20_000,
  );
});

/**
 * Twelve, not six.
 *
 * Six was the limit while every tab was one somebody typed by hand. Tabs are
 * generated now — one per module this instance loaded — so an instance with
 * the Shop, Booking, the Newsletter, Storage and SEO needs room for them
 * beside the four core screens and System.
 */
test("a layout survives a save, and cannot grow past the limit", async () => {
  const tabs = Array.from({ length: 20 }, (_, i) => ({
    name: `Tab ${i}`,
    widgets: ["money", "not-a-widget"],
  }));
  const saved = (await (
    await app.request("http://localhost/api/dashboard/layout", {
      method: "PUT",
      headers,
      body: JSON.stringify({ tabs }),
    })
  ).json()) as { tabs: { name: string; widgets: string[] }[] };

  expect(saved.tabs).toHaveLength(12);
  // Unknown panels are dropped rather than refused: a layout saved by a newer
  // version should lose what it cannot draw and keep the rest.
  expect(saved.tabs[0]?.widgets).toEqual(["dashboard:money"]);

  const read = (await (
    await app.request("http://localhost/api/dashboard/layout", { headers })
  ).json()) as { tabs: { name: string }[]; widgets: { id: string }[] };
  expect(read.tabs).toHaveLength(12);
  expect(read.tabs[0]?.name).toBe("Tab 0");
  // Offered to this fully entitled reader; the Free reader's test below
  // asserts the same id is never named to somebody it is not for.
  expect(read.widgets.map((w) => w.id)).toContain("dashboard:revenue-trend");

  // Saving twice is the normal case — every rearrange is a save — and must not
  // leave two answers to a question that has one.
  await app.request("http://localhost/api/dashboard/layout", {
    method: "PUT",
    headers,
    body: JSON.stringify({ tabs: [{ name: "Only", widgets: ["health"] }] }),
  });
  const again = (await (
    await app.request("http://localhost/api/dashboard/layout", { headers })
  ).json()) as { tabs: { name: string }[] };
  expect(again.tabs).toHaveLength(1);
  expect(again.tabs[0]?.name).toBe("Only");
});

test("an empty layout resets rather than leaving a blank screen", async () => {
  const body = (await (
    await app.request("http://localhost/api/dashboard/layout", {
      method: "PUT",
      headers,
      body: JSON.stringify({ tabs: [] }),
    })
  ).json()) as { tabs: unknown[] };
  expect(body.tabs.length).toBeGreaterThan(0);
});

test("a completed follow-up is not still asking to be done", async () => {
  await db.insert(schema.tasks).values({
    organizationId: orgId,
    title: "Already handled",
    dueAt: new Date(Date.now() - 86_400_000),
    done: true,
  });
  const body = (await (await get()).json()) as {
    attention: { summary: string }[];
  };
  expect(body.attention.some((a) => a.summary === "Already handled")).toBe(
    false,
  );
});

/**
 * "Owed to you" is what is still owed, not what was billed.
 *
 * Found by taking a part payment on a walk through a new instance and
 * watching the headline figure not move. A business that took a deposit this
 * morning is owed the rest — overstating it inflates the one number on this
 * screen somebody is most likely to act on, and chasing a customer for money
 * they have already sent is worse than not chasing at all.
 */
test("a part payment comes off what is owed", async () => {
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: "INV-PART",
      status: "partial",
      currency: "USD",
      issueDate: new Date(),
      dueDate: new Date(Date.now() - 86_400_000),
      subtotalCents: 100_000,
      taxCents: 0,
      totalCents: 100_000,
    })
    .returning();
  if (!invoice) throw new Error("no invoice");

  await db.insert(schema.payments).values({
    organizationId: orgId,
    invoiceId: invoice.id,
    amountCents: 40_000,
    method: "bank transfer",
  });

  const body = (await (await get()).json()) as {
    money: { owedCents: number; overdueCents: number };
    attention: { summary: string; amountCents?: number }[];
  };

  // 60,000 of this one, plus the 80,000 the earlier tests left unpaid.
  expect(body.money.owedCents).toBe(140_000);
  // It is overdue, and it is overdue for the balance rather than the total.
  expect(body.money.overdueCents).toBe(120_000);
  expect(
    body.attention.find((a) => a.summary.includes("INV-PART"))?.amountCents,
  ).toBe(60_000);
});

test("free says something about pro, and pro is never sold to", async () => {
  // The copy ships in the release now: there is no document to fetch and no
  // cache to go stale, and the only thing worth pinning is that a Free
  // instance carries the block and a paid one carries nothing.
  const free = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as {
    ad: { headline: string; body: string; cta: string; url: string } | null;
  };
  expect(free.ad?.headline).toContain("Pro");
  expect(free.ad?.cta).toBeTruthy();
  expect(free.ad?.url.startsWith("https://")).toBe(true);

  const pro = (await (await get()).json()) as { ad: unknown };
  expect(pro.ad).toBeNull();
});

/**
 * Where "see what Pro adds" goes, for somebody who sells this on.
 *
 * A partner running instances for their own customers points it at their own
 * page; it is the one thing about the block that is configurable, and an
 * unset variable must not leave a link to nowhere.
 */
test("the upgrade link can be pointed elsewhere", async () => {
  const { upgradeBlock } = await import("./upgrade");
  const previous = process.env.SENTRELLO_UPGRADE_URL;
  process.env.SENTRELLO_UPGRADE_URL = "https://partner.example/pro";
  expect(upgradeBlock().url).toBe("https://partner.example/pro");

  // Declared and left blank, which is what a compose file usually produces.
  process.env.SENTRELLO_UPGRADE_URL = "";
  expect(upgradeBlock().url).toBe("https://sentrello.com/pricing/");
  process.env.SENTRELLO_UPGRADE_URL = previous ?? "";
});

/**
 * The dashboard draws modules it has never heard of.
 *
 * Shop and Booking live in another repository and Core must not import them,
 * so the only way their figures reach the first screen is a registry the
 * dashboard reads without knowing what is in it. These use a made-up module,
 * because a test that registers Invoicing would prove Invoicing works, not
 * that the mechanism does.
 */
test("a module's own figures reach the dashboard", async () => {
  addSummary({
    moduleId: "hire",
    id: "hire",
    label: "Widget hire",
    icon: "boxes",
    opens: "hire",
    load: async () => [
      { label: "Out on hire", value: 7, kind: "count" },
      { label: "Owed", value: 12_500, kind: "money", tone: "bad" },
    ],
  });

  const res = await app.request("http://localhost/api/dashboard/widgets", {
    headers,
  });
  expect(res.status).toBe(200);
  const { widgets } = (await res.json()) as {
    widgets: {
      id: string;
      label: string;
      opens: string | null;
      figures: { label: string; value: number }[];
    }[];
  };

  // A summary is a widget with no further declaration, under `summary:<id>`.
  const hire = widgets.find((s) => s.id === "hire:summary:hire");
  expect(hire?.label).toBe("Widget hire");
  expect(hire?.opens).toBe("hire");
  // Money stays in cents all the way to the browser, which formats it in the
  // reader's own currency.
  expect(hire?.figures).toContainEqual({
    label: "Owed",
    value: 12_500,
    kind: "money",
    tone: "bad",
  });

  clearSummaries();
});

test("a module that cannot count itself does not take the screen with it", async () => {
  addSummary({
    moduleId: "broken",
    id: "broken",
    label: "Broken",
    load: async () => {
      throw new Error("its table is missing");
    },
  });
  addSummary({
    moduleId: "fine",
    id: "fine",
    label: "Fine",
    load: async () => [{ label: "Things", value: 3, kind: "count" }],
  });

  const res = await app.request("http://localhost/api/dashboard/widgets", {
    headers,
  });
  expect(res.status).toBe(200);
  const { widgets } = (await res.json()) as { widgets: { id: string }[] };
  expect(widgets.map((s) => s.id)).toEqual(["fine:summary:fine"]);

  clearSummaries();
});

test("a summary somebody may not read is left out, not refused", async () => {
  // The owner holds everything, so this asserts the opposite end: a permission
  // nobody has anywhere hides the card without failing the request.
  addSummary({
    moduleId: "vault",
    id: "vault",
    label: "Vault",
    requires: { nonexistent: ["read"] },
    load: async () => [{ label: "Secrets", value: 1, kind: "count" }],
  });

  const res = await app.request("http://localhost/api/dashboard/widgets", {
    headers,
  });
  expect(res.status).toBe(200);
  const { widgets } = (await res.json()) as { widgets: { id: string }[] };
  expect(widgets.map((s) => s.id)).not.toContain("summary:vault");

  clearSummaries();
});

/**
 * And a business still setting up is not sold to at all.
 *
 * The promo takes the onboarding checklist's place once there is nothing
 * left on it — not before. The rule that matters on the route rather than in
 * a helper: a brand-new instance mid-setup is exactly the case somebody
 * would forget, because most fixtures arrive with their steps already done.
 */
test("a business still setting up is not sold to", async () => {
  addOnboarding({
    moduleId: "dashboard",
    id: "test-setup",
    label: "Getting started",
    steps: [
      // A step with no `done` is never shown as done, so this guide keeps
      // one thing left to do for as long as it is registered.
      { id: "unfinished", label: "A thing still to do" },
    ],
  });

  try {
    const fresh = (await (
      await freeApp.request("http://localhost/api/dashboard", { headers })
    ).json()) as { tier: string; ad: unknown };
    expect(fresh.tier).toBe("free");
    expect(fresh.ad).toBeNull();
  } finally {
    clearOnboarding();
  }

  // Nothing left to set up, and the offer is there — and stays there,
  // because it is not a campaign with an end.
  const offered = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { ad: { headline: string } | null };
  expect(offered.ad?.headline).toBeTruthy();
});

/**
 * A business that renamed its stages is still counted correctly.
 *
 * The dashboard decided what was open with `stage !== "won" && stage !==
 * "lost"`, written here and nowhere else — while the CRM panel on the same
 * screen read the business's own settings. A roofer whose board runs quote →
 * measured → scheduled → **invoiced** had every finished job counted as
 * still in the pipeline by one panel and correctly by the one beside it.
 */
test("a business that calls its stages something else is still counted", async () => {
  await db
    .insert(schema.crmSettings)
    .values({
      organizationId: orgId,
      wonStages: ["invoiced"],
      lostStages: ["no-budget"],
    })
    .onConflictDoUpdate({
      target: schema.crmSettings.organizationId,
      set: { wonStages: ["invoiced"], lostStages: ["no-budget"] },
    });

  const made = await db
    .insert(schema.deals)
    .values([
      {
        organizationId: orgId,
        name: `Finished ${suffix}`,
        stage: "invoiced",
        amountCents: 70_000,
      },
      {
        organizationId: orgId,
        name: `Dead ${suffix}`,
        stage: "no-budget",
        amountCents: 50_000,
      },
      {
        organizationId: orgId,
        name: `Live ${suffix}`,
        stage: "measured",
        amountCents: 25_000,
      },
    ])
    .returning();

  try {
    const body = (await (await get()).json()) as {
      pipeline: {
        openCount: number;
        openCents: number;
        wonCount: number;
        wonCents: number;
      };
    };

    // The finished job and the dead one are not in the pipeline; the live one
    // is. Read as "at least" and "not at all", because the fixture above has
    // deals of its own on the default stages.
    expect(body.pipeline.openCents).toBeGreaterThanOrEqual(25_000);
    expect(
      body.pipeline.openCents,
      "a finished job was counted as still in the pipeline",
    ).toBeLessThan(70_000 + 50_000);
    expect(body.pipeline.wonCents).toBeGreaterThanOrEqual(70_000);
  } finally {
    for (const deal of made) {
      await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
    }
    await db
      .delete(schema.crmSettings)
      .where(eq(schema.crmSettings.organizationId, orgId));
  }
});

/**
 * The pipeline panel is about the pipeline, in money, on both sides.
 *
 * It used to read Open, Won and "People in the book" — and the figure row at
 * the top of the same tab already carries the contact count, so the screen
 * stated it twice, the second time under a heading it has nothing to do with.
 * Won was a bare count as well: eleven deals won and no word on what they
 * were worth, which is the half of that sentence a business actually asks
 * for.
 */
test("the pipeline carries what is open and what was won, both in money", async () => {
  const made = await db
    .insert(schema.deals)
    .values([
      {
        organizationId: orgId,
        name: `Open one ${suffix}`,
        stage: "opportunity",
        amountCents: 40_000,
      },
      {
        organizationId: orgId,
        name: `Open two ${suffix}`,
        stage: "opportunity",
        amountCents: 15_000,
      },
      {
        organizationId: orgId,
        name: `Won one ${suffix}`,
        stage: "won",
        amountCents: 90_000,
      },
    ])
    .returning();

  try {
    const body = (await (await get()).json()) as {
      pipeline: {
        openCount: number;
        openCents: number;
        wonCount: number;
        wonCents: number;
      };
    };

    // The fixture above this file has deals of its own, so these are read as
    // "at least mine" rather than as exact totals — a figure that only holds
    // while nothing else exists is a figure that fails the day it does.
    expect(body.pipeline.openCents).toBeGreaterThanOrEqual(55_000);
    expect(body.pipeline.openCount).toBeGreaterThanOrEqual(2);
    expect(body.pipeline.wonCents).toBeGreaterThanOrEqual(90_000);
    expect(body.pipeline.wonCount).toBeGreaterThanOrEqual(1);
    // Won is money, not a count wearing a money label.
    expect(body.pipeline.wonCents).not.toBe(body.pipeline.wonCount);
  } finally {
    for (const deal of made) {
      await db.delete(schema.deals).where(eq(schema.deals.id, deal.id));
    }
  }
});

/**
 * A business that has started using it is not told where to start.
 *
 * This organization has invoices, contacts and deals from the fixture above,
 * which is the whole point: the card is for a dashboard with nothing on it,
 * and it has to leave on its own the moment there is something real to look
 * at — no dismissal, nothing remembered.
 *
 * The other direction is checked where it is actually true: the browser suite
 * walks a freshly claimed instance in CI, and asserts the card is there. This
 * fixture cannot say anything honest about an empty business, because it is
 * not one.
 */
test("a business already using it is not told where to start", async () => {
  const body = (await (await get()).json()) as {
    startHere: { url: string } | null;
  };
  expect(body.startHere).toBeNull();
});

// ---------------------------------------------------------------------------
// Putting the checklist away, and getting it back
// ---------------------------------------------------------------------------

interface OnboardingList {
  guides: {
    id: string;
    remaining: number;
    steps: { id: string; done: boolean }[];
  }[];
  hidden: number;
}

const listOnboarding = async () =>
  (await (
    await app.request("http://localhost/api/dashboard/onboarding", { headers })
  ).json()) as OnboardingList;

/**
 * The checklist can be put away part-way, and stays away.
 *
 * Nothing in the browser holds this — every read here is a fresh request, so
 * a hidden checklist that came back on reload would fail the second look.
 */
test("setting up can be hidden part-way, and stays hidden", async () => {
  clearOnboarding();
  addOnboarding({
    moduleId: "dashboard",
    id: "putaway-guide",
    label: "Getting going",
    steps: [
      { id: "done-step", label: "Already happened", done: async () => true },
      { id: "todo-step", label: "Still to do" },
    ],
  });

  const before = await listOnboarding();
  expect(before.guides.map((g) => g.id)).toContain("putaway-guide");
  expect(before.hidden).toBe(0);

  const hid = await app.request(
    "http://localhost/api/dashboard/onboarding/hide",
    { method: "POST", headers },
  );
  expect(hid.status).toBe(200);

  const after = await listOnboarding();
  expect(after.guides).toEqual([]);
  // But not forgotten: this is what Settings offers to bring back.
  expect(after.hidden).toBe(1);

  // Ending early is not completing. The promo takes the checklist's place
  // when there is nothing left on it — a business that put the list away
  // still has a step to do, and is still not sold to.
  const free = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { ad: unknown };
  expect(free.ad).toBeNull();
});

/**
 * Restoring resumes, never restarts.
 *
 * Done is derived, not stored, so the step satisfied before the list was put
 * away is still ticked when it comes back — there is no progress to lose,
 * which is what makes dismissing safe to offer at all.
 */
test("a hidden checklist is restored mid-way, not restarted", async () => {
  const res = await app.request(
    "http://localhost/api/dashboard/onboarding/restore",
    { method: "POST", headers },
  );
  expect(res.status).toBe(200);

  const list = await listOnboarding();
  const guide = list.guides.find((g) => g.id === "putaway-guide");
  expect(guide?.steps.find((s) => s.id === "done-step")?.done).toBe(true);
  expect(guide?.remaining).toBe(1);
  expect(list.hidden).toBe(0);
  clearOnboarding();
});

/**
 * A finished guide has nothing to restore, whatever was dismissed.
 *
 * The row a dismissal left behind goes inert the day the last step is
 * satisfied — offering to "bring back" a checklist that would show nothing
 * is a control that does nothing, on a settings screen.
 */
test("a completed guide is not offered for restoration", async () => {
  addOnboarding({
    moduleId: "dashboard",
    id: "finished-guide",
    label: "Long done",
    steps: [{ id: "only", label: "The one step", done: async () => true }],
  });
  await db.insert(schema.onboardingDismissals).values({
    organizationId: orgId,
    guideId: "finished-guide",
  });

  const list = await listOnboarding();
  expect(list.guides).toEqual([]);
  expect(list.hidden).toBe(0);

  clearOnboarding();
  await db
    .delete(schema.onboardingDismissals)
    .where(eq(schema.onboardingDismissals.organizationId, orgId));
});

/**
 * A module bought on day 200 gets its day one.
 *
 * The platform's own setting up may be years finished, or put away half-done
 * — neither is a verdict on a module that did not exist yet. Dismissals are
 * per guide, so the new module's checklist appears on its own.
 */
test("a module added later brings its own onboarding, whatever came before", async () => {
  // One guide finished long ago, one put away part-way.
  addOnboarding({
    moduleId: "dashboard",
    id: "old-platform",
    label: "The platform",
    steps: [{ id: "claim", label: "Claim it", done: async () => true }],
  });
  addOnboarding({
    moduleId: "dashboard",
    id: "put-away",
    label: "Put away",
    steps: [{ id: "later", label: "Some day" }],
  });
  await db.insert(schema.onboardingDismissals).values({
    organizationId: orgId,
    guideId: "put-away",
  });

  // The module arrives: its guide registers, nothing else changes.
  addOnboarding({
    moduleId: "shop",
    id: "shop-setup",
    label: "Setting up the shop",
    steps: [{ id: "first-product", label: "Add a product" }],
  });

  const list = await listOnboarding();
  expect(list.guides.map((g) => g.id)).toEqual(["shop-setup"]);

  clearOnboarding();
  await db
    .delete(schema.onboardingDismissals)
    .where(eq(schema.onboardingDismissals.organizationId, orgId));
});

// ---------------------------------------------------------------------------
// Declared widgets, and an arrangement that never names what a reader
// cannot have
// ---------------------------------------------------------------------------

interface Layout {
  tabs: { name: string; widgets: string[] }[];
  widgets: { id: string; label: string; icon: string | null }[];
}

const readLayoutAs = async (
  on: typeof app,
  h: Headers = headers,
): Promise<Layout> =>
  (await (
    await on.request("http://localhost/api/dashboard/layout", { headers: h })
  ).json()) as Layout;

/** Puts the widget registry back the way this test found it. */
const restoreWidgets = (before: ReturnType<typeof allWidgets>) => {
  clearWidgets();
  for (const w of before) addWidget(w);
};

/**
 * The mechanism, not any particular module: a made-up module declares one
 * widget through the SDK and it is offered on the dashboard, with its own
 * figures, without the dashboard naming it anywhere.
 */
test("a module's declared widget appears on the dashboard", async () => {
  const before = allWidgets();
  addWidget({
    moduleId: "hire",
    id: "hire-fleet",
    label: "The fleet",
    icon: "boxes",
    load: async () => [{ label: "Out on hire", value: 7, kind: "count" }],
  });

  try {
    const layout = await readLayoutAs(app);
    expect(layout.widgets.map((w) => w.id)).toContain("hire:hire-fleet");
    // Offered by name, so the arranging screen has words rather than ids.
    expect(layout.widgets.find((w) => w.id === "hire:hire-fleet")?.label).toBe(
      "The fleet",
    );
    // And on the screen itself: a tab of its own, without anybody arranging.
    expect(layout.tabs.some((t) => t.widgets.includes("hire:hire-fleet"))).toBe(
      true,
    );

    const feed = (await (
      await app.request("http://localhost/api/dashboard/widgets", { headers })
    ).json()) as {
      widgets: { id: string; figures: { label: string; value: number }[] }[];
    };
    expect(
      feed.widgets.find((w) => w.id === "hire:hire-fleet")?.figures,
    ).toContainEqual({ label: "Out on hire", value: 7, kind: "count" });
  } finally {
    restoreWidgets(before);
  }
});

/**
 * Not entitled means not disclosed.
 *
 * The Free instance's arrangement must never name a Pro panel — not in the
 * offered list, not in a tab, and not echoed back from a save that tried to
 * smuggle one in. Telling a Free reader "revenue-trend exists, you cannot
 * have it" is advertising done by error message.
 */
test("a widget whose entitlement is absent is not disclosed anywhere", async () => {
  const layout = await readLayoutAs(freeApp);
  const offered = layout.widgets.map((w) => w.id);
  expect(offered).toContain("dashboard:money");
  // The ledger charts are Free as of 2026-09-20 — Core computes them.
  expect(offered).toContain("dashboard:revenue-trend");
  // These three are answered by Pro's accounting bundle. Absent on a Free
  // instance because there is no route to ask, not because of a price:
  // offering them would put a 404 on the Reports tab everybody sees by
  // default.
  expect(offered).not.toContain("dashboard:who-owes");
  expect(offered).not.toContain("dashboard:cash-flow");
  expect(offered).not.toContain("dashboard:trial-balance");
  expect(layout.tabs.flatMap((t) => t.widgets)).not.toContain(
    "dashboard:who-owes",
  );

  // A save that names one of them anyway gets nothing back for it.
  const saved = (await (
    await freeApp.request("http://localhost/api/dashboard/layout", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        tabs: [{ name: "Mine", widgets: ["money", "who-owes"] }],
      }),
    })
  ).json()) as Layout;
  expect(saved.tabs.flatMap((t) => t.widgets)).not.toContain("who-owes");

  // And a module-entitlement widget behaves exactly like the tier one.
  const before = allWidgets();
  addWidget({
    moduleId: "boutique",
    id: "boutique-sales",
    label: "Boutique sales",
    entitlement: { module: "boutique" },
    load: async () => [],
  });
  try {
    const strict = registerForTest(
      dashboard,
      undefined,
      () => false, // entitled to nothing beyond what loaded
    );
    const bare = await readLayoutAs(strict);
    expect(bare.widgets.map((w) => w.id)).not.toContain("boutique-sales");
    expect(bare.tabs.flatMap((t) => t.widgets)).not.toContain("boutique-sales");
  } finally {
    restoreWidgets(before);
  }
});

/** The reader's own gate: a widget they may not read is not theirs to see. */
test("a widget the reader lacks permission for is not disclosed", async () => {
  const before = allWidgets();
  addWidget({
    moduleId: "vault",
    id: "vault-holdings",
    label: "Vault",
    requires: { nonexistent: ["read"] },
    load: async () => [{ label: "Secrets", value: 1, kind: "count" }],
  });

  try {
    const layout = await readLayoutAs(app);
    expect(layout.widgets.map((w) => w.id)).not.toContain("vault-holdings");
    expect(layout.tabs.flatMap((t) => t.widgets)).not.toContain(
      "vault-holdings",
    );

    const feed = (await (
      await app.request("http://localhost/api/dashboard/widgets", { headers })
    ).json()) as { widgets: { id: string }[] };
    expect(feed.widgets.map((w) => w.id)).not.toContain("vault-holdings");
  } finally {
    restoreWidgets(before);
  }
});

/**
 * The arrangement belongs to the business, not to whoever saved it.
 *
 * "Look at the Shop tab" has to mean the same thing to everyone in a twelve
 * person company, so the tabs are one decision per organization.
 */
test("an arrangement persists per organization, not per person", async () => {
  const put = await app.request("http://localhost/api/dashboard/layout", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      tabs: [{ name: "Ours", widgets: ["money", "health"] }],
    }),
  });
  expect(put.status).toBe(200);

  // A colleague, signed in as themselves, sees the same tabs.
  const colleague = await signUpAsOwner({
    email: `dash-colleague-${suffix}@x.test`,
    password: "correct-horse-battery-staple",
    name: "Colleague",
  });
  const cookie = colleague.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const colleagueHeaders = new Headers({
    cookie,
    "content-type": "application/json",
  });
  const colleagueId = colleague.response.user.id;
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: colleagueId,
    role: "admin",
    baseRole: "admin",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: colleagueHeaders,
  });

  try {
    const res = await app.request("http://localhost/api/dashboard/layout", {
      headers: colleagueHeaders,
    });
    expect(res.status).toBe(200);
    const theirs = (await res.json()) as Layout;
    expect(theirs.tabs.map((t) => t.name)).toEqual(["Ours"]);
  } finally {
    await db.delete(schema.member).where(eq(schema.member.userId, colleagueId));
    await db
      .delete(schema.session)
      .where(eq(schema.session.userId, colleagueId));
    await db
      .delete(schema.account)
      .where(eq(schema.account.userId, colleagueId));
    await db.delete(schema.user).where(eq(schema.user.id, colleagueId));
  }
});

/**
 * A module bought on day 200 reaches the screen on day 200.
 *
 * The business arranged its tabs long ago; the new module's widget was in
 * nobody's arrangement and never will be unless it puts itself there.
 */
test("a newly entitled module's widget appears without the business doing anything", async () => {
  // The business has arranged — the saved layout knows nothing of what is
  // about to arrive.
  await app.request("http://localhost/api/dashboard/layout", {
    method: "PUT",
    headers,
    body: JSON.stringify({
      tabs: [{ name: "Ours", widgets: ["dashboard:money"] }],
    }),
  });

  const before = allWidgets();
  addWidget({
    moduleId: "shop",
    id: "shop-takings",
    label: "Shop",
    load: async () => [{ label: "Today", value: 12_300, kind: "money" }],
  });

  try {
    const layout = await readLayoutAs(app);
    // The arranged tab is untouched, and the new module has a tab of its own.
    expect(layout.tabs[0]).toEqual({
      name: "Ours",
      widgets: ["dashboard:money"],
    });
    const shopTab = layout.tabs.find((t) =>
      t.widgets.includes("shop:shop-takings"),
    );
    expect(shopTab?.name).toBe("Shop");
  } finally {
    restoreWidgets(before);
    // Reset the arrangement for whatever runs after this.
    await db
      .delete(schema.organizationPreferences)
      .where(eq(schema.organizationPreferences.organizationId, orgId));
  }
});

/**
 * The figures are six aggregates now, and every one of them is scoped.
 *
 * This screen used to read every invoice, quote, task, contact, deal and
 * payment the business had and work the numbers out in JavaScript; it now asks
 * the database for the numbers. That is only an improvement if the answer is
 * the same answer, and the part of "the same answer" that matters most is
 * whose it is — a faster query that reaches another business's rows is not a
 * faster query. Remove the organization filter from any of the six and this
 * fails.
 */
test("another business's rows are in none of the six figures", async () => {
  const theirs = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id: theirs,
    name: `Someone else ${theirs}`,
    slug: `someone-else-${theirs}`,
    createdAt: new Date(),
  });
  const longAgo = new Date(Date.now() - 400 * 86_400_000);

  const figures = async () => {
    const body = (await (await get()).json()) as {
      money: Record<string, number>;
      pipeline: Record<string, number>;
      book: { contacts: number };
      attention: { id: string }[];
    };
    return body;
  };
  const before = await figures();

  const [theirInvoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: theirs,
      number: "THEIRS-1",
      status: "sent",
      currency: "USD",
      issueDate: longAgo,
      dueDate: longAgo,
      subtotalCents: 5_000_000,
      taxCents: 0,
      totalCents: 5_000_000,
    })
    .returning();
  if (!theirInvoice) throw new Error("could not create their invoice");
  const [theirContact] = await db
    .insert(schema.contacts)
    .values({ organizationId: theirs, name: "Their customer" })
    .returning();
  const [theirDeal] = await db
    .insert(schema.deals)
    .values({
      organizationId: theirs,
      name: "Their deal",
      stage: "opportunity",
      amountCents: 999_000,
    })
    .returning();
  const [theirQuote] = await db
    .insert(schema.quotes)
    .values({
      organizationId: theirs,
      number: "THEIR-Q1",
      status: "sent",
      currency: "USD",
      subtotalCents: 1_000,
      taxCents: 0,
      totalCents: 1_000,
    })
    .returning();
  const [theirTask] = await db
    .insert(schema.tasks)
    .values({
      organizationId: theirs,
      title: "Their overdue follow-up",
      dueAt: longAgo,
      done: false,
    })
    .returning();
  const [theirPayment] = await db
    .insert(schema.payments)
    .values({
      organizationId: theirs,
      invoiceId: theirInvoice.id,
      amountCents: 1_000,
    })
    .returning();

  try {
    const after = await figures();
    expect(after.money).toEqual(before.money);
    expect(after.pipeline).toEqual(before.pipeline);
    expect(after.book).toEqual(before.book);
    expect(after.attention.map((a) => a.id)).toEqual(
      before.attention.map((a) => a.id),
    );
    // And nothing of theirs by name, in case a figure happened to tie.
    expect(JSON.stringify(after)).not.toContain("THEIRS-1");
    expect(JSON.stringify(after)).not.toContain("THEIR-Q1");
    expect(JSON.stringify(after)).not.toContain("Their overdue follow-up");
  } finally {
    for (const [table, id] of [
      [schema.payments, theirPayment?.id],
      [schema.invoices, theirInvoice.id],
      [schema.contacts, theirContact?.id],
      [schema.deals, theirDeal?.id],
      [schema.quotes, theirQuote?.id],
      [schema.tasks, theirTask?.id],
    ] as const) {
      if (id) await db.delete(table).where(eq(table.id, id));
    }
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, theirs));
  }
});

/**
 * Twelve of them, and the twelve that matter.
 *
 * The list is cut to twelve, and the rows it was cut from used to arrive in
 * whatever order a scan produced — so a business with thirteen overdue
 * invoices was chased about a different twelve on each refresh, and the oldest
 * debt could sit off the bottom of the screen indefinitely.
 */
test("the twelve most overdue, oldest first", async () => {
  const day = 86_400_000;
  const made = await db
    .insert(schema.invoices)
    .values(
      Array.from({ length: 15 }, (_, i) => ({
        organizationId: orgId,
        number: `LATE-${String(i).padStart(2, "0")}`,
        status: "sent",
        currency: "USD",
        issueDate: new Date(Date.now() - (200 - i) * day),
        // Oldest first: LATE-00 is the most overdue.
        dueDate: new Date(Date.now() - (100 - i) * day),
        subtotalCents: 1_000 + i,
        taxCents: 0,
        totalCents: 1_000 + i,
      })),
    )
    .returning();

  try {
    const body = (await (await get()).json()) as {
      attention: { kind: string; summary: string }[];
    };
    expect(body.attention).toHaveLength(12);
    const numbers = body.attention
      .filter((a) => a.kind === "invoice")
      .map((a) => a.summary.replace("Invoice ", "").replace(" is overdue", ""));
    // INV-100 from the earlier test is overdue by a day; these fifteen are
    // overdue by a hundred, so the twelve oldest are the first twelve of them.
    expect(numbers).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `LATE-${String(i).padStart(2, "0")}`,
      ),
    );
  } finally {
    await db.delete(schema.invoices).where(
      inArray(
        schema.invoices.id,
        made.map((i) => i.id),
      ),
    );
  }
});

/**
 * A credit note settles debt the way money does.
 *
 * Without it a partly credited invoice shows the credited share as still owed,
 * and the one figure on this screen somebody is most likely to act on is too
 * big.
 */
test("a credit note comes off what is owed, like a payment", async () => {
  const yesterday = new Date(Date.now() - 86_400_000);
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: "CREDITED-1",
      status: "sent",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 30_000,
      taxCents: 0,
      totalCents: 30_000,
    })
    .returning();
  if (!invoice) throw new Error("could not create the invoice");

  const owed = async () =>
    ((await (await get()).json()) as { money: { owedCents: number } }).money
      .owedCents;
  const withInvoice = await owed();

  const [note] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: "CN-1",
      kind: "credit_note",
      referenceInvoiceId: invoice.id,
      status: "sent",
      currency: "USD",
      issueDate: new Date(),
      subtotalCents: 12_000,
      taxCents: 0,
      totalCents: 12_000,
    })
    .returning();
  if (!note) throw new Error("could not create the credit note");

  try {
    expect(await owed()).toBe(withInvoice - 12_000);
    // A voided credit note gives the debt back.
    await db
      .update(schema.invoices)
      .set({ status: "void" })
      .where(eq(schema.invoices.id, note.id));
    expect(await owed()).toBe(withInvoice);
  } finally {
    await db
      .delete(schema.invoices)
      .where(inArray(schema.invoices.id, [invoice.id, note.id]));
  }
});

/**
 * The two rows that tell the remaining organization filters apart.
 *
 * The settlements are found by the invoice they name, and the invoices are
 * already this business's — so with well-formed data the filters on the
 * payment and on the credit note look like decoration. They are not: a row
 * pointing across is exactly what a bug writes, and without those filters
 * another business's payment would reduce this one's debt. So both are
 * written here on purpose. Remove either filter and one of these fails.
 */
test("a settlement belonging to another business does not pay this one's invoice", async () => {
  const theirs = crypto.randomUUID();
  await db.insert(schema.organizations).values({
    id: theirs,
    name: `Crossing ${theirs}`,
    slug: `crossing-${theirs}`,
    createdAt: new Date(),
  });
  const yesterday = new Date(Date.now() - 86_400_000);
  const [invoice] = await db
    .insert(schema.invoices)
    .values({
      organizationId: orgId,
      number: "CROSSED-1",
      status: "sent",
      currency: "USD",
      issueDate: yesterday,
      dueDate: yesterday,
      subtotalCents: 40_000,
      taxCents: 0,
      totalCents: 40_000,
    })
    .returning();
  if (!invoice) throw new Error("could not create the invoice");

  const owed = async () =>
    ((await (await get()).json()) as { money: { owedCents: number } }).money
      .owedCents;
  const full = await owed();

  const [payment] = await db
    .insert(schema.payments)
    .values({
      organizationId: theirs,
      invoiceId: invoice.id,
      amountCents: 15_000,
    })
    .returning();
  const [note] = await db
    .insert(schema.invoices)
    .values({
      organizationId: theirs,
      number: "CROSSED-CN",
      kind: "credit_note",
      referenceInvoiceId: invoice.id,
      status: "sent",
      currency: "USD",
      issueDate: new Date(),
      subtotalCents: 9_000,
      taxCents: 0,
      totalCents: 9_000,
    })
    .returning();

  try {
    expect(await owed()).toBe(full);
  } finally {
    if (payment) {
      await db
        .delete(schema.payments)
        .where(eq(schema.payments.id, payment.id));
    }
    await db.delete(schema.invoices).where(
      inArray(
        schema.invoices.id,
        [invoice.id, note?.id].filter((id): id is string => Boolean(id)),
      ),
    );
    await db
      .delete(schema.organizations)
      .where(eq(schema.organizations.id, theirs));
  }
});

/**
 * An afternoon spent arranging the dashboard survives the panels being keyed
 * by module.
 *
 * Every layout stored before today names its panels the way the old registry
 * did — `money`, `health`, `summary:invoicing` — the very words two modules
 * could both choose. Read literally against keys, every tab would filter down
 * to nothing and a business would open Monday morning to a blank screen with
 * its tab names still on it, which is the worst of both: it looks arranged
 * and it shows nothing.
 *
 * So a stored row is brought forward on read, and written back in the new
 * spelling by the next save. No migration, and no moment where a layout is
 * half converted.
 */
test("a dashboard arranged before panels were keyed by module still resolves", async () => {
  await db
    .insert(schema.organizationPreferences)
    .values({
      organizationId: orgId,
      key: "dashboard",
      value: {
        tabs: [
          { name: "Ours", widgets: ["money", "attention"] },
          { name: "Books", widgets: ["balance-sheet"] },
        ],
        known: ["money", "attention", "balance-sheet", "health"],
      },
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationPreferences.organizationId,
        schema.organizationPreferences.key,
      ],
      set: {
        value: {
          tabs: [
            { name: "Ours", widgets: ["money", "attention"] },
            { name: "Books", widgets: ["balance-sheet"] },
          ],
          known: ["money", "attention", "balance-sheet", "health"],
        },
      },
    });

  try {
    const layout = await readLayoutAs(app);
    // The arrangement is the one the business made: same tabs, same order,
    // same panels — addressed the new way. Anything this instance declares
    // and the stored `known` had never heard of still arrives after them,
    // which is the day-200 rule and is unrelated to the spelling.
    expect(layout.tabs.slice(0, 2).map((t) => t.name)).toEqual([
      "Ours",
      "Books",
    ]);
    expect(layout.tabs[0]?.widgets).toEqual([
      "dashboard:money",
      "dashboard:attention",
    ]);
    expect(layout.tabs[1]?.widgets).toEqual(["dashboard:balance-sheet"]);

    // And `known` came forward with it, or every panel the business had
    // deliberately taken off a tab would arrive again as a new module's.
    expect(layout.tabs.flatMap((t) => t.widgets)).not.toContain(
      "dashboard:health",
    );
  } finally {
    await db
      .delete(schema.organizationPreferences)
      .where(eq(schema.organizationPreferences.organizationId, orgId));
  }
});

/**
 * What somebody without the books is told, which was everything.
 *
 * `requires` on a widget gated the *list of widgets* and nothing else. This
 * route answered every figure to anybody holding `dashboard: ["read"]` — which
 * the seeded staff, marketing and customers policies all do, and none of which
 * grants bookkeeping. So a shop assistant opened the business's total owed,
 * its total overdue, its pipeline value and a list naming overdue invoices by
 * number, and the published dashboard page says in as many words that
 * somebody without access to the books sees no money figures at all.
 *
 * Found 2026-09-28, beside the Customer role that could read the whole
 * invoice book. Two halves of the same screen.
 */
test("a reader with no books is sent no money figures at all", async () => {
  const shopFloor = `dash-staff-${suffix}@x.test`;
  const signUp = await signUpAsOwner({
    email: shopFloor,
    password: "correct-horse-battery-staple",
    name: "On the shop floor",
  });
  const cookie = signUp.headers.get("set-cookie");
  if (!cookie) throw new Error("sign-up returned no session cookie");
  const theirs = new Headers({ cookie, "content-type": "application/json" });
  const theirId = signUp.response.user.id;

  // The seeded `customers` policy's whole permission, which is the smallest
  // thing that can open this screen at all.
  await auth.api.createOrgRole({
    body: {
      organizationId: orgId,
      role: `no-books-${suffix}`,
      permission: { dashboard: ["read"] },
    },
    headers,
  });
  await db.insert(schema.member).values({
    id: crypto.randomUUID(),
    organizationId: orgId,
    userId: theirId,
    role: `no-books-${suffix}`,
    baseRole: "member",
    createdAt: new Date(),
  });
  await auth.api.setActiveOrganization({
    body: { organizationId: orgId },
    headers: theirs,
  });

  const res = await app.request("http://localhost/api/dashboard", {
    headers: theirs,
  });
  expect(res.status).toBe(200);
  const seen = (await res.json()) as {
    money: unknown;
    pipeline: unknown;
    book: unknown;
    attention: unknown[];
    health: unknown;
  };

  // Absent rather than zeroed: a zero is an answer, and "the business is owed
  // nothing" is a different statement from "this is not yours to see".
  expect(seen.money).toBeNull();
  expect(seen.pipeline).toBeNull();
  expect(seen.book).toBeNull();
  expect(seen.attention).toEqual([]);
  /*
   * The server's own condition goes too, and for a different reason.
   *
   * No money and no personal data in it — the version, the uptime, how much
   * disk is left — which is why it survived the first pass. It is still the
   * exact release this instance runs and how much headroom it has, handed to
   * a shop assistant or a customer, and somebody deciding whether an instance
   * is worth attacking reads that first.
   */
  expect(seen.health).toBeNull();

  // The widget list agrees with the payload, so nothing names a panel that
  // would arrive empty.
  const offered = await app.request("http://localhost/api/dashboard/widgets", {
    headers: theirs,
  });
  if (offered.status === 200) {
    const { widgets } = (await offered.json()) as {
      widgets: { id: string }[];
    };
    expect(widgets.map((w) => w.id)).not.toContain("core:money");
    expect(widgets.map((w) => w.id)).not.toContain("core:attention");
  }

  /*
   * And the feed the charts are drawn from, which was missed when the panels
   * were gated four hours earlier and leaks more than they did: twelve months
   * of profit and loss off the ledger, the pipeline by stage and value, the
   * aged debt, and the top five customers **by name against what each spent**.
   */
  const charts = await app.request("http://localhost/api/dashboard/insights", {
    headers: theirs,
  });
  expect(charts.status).toBe(200);
  const drawn = (await charts.json()) as {
    months: unknown[];
    aging: unknown[];
    dealsByStage: unknown[];
    topCustomers: unknown[];
  };
  expect(drawn.months).toEqual([]);
  expect(drawn.aging).toEqual([]);
  expect(drawn.dealsByStage).toEqual([]);
  expect(drawn.topCustomers).toEqual([]);

  // The owner, who does the money, still sees all of it.
  const mine = await app.request("http://localhost/api/dashboard", { headers });
  const full = (await mine.json()) as {
    money: unknown;
    book: unknown;
    health: unknown;
  };
  expect(full.money).not.toBeNull();
  expect(full.book).not.toBeNull();
  expect(full.health).not.toBeNull();

  await db.delete(schema.member).where(eq(schema.member.userId, theirId));
  await db.delete(schema.user).where(eq(schema.user.id, theirId));
});

/**
 * A colleague who cannot see a panel must not be able to delete it.
 *
 * The arrangement is one decision per organization, and a response only ever
 * names panels the reader may have — so somebody whose policy covers one module
 * is handed a *cut-down* copy of the business's arrangement. Press Done
 * arranging and that cut-down copy is what gets stored: every panel they were
 * never shown is gone, for everybody, permanently. `known` keeps it from coming
 * back as a new arrival, which is right for a deliberate removal and is exactly
 * wrong here, because nobody removed anything.
 *
 * The fix is on the write rather than on the read: a save is merged into what is
 * stored, keeping the panels this writer was not shown where they already were.
 */
test("a reader who cannot see a panel does not delete it by saving", async () => {
  const before = allWidgets();
  addWidget({
    moduleId: "cellar",
    id: "cellar-stock",
    label: "Cellar",
    entitlement: { module: "cellar" },
    load: async () => [{ label: "Bottles", value: 12, kind: "count" }],
  });

  try {
    // The manager, entitled to it, puts it on a tab beside an ordinary panel.
    const put = await app.request("http://localhost/api/dashboard/layout", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        tabs: [
          {
            name: "Everything",
            widgets: ["dashboard:money", "cellar:cellar-stock"],
          },
        ],
      }),
    });
    expect(put.status).toBe(200);

    // Somebody entitled to nothing extra opens the same screen. They are not
    // told the cellar panel exists, which is the rule and is correct.
    const narrow = registerForTest(dashboard, undefined, () => false);
    const theirs = await readLayoutAs(narrow);
    expect(theirs.tabs.flatMap((t) => t.widgets)).not.toContain(
      "cellar:cellar-stock",
    );

    // They rename a tab and save. Nothing they did was about the cellar.
    const saved = await narrow.request(
      "http://localhost/api/dashboard/layout",
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          tabs: theirs.tabs.map((tab) => ({ ...tab, name: "Our week" })),
        }),
      },
    );
    expect(saved.status).toBe(200);

    // The manager comes back. The panel is still there, on the tab it was on.
    const mine = await readLayoutAs(app);
    expect(mine.tabs.flatMap((t) => t.widgets)).toContain(
      "cellar:cellar-stock",
    );
    expect(mine.tabs[0]?.name).toBe("Our week");
  } finally {
    restoreWidgets(before);
  }
});
