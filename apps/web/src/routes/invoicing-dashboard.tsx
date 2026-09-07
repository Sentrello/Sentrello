import { useQuery } from "@tanstack/react-query";
import { type Contact, api } from "../lib/api";
import { Bars, type Point } from "../lib/charts";
import { useNavigation } from "../lib/navigation";
import {
  Card,
  ErrorNote,
  Loading,
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
    totalCents: number;
    dueDate: string | null;
    daysLate: number;
  }[];
  drafts: {
    id: string;
    number: string;
    contactId: string | null;
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
  const contacts = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const customer = (id: string | null) =>
    id ? (contacts.data?.contacts.find((c) => c.id === id)?.name ?? "—") : "—";
  const openInvoice = (id: string, number: string) =>
    open({ moduleId: "invoicing", recordId: id, title: number });

  const points: Point[] = data.months.map((m) => ({
    label: m.month.slice(2).replace("-", "/"),
    value: m.billedCents,
    display: formatMoney(m.billedCents),
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {data.figures.map((figure) => (
          <Card key={figure.label}>
            <p className="text-xs" style={muted}>
              {figure.label}
            </p>
            <p
              className="money mt-1 font-semibold text-2xl"
              style={
                figure.tone === "bad"
                  ? { color: "var(--color-danger)" }
                  : figure.tone === "good"
                    ? { color: "var(--color-success)" }
                    : undefined
              }
            >
              {figure.kind === "money" && typeof figure.value === "number"
                ? formatMoney(figure.value)
                : String(figure.value)}
            </p>
          </Card>
        ))}
      </div>

      {points.length > 0 ? (
        <Card>
          <p className="mb-2 font-medium">Billed by month</p>
          <Bars points={points} />
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
            <ul className="space-y-1 text-sm">
              {data.late.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="link"
                    onClick={() => openInvoice(invoice.id, invoice.number)}
                  >
                    {invoice.number}
                  </button>
                  <span className="truncate">
                    {customer(invoice.contactId)}
                  </span>
                  <span style={{ color: "var(--color-danger)" }}>
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
            <ul className="space-y-1 text-sm">
              {data.drafts.map((invoice) => (
                <li key={invoice.id} className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="link"
                    onClick={() => openInvoice(invoice.id, invoice.number)}
                  >
                    {invoice.number}
                  </button>
                  <span className="truncate">
                    {customer(invoice.contactId)}
                  </span>
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
