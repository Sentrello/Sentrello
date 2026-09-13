import { db, schema } from "@sentrello/db";
import { and, eq, gte, isNull } from "drizzle-orm";

/**
 * The half of the dashboard a licence pays for.
 *
 * Free answers "what needs doing today". This answers "how is the business
 * doing", which is a different question and a slower one — twelve months of
 * ledger rather than a list of what is late. It is also the half somebody
 * arranges to suit themselves, so the layout lives here too.
 *
 * Charts are computed here and drawn as plain SVG on the client. A charting
 * library would be a dependency in a public repo for what amounts to a
 * polyline and some rectangles.
 */

/** Every panel the Pro dashboard knows how to draw. */
export const WIDGETS = [
  "money",
  "attention",
  "pipeline",
  "health",
  "revenue-trend",
  "cash-position",
  "deals-by-stage",
  "top-customers",
  "invoice-aging",
  /**
   * The reports, which used to be a module of their own.
   *
   * They are not a separate thing: a dashboard *is* a collection of reports,
   * and a screen called Reports beside a screen full of figures is two places
   * to look for one answer.
   */
  "balance-sheet",
  "cash-flow",
  "trial-balance",
  /** Named invoices, not buckets: the list somebody works down on a Friday. */
  "who-owes",
] as const;

export type Widget = (typeof WIDGETS)[number];

/**
 * A widget a module brought with it, by the summary it registered.
 *
 * The built-in list above is closed and core-only, which is as far as it can
 * go: Shop and Booking live in another repository and Core must not import
 * them. Each module already declares what it is worth showing — that is
 * `registerSummary` in the SDK — and every one of those is now a panel of its
 * own that can be put on a tab, rather than all of them being lumped into one
 * card nobody could arrange.
 *
 * A widget exists only for a module this instance loaded, which the licence
 * already decides, and is only drawn for somebody the summary's own `requires`
 * lets read it. Two gates, the same pair as everywhere else.
 */
const SUMMARY_PREFIX = "summary:";

/** Ids are module-chosen, so the shape is checked rather than a list of them. */
const SUMMARY_WIDGET = /^summary:[a-z0-9][a-z0-9-]{0,60}$/;

export const isSummaryWidget = (w: string): boolean => SUMMARY_WIDGET.test(w);

export const summaryWidget = (summaryId: string): string =>
  `${SUMMARY_PREFIX}${summaryId}`;

export const summaryIdOf = (widget: string): string =>
  widget.slice(SUMMARY_PREFIX.length);

export interface Tab {
  name: string;
  widgets: Widget[];
}

/**
 * Six, because the user asked for six.
 *
 * Worth enforcing rather than trusting the screen: the tab strip is built from
 * whatever is stored, and a payload with two hundred tabs is one PUT away.
 */
/**
 * Six was the limit while every tab was one somebody typed by hand. Tabs are
 * generated now — one per module this instance loaded — so an instance with
 * the Shop, Booking, the Newsletter, Storage and SEO needs room for them
 * beside the four core screens and System.
 */
const MAX_TABS = 12;

/** Overview, Performance, Sales, Reports — the four before any module's. */
const CORE_TABS = 4;
const MAX_WIDGETS_PER_TAB = 12;

/**
 * What somebody sees before they have arranged anything.
 *
 * `modules` — the card listing every module at once — is deliberately not on
 * it any more. Each module has a panel of its own now, so that card was the
 * same figures twice, and the one you could not move.
 *
 * Given what this instance loaded, every module gets a tab of its own, between
 * the core screens and System. That is the shape the product is meant to have:
 * a business with the Shop opens the dashboard and finds a Shop tab, without
 * arranging anything.
 */
export function defaultLayout(
  modules: { id: string; label: string }[] = [],
): Tab[] {
  return [
    {
      name: "Overview",
      widgets: ["money", "attention", "pipeline", "invoice-aging"],
    },
    {
      name: "Performance",
      widgets: ["revenue-trend", "cash-position", "top-customers"],
    },
    { name: "Sales", widgets: ["deals-by-stage", "pipeline"] },
    {
      name: "Reports",
      widgets: ["who-owes", "balance-sheet", "cash-flow", "trial-balance"],
    },
    /*
     * Trimmed here rather than at the end, so it is a module that is dropped
     * when there are too many and never System. The first cut sliced the whole
     * list and lost the health tab on any instance with enough modules —
     * exactly the tab that must always be reachable, because it is where
     * somebody looks when the instance is the thing that is wrong.
     */
    ...modules.slice(0, MAX_TABS - CORE_TABS - 1).map((m) => ({
      name: m.label,
      widgets: [summaryWidget(m.id)] as Widget[],
    })),
    { name: "System", widgets: ["health"] },
  ];
}

