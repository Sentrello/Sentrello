import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Bars, type Point } from "../lib/charts";
import { useNavigation } from "../lib/navigation";
import {
  Card,
  ErrorNote,
  Loading,
  StatFigure,
  briefMoney,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * Invoicing's own front page.
 *
 * The four figures the platform dashboard shows, and then the two lists
 * somebody actually acts on: who is late, and what is sitting in drafts. The
 * second is the one nothing else surfaces — an invoice written and never
 * issued is work already done that nobody has been asked to pay for.
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

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const openInvoice = (id: string, number: string) =>
    open({ moduleId: "invoicing", recordId: id, title: number });

  const points: Point[] = data.months.map((m) => ({
    label: m.month.slice(2).replace("-", "/"),
    value: m.billedCents,
    display: formatMoney(m.billedCents),
  }));

  return (
    <div className="flex flex-col gap-(--gap-stack)">
      {distance.data?.applies && distance.data.warning && (
        <Card>
          <p className="text-sm" style={{ color: "var(--text-danger)" }}>
            {distance.data.warning}
          </p>
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
                figure.kind === "money" && typeof figure.value === "number"
                  ? formatMoney(figure.value)
                  : String(figure.value)
              }
              tone={figure.tone}
            />
          </Card>
        ))}
      </div>

      {points.length > 0 ? (
        <Card>
          <p className="mb-2 font-medium">Billed by month</p>
          <Bars points={points} format={briefMoney} />
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <Card>
          <p className="mb-2 font-medium">Past its date</p>
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
          <p className="mb-2 font-medium">Written but not sent</p>
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
