import { useQuery } from "@tanstack/react-query";
import { api, may } from "../lib/api";
import { PairedBars, type PairedPoint } from "../lib/charts";
import { useNavigation } from "../lib/navigation";
import {
  Card,
  ErrorNote,
  Loading,
  SectionHeading,
  StatFigure,
  Warning,
  briefMoney,
  formatCount,
  formatDate,
  formatMoney,
  monthLabel,
  muted,
} from "../lib/ui";

/**
 * The front page of Money.
 *
 * Four figures from the sales side, what the business earned against what it
 * spent, and then the two lists somebody actually acts on: who is late, and
 * what is sitting in drafts. The second is the one nothing else surfaces —
 * an invoice written and never issued is work already done that nobody has
 * been asked to pay for.
 *
 * **It used to be the invoicing dashboard and nothing else**, which meant a
 * module called Money answered half of one question: a business that had
 * spent more than it billed could read its own front page and not know. The
 * earned-and-spent half comes from the journal, so the figure here and the
 * figure on the Summary screen are the same number, and it is only asked for
 * by somebody allowed to read the books — raising invoices without seeing
 * the books is an ordinary arrangement in a small business.
 *
 * Every row opens the document it names. A dashboard of numbers to admire is a
 * dashboard people look at once.
 */

interface InvoicingDashboard {
  figures: {
    label: string;
    value: number | string;
    kind?: "money" | "count" | "text";
    tone?: "plain" | "good" | "bad";
  }[];
  months: { month: string; billedCents: number }[];
  late: {
    id: string;
    number: string;
    contactId: string | null;
    /** Resolved on the server, not by fetching every contact. */
    contactName: string | null;
    totalCents: number;
    dueDate: string | null;
    daysLate: number;
  }[];
  drafts: {
    id: string;
    number: string;
    contactId: string | null;
    /** Resolved on the server, not by fetching every contact. */
    contactName: string | null;
    totalCents: number;
    issueDate: string;
  }[];
}

