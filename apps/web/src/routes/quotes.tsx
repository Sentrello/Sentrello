import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, api } from "../lib/api";
import { Icon } from "../lib/icons";
import {
  Pagination,
  SortMenu,
  listQueryString,
  useListState,
} from "../lib/list-ui";
import { useNavigation } from "../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Table,
  border,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";
import { InvoiceForm } from "./invoice-form";

/**
 * What has been offered, and what came of it.
 *
 * The same screen as invoices, organised the same way, because a quote is the
 * same document before it is owed. The tabs differ only in what the statuses
 * mean: a quote is accepted or declined rather than paid, and it can expire —
 * which is not a stored status but a fact about today, so the server works it
 * out rather than a job writing it every night.
 */

interface QuoteRow {
  id: string;
  number: string;
  contactId: string | null;
  status: string;
  currency: string;
  issueDate: string;
  validUntil: string | null;
  totalCents: number;
  expired: boolean;
  published: boolean;
  firstViewedAt: string | null;
  viewCount: number;
  convertedInvoiceId: string | null;
  deletedAt: string | null;
}

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "sent", label: "Sent" },
  { id: "accepted", label: "Accepted" },
  { id: "declined", label: "Declined" },
  { id: "expired", label: "Expired" },
  { id: "deleted", label: "Deleted" },
];

function statusOf(quote: QuoteRow): { label: string; tone: string } {
  if (quote.deletedAt) return { label: "Deleted", tone: "var(--text-muted)" };
  if (quote.convertedInvoiceId) {
    return { label: "Invoiced", tone: "var(--color-success)" };
  }
  switch (quote.status) {
    case "accepted":
      return { label: "Accepted", tone: "var(--color-success)" };
    case "declined":
      return { label: "Declined", tone: "var(--color-danger)" };
    case "draft":
      return { label: "Draft", tone: "var(--text-muted)" };
    default:
      // Expired is about today, not about the column.
      return quote.expired
        ? { label: "Expired", tone: "var(--color-warning)" }
        : { label: "Sent", tone: "var(--color-info)" };
  }
}

