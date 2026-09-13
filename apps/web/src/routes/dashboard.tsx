import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Bars, Line, type Point } from "../lib/charts";
import { useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  ErrorNote,
  Input,
  Loading,
  Tabs,
  activeTab,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * What needs doing, and what is going wrong.
 *
 * A report answers a question somebody already has. This answers the one they
 * have not asked — so it leads with money already earned and not received,
 * because that is the number that changes what somebody does with their
 * morning.
 *
 * One screen, two dashboards. Free shows what the Core modules know plus the
 * case for Pro; Pro drops the selling, adds twelve months of ledger, and lets
 * somebody arrange it into tabs. Two files would have meant two dashboards
 * drifting apart, and the half nobody was looking at would be the Free one —
 * the half every new instance opens first.
 */

interface Health {
  version: string;
  uptimeSeconds: number;
  database: { reachable: boolean; sizeBytes: number | null };
  disk: { freeBytes: number; totalBytes: number; usedPercent: number } | null;
  memory: { usedBytes: number; totalBytes: number } | null;
}

interface Dashboard {
  tier: "free" | "pro";
  /**
   * The advertisement, or nothing on Pro.
   *
   * Two shapes because two things get sold: a line of copy with a button, and
   * a banner image. Anything else is markup somebody sent us, which is not
   * something a dashboard renders.
   */
  /**
   * Set only while the business has nothing in it yet.
   *
   * The server decides, from whether anything has been added — so there is
   * nothing to dismiss, nothing to remember, and it goes on its own the
   * moment somebody adds a contact or raises an invoice.
   */
  startHere: { url: string } | null;
  ad:
    | {
        kind: "text";
        headline: string;
        body: string;
        cta: string;
        url: string;
      }
    | { kind: "image"; imageUrl: string; alt: string; url: string }
    | null;
  health: Health;
  money: {
    owedCents: number;
    overdueCents: number;
    unpaidCount: number;
    overdueCount: number;
  };
  pipeline: { openCount: number; openCents: number; wonCount: number };
  book: { contacts: number };
  attention: {
    id: string;
    kind: "invoice" | "quote" | "task";
    summary: string;
    detail: string;
    amountCents?: number;
  }[];
}

interface Insights {
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

interface Tab {
  name: string;
  widgets: string[];
}

/**
 * What a module says about itself.
 *
 * The dashboard knows none of them by name. Shop and Booking live in another
 * repository and Core must not import them, so each module registers a few
 * figures on the server and this draws whatever came back.
 */
interface ModuleSummary {
  id: string;
  moduleId: string;
  label: string;
  icon: string | null;
  opens: string | null;
  figures: {
    label: string;
    value: number | string;
    kind?: "money" | "count" | "text";
    tone?: "plain" | "good" | "bad";
  }[];
}

interface BalanceSheet {
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  retainedEarningsCents: number;
  balancedCents: number;
}

interface CashFlow {
  inCents: number;
  outCents: number;
  netCents: number;
}

interface TrialBalanceRow {
  code: string;
  name: string;
  type: string;
  netCents: number;
}

interface AgedReceivables {
  invoices: {
    invoiceId: string;
    number: string;
    customerName: string | null;
    currency: string;
    balanceDue: number;
    ageDays: number;
  }[];
  aging: {
    current: number;
    days30: number;
    days60: number;
    days90plus: number;
  };
  totalCents: number;
}

/** Every panel, and what to call it when somebody is choosing between them. */
const WIDGET_LABELS: Record<string, string> = {
  money: "Money owed",
  attention: "Needs attention",
  pipeline: "Pipeline",
  health: "This server",
  "revenue-trend": "Income and expenses",
  "cash-position": "Profit trend",
  "deals-by-stage": "Deals by stage",
  "top-customers": "Top customers",
  "invoice-aging": "How late the money is",
  modules: "Your modules",
  "balance-sheet": "Balance sheet",
  "cash-flow": "Cash in and out",
  "trial-balance": "Trial balance",
  "who-owes": "Who owes you",
};

function Figure({
  label,
  value,
  hint,
  alarming,
}: {
  label: string;
  value: string;
  hint?: string;
  alarming?: boolean;
}) {
  return (
    <Card>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className="money mt-1 text-2xl font-semibold"
        style={alarming ? { color: "var(--color-danger)" } : undefined}
      >
        {value}
      </p>
      {hint ? (
        <p className="mt-0.5 text-xs" style={muted}>
          {hint}
        </p>
      ) : null}
    </Card>
  );
}

const WHERE: Record<string, { moduleId: string; title: string }> = {
  invoice: { moduleId: "invoicing", title: "Invoices" },
  quote: { moduleId: "quotes", title: "Quotes" },
  task: { moduleId: "contacts", title: "Contacts" },
};

export function Dashboard() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api<Dashboard>("/api/dashboard"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return data.tier === "pro" ? (
    <ProDashboard data={data} />
  ) : (
    <FreeDashboard data={data} />
  );
}

function FreeDashboard({ data }: { data: Dashboard }) {
  return (
    <div className="space-y-4">
      {/* Before anything else, and only while there is nothing else. */}
      <StartHere startHere={data.startHere} />

      {/* Free only, and first on the screen. A business that has paid should
          not be advertised to on the page it opens each morning — not being
          sold to is part of what was bought. */}
      <AdSlot ad={data.ad} />

      <MoneyPanel data={data} />
      <AttentionPanel data={data} />
      <HealthPanel health={data.health} />
    </div>
  );
}

/**
 * The Pro dashboard: the same figures, arranged by whoever is reading them.
 *
 * Tabs rather than one long scroll, because the person who wants the ledger
 * charts every Monday is not the person who wants the overdue list every
 * morning, and on most instances they are the same person on different days.
 */
function ProDashboard({ data }: { data: Dashboard }) {
  const [active, setActive] = useState("");
  const [arranging, setArranging] = useState(false);

  const layout = useQuery({
    queryKey: ["dashboard", "layout"],
    queryFn: () =>
      api<{ tabs: Tab[]; widgets: string[] }>("/api/dashboard/layout"),
  });
  const insights = useQuery({
    queryKey: ["dashboard", "insights"],
    queryFn: () => api<Insights>("/api/dashboard/insights"),
  });

  if (layout.isLoading) return <Loading />;
  if (layout.error) return <ErrorNote error={layout.error} />;
  if (!layout.data) return null;

  const tabs = layout.data.tabs;
  // The tab strip works in ids; a dashboard tab's name is its id. `activeTab`
  // resolves the one showing, which is also the fallback that replaced the
  // `Math.min(active, tabs.length - 1)` clamp this screen used to do inline —
  // same behaviour when a tab is deleted, now shared and tested.
  const strip = tabs.map((tab) => ({ id: tab.name, label: tab.name }));
  const current = tabs.find((tab) => tab.name === activeTab(strip, active)?.id);

  return (
    <div className="space-y-4">
      <Tabs
        tabs={strip}
        active={active}
        onChange={setActive}
        trailing={
          <button
            type="button"
            className="text-sm link-muted"
            onClick={() => setArranging((a) => !a)}
          >
            {arranging ? "Done arranging" : "Arrange"}
          </button>
        }
      />

      {arranging ? (
        <Arrange
          tabs={tabs}
          widgets={layout.data.widgets}
          onSaved={() => {
            setArranging(false);
            // Back to the first tab, whatever it is now called — arranging is
            // what can rename or remove the one that was showing.
            setActive("");
          }}
        />
      ) : null}

      <div className="space-y-4">
        {(current?.widgets ?? []).map((widget) => (
          <Widget
            key={widget}
            id={widget}
            data={data}
            insights={insights.data}
          />
        ))}
        {current && current.widgets.length === 0 ? (
          <Card>
            <p className="text-sm" style={muted}>
              This tab is empty. Use “Arrange” to put something on it.
            </p>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

function Widget({
  id,
  data,
  insights,
}: {
  id: string;
  data: Dashboard;
  insights: Insights | undefined;
}) {
  switch (id) {
    case "money":
      return <MoneyPanel data={data} />;
    case "attention":
      return <AttentionPanel data={data} />;
    case "health":
      return <HealthPanel health={data.health} />;
    case "modules":
      return <ModulesPanel />;
    case "balance-sheet":
      return <BalanceSheetPanel />;
    case "cash-flow":
      return <CashFlowPanel />;
    case "trial-balance":
      return <TrialBalancePanel />;
    case "who-owes":
      return <WhoOwesPanel />;
    case "pipeline":
      return (
        <Card>
          <p className="mb-2 font-medium">Pipeline</p>
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <Stat
              label="Open"
              value={formatMoney(data.pipeline.openCents)}
              hint={`${data.pipeline.openCount} deals`}
            />
            <Stat label="Won" value={String(data.pipeline.wonCount)} />
            <Stat
              label="People in the book"
              value={String(data.book.contacts)}
            />
          </div>
        </Card>
      );
    default:
      return <InsightWidget id={id} insights={insights} />;
  }
}

/**
 * Every loaded module, in its own words.
 *
 * One panel rather than one per module: the set changes with the licence, and
 * a saved layout naming panels that no longer exist is a dashboard with holes
 * in it. The cards are whatever the server returned, so a module we have never
 * heard of here draws correctly the day it is installed.
 */
function ModulesPanel() {
  const { open } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["dashboard", "summaries"],
    queryFn: () =>
      api<{ summaries: ModuleSummary[] }>("/api/dashboard/summaries"),
  });

  if (isLoading) {
    return (
      <Card>
        <p className="mb-2 font-medium">Your modules</p>
        <Loading />
      </Card>
    );
  }
  if (error) return <ErrorNote error={error} />;

  const summaries = data?.summaries ?? [];
  if (summaries.length === 0) return null;

  const shown = (figure: ModuleSummary["figures"][number]) => {
    if (figure.kind === "money" && typeof figure.value === "number") {
      return formatMoney(figure.value);
    }
    return String(figure.value);
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {summaries.map((summary) => (
        <Card key={summary.id}>
          <div className="mb-2 flex items-baseline gap-2">
            <p className="font-medium">{summary.label}</p>
            {/* Straight into the module, because a figure somebody reads on
                the dashboard is a figure they want to go and act on. */}
            {summary.opens ? (
              <button
                type="button"
                className="ml-auto text-sm link-muted"
                onClick={() =>
                  open({
                    moduleId: summary.opens ?? summary.moduleId,
                    title: summary.label,
                  })
                }
              >
                Open
              </button>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {summary.figures.map((figure) => (
              <Stat
                key={figure.label}
                label={figure.label}
                value={shown(figure)}
                tone={figure.tone}
              />
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

/**
 * The reports, which used to be a screen of their own.
 *
 * They are not a separate thing — a dashboard is a collection of reports — and
 * a screen called Reports beside a screen full of figures was two places to
 * look for one answer. Every number is read from the ledger: if one looks
 * wrong the journal is wrong, and that is where to look.
 */
function BalanceSheetPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "balance-sheet"],
    queryFn: () => api<BalanceSheet>("/api/reports/balance-sheet"),
  });
  if (isLoading) return <ReportLoading id="balance-sheet" />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return (
    <Card>
      <p className="mb-2 font-medium">Balance sheet</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Assets" value={formatMoney(data.assetsCents)} />
        <Stat label="Liabilities" value={formatMoney(data.liabilitiesCents)} />
        <Stat label="Equity" value={formatMoney(data.equityCents)} />
        <Stat
          label="Retained"
          value={formatMoney(data.retainedEarningsCents)}
        />
      </div>
      {/* Shown rather than hidden: a balance sheet that does not balance is
          the single most important thing this panel can say. */}
      {data.balancedCents !== 0 ? (
        <p className="mt-2 text-sm" style={{ color: "var(--color-danger)" }}>
          Out by {formatMoney(data.balancedCents)} — the journal disagrees with
          itself.
        </p>
      ) : null}
    </Card>
  );
}

function CashFlowPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "cash-flow"],
    queryFn: () => api<CashFlow>("/api/reports/cash-flow"),
  });
  if (isLoading) return <ReportLoading id="cash-flow" />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  return (
    <Card>
      <p className="mb-2 font-medium">Cash in and out</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="In" value={formatMoney(data.inCents)} />
        <Stat label="Out" value={formatMoney(data.outCents)} />
        <Stat
          label="Net"
          value={formatMoney(data.netCents)}
          tone={data.netCents < 0 ? "bad" : "good"}
        />
      </div>
    </Card>
  );
}

function TrialBalancePanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "trial-balance"],
    queryFn: () =>
      api<{ rows: TrialBalanceRow[] } | TrialBalanceRow[]>(
        "/api/reports/trial-balance",
      ),
  });
  if (isLoading) return <ReportLoading id="trial-balance" />;
  if (error) return <ErrorNote error={error} />;

  const rows = Array.isArray(data) ? data : (data?.rows ?? []);
  if (rows.length === 0) {
    return (
      <Card>
        <p className="mb-2 font-medium">Trial balance</p>
        <p className="text-sm" style={muted}>
          Nothing posted yet.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p className="mb-2 font-medium">Trial balance</p>
      <ul className="space-y-1 text-sm">
        {rows.map((row) => (
          <li key={row.code} className="flex gap-2">
            <span style={muted}>{row.code}</span>
            <span className="truncate">{row.name}</span>
            <span className="ml-auto money">{formatMoney(row.netCents)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * Who owes you, by name.
 *
 * The buckets panel says how much is late; this says who to ring. Both, because
 * "£4,200 over sixty days" and "the Hendersons, ninety-one days" are answers to
 * different questions and a business asks the second one on a Friday.
 */
function WhoOwesPanel() {
  const { open } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["reports", "accounts-receivable"],
    queryFn: () => api<AgedReceivables>("/api/reports/accounts-receivable"),
  });
  if (isLoading) return <ReportLoading id="who-owes" />;
  if (error) return <ErrorNote error={error} />;

  const owed = data?.invoices ?? [];
  if (owed.length === 0) {
    return (
      <Card>
        <p className="mb-2 font-medium">Who owes you</p>
        <p className="text-sm" style={muted}>
          Nothing outstanding. Everything issued has been paid.
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <p className="mb-2 font-medium">
        Who owes you — {formatMoney(data?.totalCents ?? 0)} outstanding
      </p>
      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Stat
          label="Not yet due"
          value={formatMoney(data?.aging.current ?? 0)}
        />
        <Stat
          label="1–30 days late"
          value={formatMoney(data?.aging.days30 ?? 0)}
        />
        <Stat
          label="31–60 days late"
          value={formatMoney(data?.aging.days60 ?? 0)}
        />
        <Stat
          label="Over 60 days late"
          value={formatMoney(data?.aging.days90plus ?? 0)}
          tone={(data?.aging.days90plus ?? 0) > 0 ? "bad" : "plain"}
        />
      </div>
      <ul className="space-y-1 text-sm">
        {owed.slice(0, 12).map((invoice) => (
          <li key={invoice.invoiceId} className="flex flex-wrap gap-2">
            <button
              type="button"
              className="link"
              onClick={() =>
                open({
                  moduleId: "invoicing",
                  recordId: invoice.invoiceId,
                  title: invoice.number,
                })
              }
            >
              {invoice.number}
            </button>
            <span className="truncate">{invoice.customerName ?? "—"}</span>
            <span style={muted}>{invoice.ageDays} days</span>
            <span className="ml-auto money">
              {formatMoney(invoice.balanceDue)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ReportLoading({ id }: { id: string }) {
  return (
    <Card>
      <p className="mb-2 font-medium">{WIDGET_LABELS[id] ?? id}</p>
      <Loading />
    </Card>
  );
}

/** The panels that need the twelve-month query, which loads after the rest. */
function InsightWidget({
  id,
  insights,
}: {
  id: string;
  insights: Insights | undefined;
}) {
  if (!insights) {
    return (
      <Card>
        <p className="mb-2 font-medium">{WIDGET_LABELS[id] ?? id}</p>
        <Loading />
      </Card>
    );
  }

  const monthLabel = (month: string) => month.slice(2).replace("-", "/");

  if (id === "revenue-trend") {
    const points: Point[] = insights.months.map((m) => ({
      label: monthLabel(m.month),
      value: m.incomeCents,
      display: formatMoney(m.incomeCents),
    }));
    return (
      <Card>
        <p className="mb-2 font-medium">Income by month</p>
        <Bars points={points} />
      </Card>
    );
  }

  if (id === "cash-position") {
    const points: Point[] = insights.months.map((m) => ({
      label: monthLabel(m.month),
      value: m.netCents,
      display: formatMoney(m.netCents),
    }));
    return (
      <Card>
        <p className="mb-2 font-medium">Profit by month</p>
        <Line points={points} />
      </Card>
    );
  }

  if (id === "deals-by-stage") {
    return (
      <Card>
        <p className="mb-2 font-medium">Deals by stage</p>
        {insights.dealsByStage.length === 0 ? (
          <p className="text-sm" style={muted}>
            No open deals.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {insights.dealsByStage.map((s) => (
              <li key={s.stage} className="flex justify-between">
                <span className="capitalize">
                  {s.stage} · {s.count}
                </span>
                <span className="money">{formatMoney(s.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  if (id === "top-customers") {
    return (
      <Card>
        <p className="mb-2 font-medium">Top customers</p>
        {insights.topCustomers.length === 0 ? (
          <p className="text-sm" style={muted}>
            No invoices sent yet.
          </p>
        ) : (
          <ul className="space-y-1 text-sm">
            {insights.topCustomers.map((c) => (
              <li key={c.name} className="flex justify-between">
                <span>{c.name}</span>
                <span className="money">{formatMoney(c.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    );
  }

  if (id === "invoice-aging") {
    return (
      <Card>
        <p className="mb-2 font-medium">How late the money is</p>
        <div className="grid gap-3 sm:grid-cols-5 text-sm">
          {insights.aging.map((a) => (
            <Stat
              key={a.bucket}
              label={a.bucket}
              value={formatMoney(a.cents)}
              hint={`${a.count} invoice${a.count === 1 ? "" : "s"}`}
            />
          ))}
        </div>
      </Card>
    );
  }

  // A layout saved by a newer version can name a panel this build cannot draw.
  // Skipping it quietly is better than an error where a chart should be.
  return null;
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  /** `bad` is for a number somebody is meant to do something about. */
  tone?: "plain" | "good" | "bad";
}) {
  return (
    <div>
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className="money"
        style={
          tone === "bad"
            ? { color: "var(--color-danger)" }
            : tone === "good"
              ? { color: "var(--color-success)" }
              : undefined
        }
      >
        {value}
      </p>
      {hint ? (
        <p className="text-xs" style={muted}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Arranging the tabs.
 *
 * Checkboxes and a text box, not a drag-and-drop canvas. What is being decided
 * is which of nine panels appear on which of up to six tabs — a list handles
 * that, and a canvas would be more to build, more to break, and no easier.
 */
function Arrange({
  tabs,
  widgets,
  onSaved,
}: {
  tabs: Tab[];
  widgets: string[];
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Tab[]>(tabs);

  const save = useMutation({
    mutationFn: () =>
      api<{ tabs: Tab[] }>("/api/dashboard/layout", {
        method: "PUT",
        body: JSON.stringify({ tabs: draft }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["dashboard", "layout"] });
      onSaved();
    },
  });

  const toggle = (index: number, widget: string) =>
    setDraft((d) =>
      d.map((tab, i) =>
        i !== index
          ? tab
          : {
              ...tab,
              widgets: tab.widgets.includes(widget)
                ? tab.widgets.filter((w) => w !== widget)
                : [...tab.widgets, widget],
            },
      ),
    );

  return (
    <Card>
      <p className="mb-2 font-medium">Arrange your dashboard</p>
      <div className="space-y-4">
        {draft.map((tab, i) => (
          <div
            key={`tab-${i}-${tab.name}`}
            className="border-t pt-3"
            style={{ borderColor: "var(--border)" }}
          >
            <div className="flex items-center gap-2">
              <Input
                value={tab.name}
                onChange={(e) =>
                  setDraft((d) =>
                    d.map((t, j) =>
                      i === j ? { ...t, name: e.target.value } : t,
                    ),
                  )
                }
              />
              <button
                type="button"
                className="text-xs"
                style={{ color: "var(--color-danger)" }}
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
              >
                Remove tab
              </button>
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {widgets.map((widget) => (
                <label key={widget} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={tab.widgets.includes(widget)}
                    onChange={() => toggle(i, widget)}
                  />
                  {WIDGET_LABELS[widget] ?? widget}
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {/* Six is the server's limit too. Stopping here as well means somebody
            is told why rather than losing the seventh tab on save. */}
        <Button
          variant="secondary"
          disabled={draft.length >= 6}
          onClick={() =>
            setDraft((d) => [
              ...d,
              { name: `Tab ${d.length + 1}`, widgets: [] },
            ])
          }
        >
          {draft.length >= 6 ? "Six tabs is the limit" : "Add a tab"}
        </Button>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save layout"}
        </Button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

function MoneyPanel({ data }: { data: Dashboard }) {
  const { money, pipeline, book } = data;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <Figure
        label="Owed to you"
        value={formatMoney(money.owedCents)}
        hint={`${money.unpaidCount} unpaid invoice${money.unpaidCount === 1 ? "" : "s"}`}
      />
      <Figure
        label="Overdue"
        value={formatMoney(money.overdueCents)}
        hint={`${money.overdueCount} past its date`}
        // The only figure here worth colouring: it is money already earned
        // and not received, and it is the one somebody should act on today.
        alarming={money.overdueCents > 0}
      />
      <Figure
        label="In the pipeline"
        value={formatMoney(pipeline.openCents)}
        hint={`${pipeline.openCount} open deal${pipeline.openCount === 1 ? "" : "s"}`}
      />
      <Figure
        label="People in the book"
        value={String(book.contacts)}
        hint={`${pipeline.wonCount} deal${pipeline.wonCount === 1 ? "" : "s"} won`}
      />
    </div>
  );
}

function AttentionPanel({ data }: { data: Dashboard }) {
  const { go } = useNavigation();
  const { attention } = data;

  return (
    <Card>
      <p className="mb-2 font-medium">Needs attention</p>
      {attention.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing overdue and no quotes waiting. Everything is where it should
          be.
        </p>
      ) : (
        <ul className="space-y-2">
          {attention.map((item) => {
            const to = WHERE[item.kind];
            return (
              <li
                key={`${item.kind}-${item.id}`}
                className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-2 text-sm"
                style={{ borderColor: "var(--border)" }}
              >
                <div>
                  {/* Goes to the screen that can do something about it —
                      a list of problems with no way through to them is a
                      worse version of not showing them. */}
                  <button
                    type="button"
                    className="link"
                    onClick={() => to && go(to.moduleId, to.title)}
                  >
                    {item.summary}
                  </button>
                  {item.detail ? (
                    <div className="text-xs" style={muted}>
                      {item.detail}
                    </div>
                  ) : null}
                </div>
                {item.amountCents === undefined ? null : (
                  <span className="money">{formatMoney(item.amountCents)}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Bytes, in a unit somebody can act on. */
function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.round(bytes / 1e3)} KB`;
}

/** Uptime as a person would say it, not as seconds. */
function since(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86_400)} days`;
}

/**
 * How the server itself is doing.
 *
 * A self-hosted business owns the machine and nobody is watching it for them.
 * The first they usually hear of a full disk is a failed backup, so the number
 * that predicts it goes where they look every morning.
 */
export function HealthPanel({ health }: { health: Health }) {
  const { open } = useNavigation();
  const disk = health.disk;
  // Named rather than a bar: 91% reads as a number, "running out of space"
  // reads as something to do today.
  const tight = disk ? disk.usedPercent >= 85 : false;

  /**
   * Whether there is a newer release, on the screen somebody opens anyway.
   *
   * Read from Settings' own endpoint rather than worked out again here — that
   * one already knows the difference between "there is nothing newer" and "we
   * have not looked", and a second implementation would be a second answer.
   *
   * Behind `settings:read`, which not everybody has. A 403 shows nothing
   * rather than an error: somebody who cannot update the instance does not
   * need to be told there is an update.
   */
  const updates = useQuery({
    queryKey: ["updates"],
    queryFn: () =>
      api<{ current: string; latest: string | null; updateAvailable: boolean }>(
        "/api/settings/updates",
      ),
    retry: false,
  });

  /*
   * Three states, not two. A Free instance never phones home unless somebody
   * asks it to, so `latest` is null until they do — and "up to date" is a
   * claim we have not earned. It is the exact thing that went wrong once
   * already: an instance sat a release behind being told it was current.
   */
  const release = updates.data;
  const updateState = !release
    ? null
    : release.updateAvailable
      ? { text: `${release.latest} is out`, colour: "var(--color-warning)" }
      : release.latest
        ? { text: "up to date", colour: undefined }
        : { text: "not checked", colour: undefined };

  return (
    <Card>
      <p className="mb-2 font-medium">This server</p>
      <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <p className="text-xs" style={muted}>
            Version
          </p>
          <p>{health.version}</p>
          {updateState ? (
            <button
              type="button"
              className="text-xs link-muted"
              style={updateState.colour ? { color: updateState.colour } : muted}
              onClick={() => open({ moduleId: "settings", title: "Settings" })}
            >
              {updateState.text}
            </button>
          ) : null}
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Running for
          </p>
          <p>{since(health.uptimeSeconds)}</p>
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Database
          </p>
          <p
            style={
              health.database.reachable
                ? undefined
                : { color: "var(--color-danger)" }
            }
          >
            {health.database.reachable
              ? health.database.sizeBytes
                ? size(health.database.sizeBytes)
                : "reachable"
              : "not reachable"}
          </p>
        </div>
        <div>
          <p className="text-xs" style={muted}>
            Disk
          </p>
          {disk ? (
            <p style={tight ? { color: "var(--color-warning)" } : undefined}>
              {size(disk.freeBytes)} free
              {tight ? " — running low" : ""}
            </p>
          ) : (
            <p style={muted}>not measurable here</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** The leaderboard, agreed with the control plane that fills it. */
const AD_WIDTH = 728;
const AD_HEIGHT = 90;

/**
 * What to do first, on a dashboard with nothing on it yet.
 *
 * The morning somebody installs this they get a screen of zeros. Every panel
 * is honest — there is nothing owed, nothing overdue, nobody in the book —
 * and none of it tells them where to start. For a while the only thing on the
 * page asking for anything was an advertisement, which is the wrong first
 * impression of something just installed.
 *
 * It is not a checklist and does not track progress: a list of ticks somebody
 * has to clear is another thing to do rather than the answer to what to do.
 * One link to the introduction, and it disappears when the dashboard has
 * something real on it.
 */
function StartHere({ startHere }: { startHere: Dashboard["startHere"] }) {
  if (!startHere) return null;

  return (
    <div
      className="rounded border p-4"
      style={{
        background: "var(--surface-raised)",
        borderColor: "var(--border)",
      }}
    >
      <p className="font-medium">Start here</p>
      <p className="mt-1 text-sm" style={muted}>
        Nothing has been added yet, so there is nothing to show. The
        introduction walks through adding the first customer, sending the first
        invoice, and what each part of this is for.
      </p>
      <a
        className="mt-3 inline-block rounded px-3 py-1.5 font-medium text-sm"
        href={startHere.url}
        target="_blank"
        rel="noreferrer"
        style={{
          background: "var(--brand-on-white-text)",
          color: "var(--color-neutral-50)",
        }}
      >
        Read the introduction
      </a>
    </div>
  );
}

/**
 * The one advertisement, centred at the top of a Free dashboard.
 *
 * A 728x90 leaderboard, and always that height whether it holds a banner or
 * written copy, so the page does not move under somebody depending on what was
 * saved in Master.
 *
 * Narrower than 728 and the box narrows with the window rather than scaling.
 * Scaling was the first attempt and it was wrong: flexbox lays the full 728 out
 * before a transform is applied, so the slot overflowed its container and was
 * clipped unevenly on both sides. A banner letterboxes inside the smaller box
 * via object-contain; the text simply has less room. Neither makes the
 * dashboard scroll sideways, which is the thing to avoid.
 *
 * The content is a document fetched by the server, so everything here is
 * escaped by React and every link is one the server already checked was https.
 * Nothing in this box is markup somebody else wrote.
 */
function AdSlot({ ad }: { ad: Dashboard["ad"] }) {
  if (!ad) return null;

  return (
    <div className="flex justify-center">
      <a
        href={ad.url}
        target="_blank"
        rel="noreferrer sponsored"
        aria-label={ad.kind === "image" ? ad.alt : ad.headline}
        className="block rounded border"
        style={{
          width: AD_WIDTH,
          maxWidth: "100%",
          height: AD_HEIGHT,
          background: "var(--surface-raised)",
          borderColor: "var(--border)",
        }}
      >
        {ad.kind === "image" ? (
          <img
            src={ad.imageUrl}
            alt={ad.alt}
            width={AD_WIDTH}
            height={AD_HEIGHT}
            className="h-full w-full rounded object-contain"
          />
        ) : (
          <span className="flex h-full items-center justify-between gap-4 px-4">
            <span className="min-w-0">
              <span className="block truncate font-medium">{ad.headline}</span>
              {ad.body ? (
                <span className="block truncate text-sm" style={muted}>
                  {ad.body}
                </span>
              ) : null}
            </span>
            <span
              className="shrink-0 rounded px-3 py-1.5 text-sm font-medium"
              style={{
                background: "var(--brand-on-white-text)",
                color: "var(--color-neutral-50)",
              }}
            >
              {ad.cta}
            </span>
          </span>
        )}
      </a>
    </div>
  );
}
