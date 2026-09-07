import { afterAll, beforeAll, expect, test } from "bun:test";
import { auth } from "@sentrello/auth";
import { signUpAsOwner } from "@sentrello/auth/testing";
import { db, schema } from "@sentrello/db";
import {
  addSummary,
  clearSummaries,
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
/**
 * Put this business's start date far enough back to be sold to.
 *
 * Nothing is offered for the first sixty days, so a test that wants to see an
 * advertisement has to be about a business that has been here a while. Ageing
 * the row is the honest way to do it: the rule reads the organization's own
 * creation date, and so does this.
 */
async function beenHereAWhile(days = 90): Promise<void> {
  await db
    .update(schema.organizations)
    .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(schema.organizations.id, orgId));
}

test("Pro is not sold to, Free is", async () => {
  await beenHereAWhile();
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
 * Hiding a panel in the browser while the endpoint still answers is how a
 * paid feature becomes a free one for anybody who opens the network tab.
 */
test("the Pro endpoints do not exist without a Pro licence", async () => {
  for (const path of ["/api/dashboard/insights", "/api/dashboard/layout"]) {
    const res = await freeApp.request(`http://localhost${path}`, { headers });
    expect(res.status).toBe(404);
  }
  expect((await get()).status).toBe(200);
  expect(
    (await app.request("http://localhost/api/dashboard/insights", { headers }))
      .status,
  ).toBe(200);
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

test("a layout survives a save, and cannot grow past six tabs", async () => {
  const tabs = Array.from({ length: 9 }, (_, i) => ({
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

  expect(saved.tabs).toHaveLength(6);
  // Unknown panels are dropped rather than refused: a layout saved by a newer
  // version should lose what it cannot draw and keep the rest.
  expect(saved.tabs[0]?.widgets).toEqual(["money"]);

  const read = (await (
    await app.request("http://localhost/api/dashboard/layout", { headers })
  ).json()) as { tabs: { name: string }[]; widgets: string[] };
  expect(read.tabs).toHaveLength(6);
  expect(read.tabs[0]?.name).toBe("Tab 0");
  expect(read.widgets).toContain("revenue-trend");

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
  await beenHereAWhile();
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
    moduleId: "widgets",
    id: "widgets",
    label: "Widget hire",
    icon: "boxes",
    opens: "widgets",
    load: async () => [
      { label: "Out on hire", value: 7, kind: "count" },
      { label: "Owed", value: 12_500, kind: "money", tone: "bad" },
    ],
  });

  const res = await app.request("http://localhost/api/dashboard/summaries", {
    headers,
  });
  expect(res.status).toBe(200);
  const { summaries } = (await res.json()) as {
    summaries: {
      id: string;
      label: string;
      opens: string | null;
      figures: { label: string; value: number }[];
    }[];
  };

  const hire = summaries.find((s) => s.id === "widgets");
  expect(hire?.label).toBe("Widget hire");
  expect(hire?.opens).toBe("widgets");
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

  const res = await app.request("http://localhost/api/dashboard/summaries", {
    headers,
  });
  expect(res.status).toBe(200);
  const { summaries } = (await res.json()) as { summaries: { id: string }[] };
  expect(summaries.map((s) => s.id)).toEqual(["fine"]);

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

  const res = await app.request("http://localhost/api/dashboard/summaries", {
    headers,
  });
  expect(res.status).toBe(200);
  const { summaries } = (await res.json()) as { summaries: { id: string }[] };
  expect(summaries.map((s) => s.id)).not.toContain("vault");

  clearSummaries();
});

/**
 * And a business that arrived this morning is not sold to at all.
 *
 * The rule that matters on the route rather than in the helper: asserting
 * `pastQuietPeriod` is right proves nothing about whether the dashboard asks
 * it. A brand-new instance is exactly the case somebody would forget, because
 * every test fixture creates its organization a moment before it looks.
 */
test("a business that has just arrived is left alone", async () => {
  await db
    .update(schema.organizations)
    .set({ createdAt: new Date() })
    .where(eq(schema.organizations.id, orgId));

  const fresh = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { tier: string; ad: unknown };
  expect(fresh.tier).toBe("free");
  expect(fresh.ad).toBeNull();

  // Fifty-nine days in, still nothing.
  await db
    .update(schema.organizations)
    .set({ createdAt: new Date(Date.now() - 59 * 86_400_000) })
    .where(eq(schema.organizations.id, orgId));
  const nearly = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { ad: unknown };
  expect(nearly.ad).toBeNull();

  // Sixty-one, and the offer is there — and stays there, because it is not a
  // campaign with an end.
  await beenHereAWhile(61);
  const offered = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { ad: { kind: string } | null };
  expect(offered.ad?.kind).toBe("text");

  await beenHereAWhile(900);
  const stillOffered = (await (
    await freeApp.request("http://localhost/api/dashboard", { headers })
  ).json()) as { ad: { kind: string } | null };
  expect(stillOffered.ad?.kind).toBe("text");
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