/**
 * Whatever was sent, turned into something safe to store and to render.
 *
 * Unknown widget ids are dropped rather than rejected: an instance that
 * downgrades, or a layout saved by a newer version, should lose the panel it
 * cannot draw and keep the rest — not refuse to load anybody's dashboard.
 */
export function normalizeLayout(
  input: unknown,
  modules: { id: string; label: string }[] = [],
): Tab[] {
  if (!Array.isArray(input)) return defaultLayout(modules);

  const tabs: Tab[] = [];
  for (const raw of input.slice(0, MAX_TABS)) {
    if (!raw || typeof raw !== "object") continue;
    const tab = raw as { name?: unknown; widgets?: unknown };
    const name =
      typeof tab.name === "string" && tab.name.trim()
        ? tab.name.trim().slice(0, 40)
        : `Tab ${tabs.length + 1}`;
    /*
     * A module's widget is kept even when that module is not loaded right now.
     * A licence that lapses and is renewed, or a module switched off for a
     * week, should find its panel where it was left rather than having been
     * quietly deleted from the layout while it was away. Nothing is drawn for
     * a widget the instance cannot supply — the screen renders what comes
     * back, not what is stored.
     */
    const widgets = Array.isArray(tab.widgets)
      ? (
          tab.widgets.filter(
            (w): w is Widget =>
              typeof w === "string" &&
              (WIDGETS.includes(w as Widget) || isSummaryWidget(w)),
          ) as Widget[]
        ).slice(0, MAX_WIDGETS_PER_TAB)
      : [];
    tabs.push({ name, widgets });
  }
  // A layout with no tabs at all is a blank screen with no way back to a
  // usable one, so an empty save resets rather than empties.
  return tabs.length ? tabs : defaultLayout(modules);
}

export async function readLayout(
  organizationId: string,
  userId: string,
  modules: { id: string; label: string }[] = [],
): Promise<Tab[]> {
  const [row] = await db
    .select({ value: schema.userPreferences.value })
    .from(schema.userPreferences)
    .where(
      and(
        eq(schema.userPreferences.organizationId, organizationId),
        eq(schema.userPreferences.userId, userId),
        eq(schema.userPreferences.key, "dashboard"),
      ),
    )
    .limit(1);

  if (!row) return defaultLayout(modules);
  const stored = row.value as { tabs?: unknown };
  return normalizeLayout(stored?.tabs, modules);
}

export async function writeLayout(
  organizationId: string,
  userId: string,
  tabs: Tab[],
): Promise<void> {
  await db
    .insert(schema.userPreferences)
    .values({
      organizationId,
      userId,
      key: "dashboard",
      value: { tabs },
    })
    // Saving twice is the normal case — every rearrange is a save.
    .onConflictDoUpdate({
      target: [
        schema.userPreferences.organizationId,
        schema.userPreferences.userId,
        schema.userPreferences.key,
      ],
      set: { value: { tabs }, updatedAt: new Date() },
    });
}

export interface Insights {
  months: {
    month: string;
    incomeCents: number;
    expenseCents: number;
    netCents: number;
  }[];
  dealsByStage: { stage: string; count: number; cents: number }[];
  topCustomers: { name: string; cents: number }[];
  aging: { bucket: string; cents: number; count: number }[];
}

