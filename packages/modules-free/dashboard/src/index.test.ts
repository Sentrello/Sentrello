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
import { eq } from "drizzle-orm";
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
    ad: { kind: string; url: string; headline: string } | null;
  };
  expect(free.tier).toBe("free");
  expect(free.ad?.kind).toBe("text");
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
test("the Pro endpoints do not exist without a Pro licence", async () => {
  const insights = await freeApp.request(
    "http://localhost/api/dashboard/insights",
    { headers },
  );
  expect(insights.status).toBe(404);

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
    body: JSON.stringify({ tabs: [{ name: "Mine", widgets: ["money"] }] }),
  });
  expect(saved.status).toBe(200);
  expect((await saved.json()).tabs).toEqual([
    { name: "Mine", widgets: ["money"] },
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
  expect(saved.tabs[0]?.widgets).toEqual(["money"]);

  const read = (await (
    await app.request("http://localhost/api/dashboard/layout", { headers })
  ).json()) as { tabs: { name: string }[]; widgets: { id: string }[] };
  expect(read.tabs).toHaveLength(12);
  expect(read.tabs[0]?.name).toBe("Tab 0");
  // Offered to this fully entitled reader; the Free reader's test below
  // asserts the same id is never named to somebody it is not for.
  expect(read.widgets.map((w) => w.id)).toContain("revenue-trend");

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

test("the promo copy Foothills publishes is what a Free dashboard shows", async () => {
  // The wording changes far more often than the product does, so it is a
  // document instances fetch rather than a string in a release. What matters
  // here is that the fetched document actually reaches the panel — and that a
  // Pro instance still sees none of it.
  const { refreshPromos } = await import("./promos");
  const dir = `/tmp/sentrello-promos-${crypto.randomUUID().slice(0, 8)}`;
  const previousDir = process.env.SENTRELLO_DATA_DIR;
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  await refreshPromos(
    async () =>
      new Response(
        JSON.stringify({
          ad: {
            kind: "text",
            headline: "Sentrello Pro, this month",
            body: "Ledger-backed reports",
            url: "https://sentrello.com/pro",
            cta: "Have a look",
          },
        }),
        { status: 200 },
      ),
  );

  const free = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as {
    ad: { kind: string; headline: string; body: string; cta: string } | null;
  };
  expect(free.ad?.headline).toBe("Sentrello Pro, this month");
  expect(free.ad?.cta).toBe("Have a look");
  expect(free.ad?.body).toBe("Ledger-backed reports");

  const pro = (await (await get()).json()) as { ad: unknown };
  expect(pro.ad).toBeNull();

  process.env.SENTRELLO_DATA_DIR = previousDir;
});

/**
 * The first day, which is the one that matters.
 *
 * The document is fetched nightly, so without this a new install shows the
 * built-in copy until 04:17 tomorrow — a full day of the wrong words on the
 * first screen a new Free user looks at.
 */
test("an instance that has never fetched the promo document fetches once", async () => {
  const { refreshPromosIfStale, readPromos } = await import("./promos");
  const dir = `/tmp/sentrello-promos-${crypto.randomUUID().slice(0, 8)}`;
  const previousDir = process.env.SENTRELLO_DATA_DIR;
  process.env.SENTRELLO_DATA_DIR = dir;
  process.env.SENTRELLO_PROMOS = "on";

  let calls = 0;
  const answer = async () => {
    calls += 1;
    return new Response(
      JSON.stringify({
        ad: {
          kind: "text",
          headline: "Fetched on the first boot",
          body: "A line",
          url: "https://sentrello.com/pro",
          cta: "Look",
        },
      }),
      { status: 200 },
    );
  };

  await refreshPromosIfStale(answer);
  expect(calls).toBe(1);
  const first = (await readPromos()).ad;
  if (first.kind !== "text") throw new Error("expected a text advertisement");
  expect(first.headline).toBe("Fetched on the first boot");

  // And not again on the next restart: a fresh cache is left alone, or an
  // instance that reboots all afternoon asks us every time.
  await refreshPromosIfStale(answer);
  expect(calls).toBe(1);

  /**
   * But a cache older than the window is refreshed, however it got old.
   *
   * This is the case that made the whole thing look broken: copy saved at
   * half past five was invisible until the next morning, because the only
   * fetch had happened an hour before it was written.
   */
  const { utimes } = await import("node:fs/promises");
  const stale = new Date(Date.now() - 3 * 60 * 60 * 1000);
  await utimes(`${dir}/promos.json`, stale, stale);
  await refreshPromosIfStale(answer);
  expect(calls).toBe(2);

  /**
   * And an hour is stale, because the job that calls this runs hourly.
   *
   * With a window wider than the schedule, every other run returned without
   * asking and a change saved in Master took two hours to reach a dashboard.
   */
  const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  await utimes(`${dir}/promos.json`, anHourAgo, anHourAgo);
  await refreshPromosIfStale(answer);
  expect(calls).toBe(3);

  // Off means off, however stale the cache is.
  process.env.SENTRELLO_PROMOS = "off";
  await utimes(`${dir}/promos.json`, stale, stale);
  await refreshPromosIfStale(answer);
  expect(calls).toBe(3);

  process.env.SENTRELLO_PROMOS = "on";
  process.env.SENTRELLO_DATA_DIR = previousDir;
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
  const hire = widgets.find((s) => s.id === "summary:hire");
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
  expect(widgets.map((s) => s.id)).toEqual(["summary:fine"]);

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
  ).json()) as { ad: { kind: string } | null };
  expect(offered.ad?.kind).toBe("text");
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
    expect(layout.widgets.map((w) => w.id)).toContain("hire-fleet");
    // Offered by name, so the arranging screen has words rather than ids.
    expect(layout.widgets.find((w) => w.id === "hire-fleet")?.label).toBe(
      "The fleet",
    );
    // And on the screen itself: a tab of its own, without anybody arranging.
    expect(layout.tabs.some((t) => t.widgets.includes("hire-fleet"))).toBe(
      true,
    );

    const feed = (await (
      await app.request("http://localhost/api/dashboard/widgets", { headers })
    ).json()) as {
      widgets: { id: string; figures: { label: string; value: number }[] }[];
    };
    expect(
      feed.widgets.find((w) => w.id === "hire-fleet")?.figures,
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
  expect(offered).toContain("money");
  expect(offered).not.toContain("revenue-trend");
  expect(offered).not.toContain("who-owes");
  // Answered by Pro's accounting bundle, absent on a Free instance the same
  // way who-owes is: offering either here would put a 404 on the Reports tab
  // everybody sees by default.
  expect(offered).not.toContain("cash-flow");
  expect(offered).not.toContain("trial-balance");
  expect(layout.tabs.flatMap((t) => t.widgets)).not.toContain("revenue-trend");

  // A save that names the Pro panel anyway gets nothing back for it.
  const saved = (await (
    await freeApp.request("http://localhost/api/dashboard/layout", {
      method: "PUT",
      headers,
      body: JSON.stringify({
        tabs: [{ name: "Mine", widgets: ["money", "revenue-trend"] }],
      }),
    })
  ).json()) as Layout;
  expect(saved.tabs.flatMap((t) => t.widgets)).not.toContain("revenue-trend");

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
    body: JSON.stringify({ tabs: [{ name: "Ours", widgets: ["money"] }] }),
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
    expect(layout.tabs[0]).toEqual({ name: "Ours", widgets: ["money"] });
    const shopTab = layout.tabs.find((t) => t.widgets.includes("shop-takings"));
    expect(shopTab?.name).toBe("Shop");
  } finally {
    restoreWidgets(before);
    // Reset the arrangement for whatever runs after this.
    await db
      .delete(schema.organizationPreferences)
      .where(eq(schema.organizationPreferences.organizationId, orgId));
  }
});