export function InvoicingDashboard() {
  const { open } = useNavigation();
  const { data, isLoading, error } = useQuery({
    queryKey: ["invoicing", "dashboard"],
    queryFn: () => api<InvoicingDashboard>("/api/invoicing/dashboard"),
  });
  /**
   * The EU distance-selling threshold, shown only when it bites.
   *
   * Most instances are not EU sellers, and an EU seller under the line needs
   * nothing from anybody — so the common case is no banner at all. Past
   * €10,000 of cross-border B2C the VAT genuinely moves to the customer's
   * country, and staying silent about that is how a small business finds out
   * from a tax authority instead.
   */
  const distance = useQuery({
    queryKey: ["invoicing", "distance-sales"],
    queryFn: () =>
      api<{
        applies: boolean;
        exceeded: boolean | null;
        advice: string | null;
        /**
         * Sold into a member state with no rate set — VAT owed and never
         * charged. Shown whatever side of the threshold the business is on,
         * because a digital supply to a consumer has no threshold under it.
         */
        warning: string | null;
      }>("/api/invoicing/distance-sales"),
  });
  /**
   * US economic nexus, on the same terms: silent for the café selling in
   * its own town, and a plain sentence per state for the business whose
   * out-of-state sales are approaching — or past — a threshold. Before is
   * the whole point; a warning after the line is crossed is a penalty
   * notice with better manners.
   */
  const nexus = useQuery({
    queryKey: ["invoicing", "us-nexus"],
    queryFn: () =>
      api<{
        states: { state: string; status: string; advice: string }[];
      }>("/api/invoicing/us-nexus"),
  });
  const nexusWarnings =
    nexus.data?.states.filter(
      (s) => s.status === "over" || s.status === "approaching",
    ) ?? [];

  /**
   * The other half of the answer: earned against spent, from the journal.
   *
   * Only asked for by somebody who can read the books. `may` answers from
   * the grant set `/api/_meta` sends, and an unknown permission is allowed —
   * hiding a figure from somebody entitled to it is the worse mistake, and
   * the route refuses what it must regardless.
   */
  const books = useQuery({
    enabled: may("bookkeeping", "read"),
    queryKey: ["money", "books"],
    queryFn: () =>
      api<{
        months: { month: string; incomeCents: number; expenseCents: number }[];
        month: {
          incomeCents: number;
          expenseCents: number;
          netCents: number;
        };
      }>("/api/money/books"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const openInvoice = (id: string, number: string) =>
    open({ moduleId: "invoicing", recordId: id, title: number });

  /*
   * One chart, two series, one scale.
   *
   * It was "Billed by month", a single bar per month — which says how much
   * work went out and nothing about whether the business kept any of it. Two
   * bars against each other answer both, and sharing a scale is the point:
   * two charts with their own axes make a bad month look like a good one.
   */
  const points: PairedPoint[] = (books.data?.months ?? []).map((m) => ({
    label: monthLabel(m.month),
    up: m.incomeCents,
    down: m.expenseCents,
    display: `${formatMoney(m.incomeCents)} in · ${formatMoney(m.expenseCents)} out`,
  }));
  const anyMovement = points.some((p) => p.up !== 0 || p.down !== 0);

  return (
    <div className="flex flex-col gap-(--gap-stack)">
      {distance.data?.applies && distance.data.warning && (
        <Card>
          <Warning>{distance.data.warning}</Warning>
        </Card>
      )}
      {distance.data?.applies &&
        distance.data.exceeded &&
        distance.data.advice && (
          <Card>
            <p className="text-sm">{distance.data.advice}</p>
          </Card>
        )}
      {nexusWarnings.length > 0 && (
        <Card>
          {nexusWarnings.map((s) => (
            <p key={s.state} className="text-sm">
              {s.advice}
            </p>
          ))}
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-4">
        {data.figures.map((figure) => (
          <Card key={figure.label}>
            <StatFigure
              label={figure.label}
              value={
                typeof figure.value !== "number"
                  ? String(figure.value)
                  : figure.kind === "money"
                    ? formatMoney(figure.value)
                    : // A count, grouped the way the money beside it is.
                      formatCount(figure.value)
              }
              tone={figure.tone}
            />
          </Card>
        ))}
      </div>

      {/*
        One card rather than three more, and the same three words the Summary
        screen uses in the same order.

        Seven figures across two rows is a wall of numbers; a business reads
        the sales side and the books as two questions, so they are drawn as
        two things. And a figure that disagrees with the report it came from
        is a figure somebody stops trusting — these are the journal's, which
        is what the Summary reads too.
      */}
      {books.data ? (
        <Card>
          <SectionHeading>This month</SectionHeading>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatFigure
              label="Income"
              value={formatMoney(books.data.month.incomeCents)}
            />
            <StatFigure
              label="Expenses"
              value={formatMoney(books.data.month.expenseCents)}
            />
            <StatFigure
              label="Net"
              value={formatMoney(books.data.month.netCents)}
              tone={
                books.data.month.netCents < 0
                  ? "bad"
                  : books.data.month.netCents > 0
                    ? "good"
                    : "plain"
              }
            />
          </div>
        </Card>
      ) : null}

      {anyMovement ? (
        <Card>
          <SectionHeading>Income and expenses</SectionHeading>
          <PairedBars
            points={points}
            upLabel="Income"
            downLabel="Expenses"
            format={briefMoney}
          />
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <SectionHeading>Past its date</SectionHeading>
          {data.late.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nothing is late. Everything issued is either paid or not yet due.
            </p>
          ) : (
            <ul className="flex flex-col gap-(--gap-tight) text-sm">
              {data.late.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="link"
                    onClick={() => openInvoice(invoice.id, invoice.number)}
                  >
                    {invoice.number}
                  </button>
                  <span className="truncate">{invoice.contactName ?? "—"}</span>
                  <span style={{ color: "var(--text-danger)" }}>
                    {invoice.daysLate} days
                  </span>
                  <span className="ml-auto money">
                    {formatMoney(invoice.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <SectionHeading>Written but not sent</SectionHeading>
          {data.drafts.length === 0 ? (
            <p className="text-sm" style={muted}>
              No drafts waiting. Everything written has gone out.
            </p>
          ) : (
            <ul className="flex flex-col gap-(--gap-tight) text-sm">
              {data.drafts.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="link"
                    onClick={() => openInvoice(invoice.id, invoice.number)}
                  >
                    {invoice.number}
                  </button>
                  <span className="truncate">{invoice.contactName ?? "—"}</span>
                  <span style={muted}>{formatDate(invoice.issueDate)}</span>
                  <span className="ml-auto money">
                    {formatMoney(invoice.totalCents)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