/** `2026-08`, so months sort as strings and group without a date library. */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function readInsights(organizationId: string): Promise<Insights> {
  const now = new Date();
  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1),
  );

  const [ledger, deals, invoices, contacts] = await Promise.all([
    // The ledger, not the invoice table. A reported figure that disagrees with
    // the books is worse than no figure, and the books are the ones defended.
    db
      .select({
        postedAt: schema.journalEntries.postedAt,
        type: schema.accounts.type,
        debitCents: schema.journalLines.debitCents,
        creditCents: schema.journalLines.creditCents,
      })
      .from(schema.journalLines)
      .innerJoin(
        schema.journalEntries,
        eq(schema.journalLines.entryId, schema.journalEntries.id),
      )
      .innerJoin(
        schema.accounts,
        eq(schema.journalLines.accountId, schema.accounts.id),
      )
      .where(
        and(
          eq(schema.journalEntries.organizationId, organizationId),
          eq(schema.accounts.organizationId, organizationId),
          gte(schema.journalEntries.postedAt, from),
        ),
      ),
    db
      .select()
      .from(schema.deals)
      .where(
        and(
          eq(schema.deals.organizationId, organizationId),
          isNull(schema.deals.archivedAt),
        ),
      ),
    db
      .select()
      .from(schema.invoices)
      .where(eq(schema.invoices.organizationId, organizationId)),
    db
      .select({
        id: schema.contacts.id,
        firstName: schema.contacts.firstName,
        lastName: schema.contacts.lastName,
      })
      .from(schema.contacts)
      .where(eq(schema.contacts.organizationId, organizationId)),
  ]);

  // Every month in the window, including the quiet ones. A series that skips
  // empty months draws a line that slopes through a gap it never had.
  const months = new Map<
    string,
    {
      month: string;
      incomeCents: number;
      expenseCents: number;
      netCents: number;
    }
  >();
  for (let i = 11; i >= 0; i -= 1) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    const key = monthKey(d);
    months.set(key, {
      month: key,
      incomeCents: 0,
      expenseCents: 0,
      netCents: 0,
    });
  }
  for (const line of ledger) {
    const bucket = months.get(monthKey(new Date(line.postedAt)));
    if (!bucket) continue;
    // Income accounts carry credit balances, expense accounts debit balances.
    if (line.type === "income")
      bucket.incomeCents += line.creditCents - line.debitCents;
    if (line.type === "expense")
      bucket.expenseCents += line.debitCents - line.creditCents;
  }
  for (const bucket of months.values()) {
    bucket.netCents = bucket.incomeCents - bucket.expenseCents;
  }

  const stages = new Map<
    string,
    { stage: string; count: number; cents: number }
  >();
  for (const deal of deals) {
    const stage = deal.stage ?? "unknown";
    const bucket = stages.get(stage) ?? { stage, count: 0, cents: 0 };
    bucket.count += 1;
    bucket.cents += deal.amountCents;
    stages.set(stage, bucket);
  }

  const names = new Map(
    contacts.map((c) => [
      c.id,
      [c.firstName, c.lastName].filter(Boolean).join(" ").trim() || "Unnamed",
    ]),
  );
  const byCustomer = new Map<string, number>();
  for (const inv of invoices) {
    if (inv.status === "void" || inv.status === "draft") continue;
    const name = inv.contactId
      ? (names.get(inv.contactId) ?? "Unnamed")
      : "No customer";
    byCustomer.set(name, (byCustomer.get(name) ?? 0) + inv.totalCents);
  }

  // How late the money is, not just that it is late. Thirty days out is a
  // reminder; ninety is a decision about whether it is coming at all.
  const aging = [
    { bucket: "Not yet due", cents: 0, count: 0 },
    { bucket: "1–30 days", cents: 0, count: 0 },
    { bucket: "31–60 days", cents: 0, count: 0 },
    { bucket: "61–90 days", cents: 0, count: 0 },
    { bucket: "Over 90 days", cents: 0, count: 0 },
  ];
  for (const inv of invoices) {
    if (
      inv.status === "paid" ||
      inv.status === "void" ||
      inv.status === "draft"
    )
      continue;
    const days = inv.dueDate
      ? Math.floor(
          (now.getTime() - new Date(inv.dueDate).getTime()) / 86_400_000,
        )
      : 0;
    const slot =
      days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
    const bucket = aging[slot];
    if (!bucket) continue;
    bucket.cents += inv.totalCents;
    bucket.count += 1;
  }

  return {
    months: [...months.values()],
    dealsByStage: [...stages.values()].sort((a, b) => b.cents - a.cents),
    topCustomers: [...byCustomer.entries()]
      .map(([name, cents]) => ({ name, cents }))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 5),
    aging,
  };
}