export function Quotes() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [tab, setTab] = useState("all");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  /** The quote whose instalment schedule is being written, if any. */
  const [splitting, setSplitting] = useState<QuoteRow | null>(null);

  const state = useListState({ sort: "issueDate", order: "desc" });
  const query = `${listQueryString(state, true)}&tab=${tab}`;

  const { data, isLoading, error } = useQuery({
    queryKey: ["quotes", query],
    queryFn: () =>
      api<{ quotes: QuoteRow[]; total: number }>(`/api/quotes?${query}`),
    placeholderData: (previous) => previous,
  });

  const counts = useQuery({
    queryKey: ["quote-counts"],
    queryFn: () =>
      api<{ counts: Record<string, number> }>("/api/quotes/counts"),
  });

  const contacts = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });
  const customer = (id: string | null) =>
    id ? contacts.data?.contacts.find((c) => c.id === id)?.name : undefined;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["quotes"] });
    qc.invalidateQueries({ queryKey: ["quote-counts"] });
  };

  if (error) return <ErrorNote error={error} />;

  const rows = data?.quotes ?? [];

  if (adding || editing) {
    return (
      <InvoiceForm
        asQuote
        documentId={editing ?? undefined}
        onDone={() => {
          setAdding(false);
          setEditing(null);
          refresh();
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div
        className="flex flex-wrap items-center gap-1 border-b pb-2"
        style={border}
      >
        {TABS.map((t) => {
          const n = counts.data?.counts[t.id];
          const here = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              className="rounded-md px-3 py-1.5 text-sm"
              style={
                here
                  ? {
                      background: "var(--color-brand-500)",
                      color: "var(--color-neutral-50)",
                    }
                  : undefined
              }
              onClick={() => {
                setTab(t.id);
                state.setPage(1);
              }}
            >
              {t.label}
              {n ? (
                <span
                  className="ml-1.5 text-xs tabular-nums"
                  style={here ? undefined : muted}
                >
                  {n}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative">
          <span
            className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-2"
            style={muted}
          >
            <Icon name="search" size={15} />
          </span>
          <input
            value={state.q}
            onChange={(e) => state.setQ(e.target.value)}
            placeholder="Search by number or note"
            aria-label="Search quotes"
            className="w-64 rounded-md border py-1.5 pr-2 pl-7 text-sm"
            style={{ ...border, background: "var(--surface-raised)" }}
          />
        </div>

        <SortMenu
          state={state}
          fields={[
            { field: "issueDate", label: "Date", order: "desc" },
            { field: "validUntil", label: "Valid until", order: "asc" },
            { field: "number", label: "Number", order: "desc" },
            { field: "totalCents", label: "Amount", order: "desc" },
            { field: "status", label: "Status", order: "asc" },
          ]}
        />

        <div className="ml-auto">
          {/* The same query the table is showing, so what is exported is
              what is on screen. */}
          <a
            href={`/api/quotes/export.csv?${query}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
            style={border}
          >
            <Icon name="file-text" size={15} />
            Export
          </a>
          <Button onClick={() => setAdding(true)}>
            <span className="flex items-center gap-1.5">
              <Icon name="plus" size={15} />
              New quote
            </span>
          </Button>
        </div>
      </div>

      {/* Above the table rather than in the row's menu: a schedule with four
          stages in it needs room to be read before it is agreed to. */}
      {splitting ? (
        <InstalmentPlanner
          quote={splitting}
          onDone={() => setSplitting(null)}
          onSplit={(first) => {
            setSplitting(null);
            refresh();
            open({
              moduleId: "invoicing",
              recordId: first.id,
              title: first.number,
            });
          }}
        />
      ) : null}

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title={state.q ? "No matches" : "Nothing here"}>
          {state.q
            ? "Try a different search."
            : "A quote is what you offered. Accepting one turns it into an invoice."}
        </Empty>
      ) : (
        <>
          <Card className="p-0">
            <Table
              headers={[
                "Number",
                "Customer",
                "Date",
                "Valid until",
                { label: "Total", money: true },
                "Status",
                "",
              ]}
            >
              {rows.map((quote) => {
                const shown = statusOf(quote);
                return (
                  <Row key={quote.id}>
                    <td className="whitespace-nowrap py-2 font-medium">
                      {/* Was a `span` styled as a link, doing nothing — the
                          one affordance on this screen that looked like it
                          opened the quote and did not. */}
                      <button
                        type="button"
                        className="link"
                        onClick={() => setEditing(quote.id)}
                      >
                        {quote.number}
                      </button>
                      {quote.firstViewedAt ? (
                        <span
                          className="ml-1.5"
                          style={muted}
                          title={`Opened ${formatDate(quote.firstViewedAt)}`}
                        >
                          <Icon name="check-square" size={13} />
                        </span>
                      ) : null}
                    </td>
                    <td className="max-w-44 truncate">
                      {customer(quote.contactId) ?? "—"}
                    </td>
                    <td className="whitespace-nowrap" style={muted}>
                      {formatDate(quote.issueDate)}
                    </td>
                    <td className="whitespace-nowrap" style={muted}>
                      {quote.validUntil ? formatDate(quote.validUntil) : "—"}
                    </td>
                    <td className="money">{formatMoney(quote.totalCents)}</td>
                    <td className="whitespace-nowrap">
                      <span className="text-sm" style={{ color: shown.tone }}>
                        {shown.label}
                      </span>
                    </td>
                    <td className="text-right">
                      <QuoteActions
                        quote={quote}
                        onEdit={() => setEditing(quote.id)}
                        onSplit={() => setSplitting(quote)}
                        onConverted={(invoiceId, number) => {
                          refresh();
                          open({
                            moduleId: "invoicing",
                            recordId: invoiceId,
                            title: number,
                          });
                        }}
                        onDone={refresh}
                      />
                    </td>
                  </Row>
                );
              })}
            </Table>
          </Card>

          {(data?.total ?? 0) > state.perPage ? (
            <Pagination state={state} total={data?.total ?? 0} />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * Turning one quote into a deposit and stages.
 *
 * The arrangement is ordinary — half now, half on completion; a deposit and
 * two stages — and without this a business raises the deposit by hand and
 * remembers the rest, which is how a stage goes unbilled.
 *
 * Shares are held as percentages even when somebody types an amount, because
 * three amounts that each round to the nearest penny do not add back up to
 * the quote and a schedule that is a penny short is a schedule somebody has
 * to explain. The amount box converts to a percentage as it is typed; the
 * server splits the taxable base, so the invoices sum to the quote exactly.
 */
function InstalmentPlanner({
  quote,
  onDone,
  onSplit,
}: {
  quote: QuoteRow;
  onDone: () => void;
  onSplit: (first: { id: string; number: string }) => void;
}) {
  const [parts, setParts] = useState([
    { key: crypto.randomUUID(), percent: "50", days: "0", label: "" },
    { key: crypto.randomUUID(), percent: "50", days: "30", label: "" },
  ]);

  const bpOf = (percent: string) =>
    Math.round((Number.parseFloat(percent || "0") || 0) * 100);
  const totalBp = parts.reduce((sum, part) => sum + bpOf(part.percent), 0);
  const balanced = totalBp === 10_000;

  const set = (index: number, patch: Partial<(typeof parts)[number]>) =>
    setParts((current) =>
      current.map((part, i) => (i === index ? { ...part, ...patch } : part)),
    );

  const split = useMutation({
    mutationFn: () =>
      api<{ invoices: { id: string; number: string }[] }>(
        `/api/quotes/${quote.id}/convert`,
        {
          method: "POST",
          body: JSON.stringify({
            instalments: parts.map((part) => ({
              shareBp: bpOf(part.percent),
              dueInDays: Number.parseInt(part.days, 10) || 0,
              label: part.label.trim() || undefined,
            })),
          }),
        },
      ),
    onSuccess: (made) => {
      const first = made.invoices[0];
      if (first) onSplit(first);
    },
  });

  return (
    <Card>
      <div className="mb-3 flex items-center gap-2">
        <p className="font-medium text-sm">
          Split {quote.number} into instalments
        </p>
        <button
          type="button"
          className="ml-auto text-sm link-muted"
          onClick={onDone}
        >
          Cancel
        </button>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            setParts([
              { key: crypto.randomUUID(), percent: "50", days: "0", label: "" },
              {
                key: crypto.randomUUID(),
                percent: "50",
                days: "30",
                label: "",
              },
            ])
          }
        >
          Deposit of half
        </Button>
        {/* 33.33, 33.33, 33.34 — the last one takes the odd penny, which is
            what the server does with it too. */}
        <Button
          variant="secondary"
          onClick={() =>
            setParts([
              {
                key: crypto.randomUUID(),
                percent: "33.33",
                days: "0",
                label: "",
              },
              {
                key: crypto.randomUUID(),
                percent: "33.33",
                days: "30",
                label: "",
              },
              {
                key: crypto.randomUUID(),
                percent: "33.34",
                days: "60",
                label: "",
              },
            ])
          }
        >
          Three equal parts
        </Button>
      </div>

      <div className="space-y-2">
        {parts.map((part, i) => (
          <div
            key={part.key}
            className="grid items-end gap-2 sm:grid-cols-[6rem_8rem_7rem_1fr_auto]"
          >
            <Field label={i === 0 ? "Share" : ""}>
              <Input
                value={part.percent}
                inputMode="decimal"
                aria-label={`Instalment ${i + 1} percentage`}
                onChange={(e) => set(i, { percent: e.target.value })}
              />
            </Field>
            <Field label={i === 0 ? "Or an amount" : ""}>
              <Input
                placeholder={formatMoney(
                  Math.round((quote.totalCents * bpOf(part.percent)) / 10_000),
                )}
                inputMode="decimal"
                aria-label={`Instalment ${i + 1} amount`}
                onChange={(e) => {
                  const cents = Math.round(
                    (Number.parseFloat(e.target.value || "0") || 0) * 100,
                  );
                  if (quote.totalCents > 0) {
                    set(i, {
                      percent: ((cents / quote.totalCents) * 100).toFixed(2),
                    });
                  }
                }}
              />
            </Field>
            <Field label={i === 0 ? "Due in days" : ""}>
              <Input
                value={part.days}
                inputMode="numeric"
                aria-label={`Instalment ${i + 1} due in days`}
                onChange={(e) => set(i, { days: e.target.value })}
              />
            </Field>
            <Field label={i === 0 ? "Called" : ""}>
              <Input
                value={part.label}
                placeholder={
                  i === 0
                    ? "Deposit"
                    : i === parts.length - 1
                      ? "Final"
                      : `Stage ${i + 1}`
                }
                aria-label={`Instalment ${i + 1} label`}
                onChange={(e) => set(i, { label: e.target.value })}
              />
            </Field>
            <button
              type="button"
              className="pb-2 text-sm link-muted"
              disabled={parts.length <= 2}
              onClick={() =>
                setParts((current) => current.filter((_, at) => at !== i))
              }
            >
              Remove
            </button>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          onClick={() =>
            setParts((current) => [
              ...current,
              { key: crypto.randomUUID(), percent: "0", days: "60", label: "" },
            ])
          }
        >
          Add one
        </Button>
        <span className="text-sm" style={muted}>
          {(totalBp / 100).toFixed(2)}% of {formatMoney(quote.totalCents)}
          {balanced ? "" : " — has to come to 100%"}
        </span>
        <Button
          className="ml-auto"
          onClick={() => split.mutate()}
          disabled={!balanced || split.isPending}
        >
          Create {parts.length} draft invoices
        </Button>
      </div>
      {split.error ? <ErrorNote error={split.error} /> : null}
    </Card>
  );
}

/**
 * What can be done with a quote.
 *
 * Converting is the one that matters, and it is offered once and only once: a
 * quote that has already become an invoice shows what it became rather than a
 * button that would raise a second bill for the same work.
 */
function QuoteActions({
  quote,
  onConverted,
  onEdit,
  onSplit,
  onDone,
}: {
  quote: QuoteRow;
  onConverted: (invoiceId: string, number: string) => void;
  onEdit: () => void;
  /** Opens the planner above the table, where there is room to read it. */
  onSplit: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const send = useMutation({
    mutationFn: () => api(`/api/quotes/${quote.id}/send`, { method: "POST" }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  const convert = useMutation({
    mutationFn: () =>
      api<{ invoice: { id: string; number: string } }>(
        `/api/quotes/${quote.id}/convert`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      setOpen(false);
      onConverted(result.invoice.id, result.invoice.number);
    },
  });

  const share = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/quotes/${quote.id}/share`, { method: "POST" }),
    onSuccess: (result) => {
      navigator.clipboard?.writeText(result.url);
      setCopied(true);
      onDone();
    },
  });

  /** Out of the bin. Deleting is soft, so there is something to come back. */
  const restore = useMutation({
    mutationFn: () =>
      api(`/api/quotes/${quote.id}/restore`, { method: "POST" }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  const remove = useMutation({
    mutationFn: () => api(`/api/quotes/${quote.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  const converted = Boolean(quote.convertedInvoiceId);

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="link-muted px-1"
        aria-label={`More for ${quote.number}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open ? (
        <span className="menu-panel z-10" onMouseLeave={() => setOpen(false)}>
          {/* Editable until it has become an invoice — the server refuses
              after that, because the invoice's lines came from these and it is
              the one that posted to the ledger. A sent quote is still
              editable: revising and re-sending is what negotiation is. */}
          {!quote.convertedInvoiceId ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
            >
              Edit
            </button>
          ) : null}

          {quote.status === "draft" ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => send.mutate()}
              disabled={send.isPending}
            >
              Send it
            </button>
          ) : null}

          <button
            type="button"
            className="menu-item"
            onClick={() => share.mutate()}
            disabled={share.isPending}
          >
            {copied ? "Link copied" : "Copy a link to send"}
          </button>

          {/* Once, and only once. A second conversion is a second bill for
              the same work. */}
          {converted ? (
            <span className="menu-item" style={muted}>
              Already invoiced
            </span>
          ) : (
            <>
              <button
                type="button"
                className="menu-item"
                onClick={() => convert.mutate()}
                disabled={convert.isPending}
              >
                Turn into an invoice
              </button>
              {/* Or into the schedule that was agreed with it. */}
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setOpen(false);
                  onSplit();
                }}
              >
                Split into instalments
              </button>
            </>
          )}

          {quote.deletedAt ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => restore.mutate()}
              disabled={restore.isPending}
            >
              Restore
            </button>
          ) : (
            <button
              type="button"
              className="menu-item"
              style={{ color: "var(--color-danger)" }}
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              Delete
            </button>
          )}
        </span>
      ) : null}
      {convert.error ? <ErrorNote error={convert.error} /> : null}
      {send.error ? <ErrorNote error={send.error} /> : null}
    </span>
  );
}
