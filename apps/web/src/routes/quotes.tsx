import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import {
  ColumnsMenu,
  Pagination,
  SortMenu,
  listQueryString,
  useColumns,
  useListState,
} from "../lib/list-ui";
import { useNavigation } from "../lib/navigation";
import { SavedViews } from "../lib/saved-views";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  MenuItem,
  Page,
  PageActions,
  Row,
  RowMenu,
  SectionHeading,
  Table,
  Tabs,
  Toolbar,
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
  /** Resolved on the server, per page, not by fetching every contact. */
  contactName: string | null;
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
    return { label: "Invoiced", tone: "var(--text-success)" };
  }
  switch (quote.status) {
    case "accepted":
      return { label: "Accepted", tone: "var(--text-success)" };
    case "declined":
      return { label: "Declined", tone: "var(--text-danger)" };
    case "draft":
      return { label: "Draft", tone: "var(--text-muted)" };
    default:
      // Expired is about today, not about the column.
      return quote.expired
        ? { label: "Expired", tone: "var(--text-warning)" }
        : { label: "Sent", tone: "var(--text-info)" };
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
  /**
   * Which columns are worth the width. The number, the total and the row's
   * own actions stay; the rest is somebody's own choice — see the invoice
   * list, which this deliberately matches.
   */
  const columns = useColumns("quotes", [
    { field: "number", label: "Number", fixed: true },
    { field: "customer", label: "Customer" },
    { field: "issueDate", label: "Date" },
    { field: "validUntil", label: "Valid until" },
    { field: "totalCents", label: "Total", fixed: true },
    { field: "status", label: "Status" },
  ]);
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
    <Page>
      <PageActions>
        <Button
          needs={{ invoicing: ["create"] }}
          onClick={() => setAdding(true)}
        >
          <span className="flex items-center gap-1.5">
            <Icon name="plus" size={15} />
            New quote
          </span>
        </Button>
      </PageActions>

      {/*
        Status first, the same as invoices — a quote is the same document
        before it is owed.
      */}
      <Tabs
        tabs={TABS.map((t) => ({
          id: t.id,
          label: t.label,
          badge: counts.data?.counts[t.id],
        }))}
        active={tab}
        onChange={(id) => {
          setTab(id);
          state.setPage(1);
        }}
      />

      <Toolbar>
        <Input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder="Search by number or note"
          aria-label="Search quotes"
          className="w-64"
        />

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

        <SavedViews
          resource="quotes"
          state={state}
          defaults={{ sort: "issueDate", order: "desc" }}
        />

        <ColumnsMenu state={columns} />

        <div className="ml-auto">
          {/* The same query the table is showing, so what is exported is
              what is on screen. */}
          <a
            href={`/api/quotes/export.csv?${query}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm"
          >
            Export
          </a>
        </div>
      </Toolbar>

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
          <Card className="table-inset p-0">
            <Table
              headers={[
                "Number",
                ...(columns.shown("customer") ? ["Customer"] : []),
                ...(columns.shown("issueDate") ? ["Date"] : []),
                ...(columns.shown("validUntil") ? ["Valid until"] : []),
                { label: "Total", money: true },
                ...(columns.shown("status") ? ["Status"] : []),
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
                          <Icon name="tick" size={13} />
                        </span>
                      ) : null}
                    </td>
                    {columns.shown("customer") ? (
                      <td className="max-w-44 truncate">
                        {quote.contactName ?? "—"}
                      </td>
                    ) : null}
                    {columns.shown("issueDate") ? (
                      <td className="whitespace-nowrap" style={muted}>
                        {formatDate(quote.issueDate)}
                      </td>
                    ) : null}
                    {columns.shown("validUntil") ? (
                      <td className="whitespace-nowrap" style={muted}>
                        {quote.validUntil ? formatDate(quote.validUntil) : "—"}
                      </td>
                    ) : null}
                    <td className="money">{formatMoney(quote.totalCents)}</td>
                    {columns.shown("status") ? (
                      <td className="whitespace-nowrap">
                        <span className="text-sm" style={{ color: shown.tone }}>
                          {shown.label}
                        </span>
                      </td>
                    ) : null}
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
    </Page>
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
      <SectionHeading
        trailing={
          <button type="button" className="text-sm link-muted" onClick={onDone}>
            Cancel
          </button>
        }
      >
        Split {quote.number} into instalments
      </SectionHeading>

      <Toolbar className="mb-(--gap-stack)">
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
      </Toolbar>

      <div className="flex flex-col gap-(--gap-toolbar)">
        {parts.map((part, i) => (
          <div
            key={part.key}
            className="grid items-end gap-(--gap-toolbar) sm:grid-cols-[6rem_8rem_7rem_minmax(0,1fr)_auto]"
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

      <Toolbar className="mt-(--gap-stack)">
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
          needs={{ invoicing: ["create"] }}
          onClick={() => split.mutate()}
          disabled={!balanced || split.isPending}
        >
          Create {parts.length} draft invoices
        </Button>
      </Toolbar>
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

  const unshare = useMutation({
    mutationFn: () =>
      api(`/api/quotes/${quote.id}/unshare`, { method: "POST" }),
    onSuccess: () => {
      setOpen(false);
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
    <>
      <RowMenu label={quote.number} open={open} onOpenChange={setOpen}>
        {() => (
          <>
            {/* Editable until it has become an invoice — the server refuses
              after that, because the invoice's lines came from these and it is
              the one that posted to the ledger. A sent quote is still
              editable: revising and re-sending is what negotiation is. */}
            {!quote.convertedInvoiceId ? (
              <MenuItem
                needs={{ invoicing: ["update"] }}
                onClick={() => {
                  setOpen(false);
                  onEdit();
                }}
              >
                Edit
              </MenuItem>
            ) : null}

            {quote.status === "draft" ? (
              <MenuItem
                needs={{ invoicing: ["send"] }}
                onClick={() => send.mutate()}
                disabled={send.isPending}
              >
                Send it
              </MenuItem>
            ) : null}

            <MenuItem
              needs={{ invoicing: ["send"] }}
              onClick={() => share.mutate()}
              disabled={share.isPending}
            >
              {copied ? "Link copied" : "Copy a link to send"}
            </MenuItem>

            {/*
            Taking it back offline. A quote could be published to a link
            anybody holding it can open, and never withdrawn — which matters
            more here than on an invoice: a price offered and thought better of
            stays readable for as long as somebody keeps the link.
          */}
            {quote.published ? (
              <MenuItem
                needs={{ invoicing: ["send"] }}
                onClick={() => unshare.mutate()}
                disabled={unshare.isPending}
              >
                Stop sharing
              </MenuItem>
            ) : null}

            {/* Once, and only once. A second conversion is a second bill for
              the same work. */}
            {converted ? (
              <span className="menu-item" style={muted}>
                Already invoiced
              </span>
            ) : (
              <>
                <MenuItem
                  needs={{ invoicing: ["create"] }}
                  onClick={() => convert.mutate()}
                  disabled={convert.isPending}
                >
                  Turn into an invoice
                </MenuItem>
                {/* Or into the schedule that was agreed with it. */}
                <MenuItem
                  onClick={() => {
                    setOpen(false);
                    onSplit();
                  }}
                >
                  Split into instalments
                </MenuItem>
              </>
            )}

            {quote.deletedAt ? (
              <MenuItem
                needs={{ invoicing: ["delete"] }}
                onClick={() => restore.mutate()}
                disabled={restore.isPending}
              >
                Restore
              </MenuItem>
            ) : (
              // Nothing asked first: this is the soft delete. The quote moves
              // to the Deleted tab and Restore, right here, brings it back.
              <MenuItem
                needs={{ invoicing: ["delete"] }}
                style={{ color: "var(--text-danger)" }}
                onClick={() => remove.mutate()}
                disabled={remove.isPending}
              >
                Delete
              </MenuItem>
            )}
          </>
        )}
      </RowMenu>
      {convert.error ? <ErrorNote error={convert.error} /> : null}
      {send.error ? <ErrorNote error={send.error} /> : null}
      {/* Every one of these closes the menu on the way, so a refusal has
          nowhere else left to appear. */}
      {share.error ? <ErrorNote error={share.error} /> : null}
      {unshare.error ? <ErrorNote error={unshare.error} /> : null}
      {restore.error ? <ErrorNote error={restore.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </>
  );
}
