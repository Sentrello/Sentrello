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
import type { TagChip } from "../lib/tags";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Row,
  Select,
  Table,
  border,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";
import { InvoiceForm } from "./invoice-form";

/**
 * Everything the business has billed, organised by what still needs doing.
 *
 * Rebuilt from the reference, whose one big idea about this screen is right: it is
 * organised by **status** before anything else. Nobody opens an invoice list
 * asking "show me all of them" — they open it asking what is unpaid, what is
 * late, or what is still a draft. So the tabs are the primary control and the
 * search is secondary, rather than the other way round.
 *
 * The counts on the tabs come from the server, because "eleven unpaid, three
 * overdue" is the state of the business and should not take eight clicks to
 * find out.
 */

interface InvoiceRow {
  id: string;
  number: string;
  kind: string;
  contactId: string | null;
  status: string;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  overdue: boolean;
  viewCount: number;
  firstViewedAt: string | null;
  published: boolean;
  /** What it has been labelled. Sent with the page, not fetched per row. */
  tags: TagChip[];
  deletedAt: string | null;
}

const TABS: { id: string; label: string }[] = [
  { id: "all", label: "All" },
  { id: "draft", label: "Drafts" },
  { id: "unpaid", label: "Unpaid" },
  { id: "overdue", label: "Overdue" },
  { id: "paid", label: "Paid" },
  { id: "void", label: "Void" },
  { id: "credit_notes", label: "Credit notes" },
  { id: "deleted", label: "Deleted" },
];

/**
 * What an invoice's state is called, and whether it should worry anybody.
 *
 * "Overdue" is not a stored status — it depends on today — so it is decided
 * here from the flag the server computed rather than from the column.
 */
function statusOf(invoice: InvoiceRow): { label: string; tone: string } {
  if (invoice.deletedAt) return { label: "Deleted", tone: "var(--text-muted)" };
  if (invoice.kind === "credit_note") {
    return { label: "Credit note", tone: "var(--color-info)" };
  }
  switch (invoice.status) {
    case "draft":
      return { label: "Draft", tone: "var(--text-muted)" };
    case "paid":
      return { label: "Paid", tone: "var(--color-success)" };
    case "void":
      return { label: "Void", tone: "var(--text-muted)" };
    case "partial":
      return {
        label: invoice.overdue ? "Part paid, overdue" : "Part paid",
        tone: invoice.overdue ? "var(--color-danger)" : "var(--color-warning)",
      };
    default:
      return invoice.overdue
        ? { label: "Overdue", tone: "var(--color-danger)" }
        : { label: "Unpaid", tone: "var(--color-warning)" };
  }
}

export function Invoices() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [tab, setTab] = useState("all");
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  /** What is ticked, for merging and for deleting several at once. */
  const [picked, setPicked] = useState<string[]>([]);

  /** Narrowed to one label, when a business is working through a pile. */
  const [tagId, setTagId] = useState("");

  const state = useListState({ sort: "issueDate", order: "desc" });
  const query = `${listQueryString(state, true)}&tab=${tab}${
    tagId ? `&tagId=${encodeURIComponent(tagId)}` : ""
  }`;

  const { data, isLoading, error } = useQuery({
    queryKey: ["invoices", query],
    queryFn: () =>
      api<{
        invoices: InvoiceRow[];
        total: number;
        billedCents: number;
      }>(`/api/invoices?${query}`),
    // The previous page stays on screen while the next loads, so a keystroke
    // in the search box does not blank the table to a spinner.
    placeholderData: (previous) => previous,
  });

  const counts = useQuery({
    queryKey: ["invoice-counts"],
    queryFn: () =>
      api<{ counts: Record<string, number> }>("/api/invoices/counts"),
  });

  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: TagChip[] }>("/api/tags"),
  });

  const contacts = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });
  const customer = (id: string | null) =>
    id ? contacts.data?.contacts.find((c) => c.id === id)?.name : undefined;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice-counts"] });
  };

  /**
   * Merging several drafts into one invoice.
   *
   * Offered only when what is ticked can actually be merged — two or more, all
   * still drafts. A button that is there and then refuses is a button that
   * teaches somebody not to trust the screen.
   */
  const merge = useMutation({
    mutationFn: () =>
      api<{ invoice: { id: string; number: string } }>(
        "/api/invoices/consolidate",
        { method: "POST", body: JSON.stringify({ invoiceIds: picked }) },
      ),
    onSuccess: (made) => {
      setPicked([]);
      refresh();
      open({
        moduleId: "invoicing",
        recordId: made.invoice.id,
        title: made.invoice.number,
      });
    },
  });

  /**
   * Deleting what is ticked.
   *
   * ponytail: one request per row against the endpoint that already exists,
   * rather than a batch route. Delete is a soft delete and idempotent, and a
   * page holds at most a hundred rows. Give it a batch endpoint if somebody
   * ever wants to clear a thousand.
   */
  const removeMany = useMutation({
    mutationFn: async () => {
      for (const id of picked) {
        await api(`/api/invoices/${id}`, { method: "DELETE" });
      }
    },
    onSuccess: () => {
      setPicked([]);
      refresh();
    },
  });

  if (error) return <ErrorNote error={error} />;

  const rows = data?.invoices ?? [];
  const paginated = (data?.total ?? 0) > state.perPage;

  if (adding || editing) {
    return (
      <InvoiceForm
        documentId={editing ?? undefined}
        onDone={(saved) => {
          setAdding(false);
          setEditing(null);
          refresh();
          if (saved) {
            open({
              moduleId: "invoicing",
              recordId: saved.id,
              title: saved.number,
            });
          }
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {/*
        Status first. The tabs carry their own counts, which is what turns
        this from a list into a summary somebody can act on.
      */}
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
            aria-label="Search invoices"
            className="w-64 rounded-md border py-1.5 pr-2 pl-7 text-sm"
            style={{ ...border, background: "var(--surface-raised)" }}
          />
        </div>

        {/* One label at a time. The pile a business works through is
            "disputed" or "with the accountant", not both at once. */}
        {(tags.data?.tags ?? []).length > 0 ? (
          <Select
            value={tagId}
            aria-label="Filter by tag"
            className="w-44"
            onChange={(e) => setTagId(e.target.value)}
          >
            <option value="">Any tag</option>
            {(tags.data?.tags ?? []).map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        ) : null}

        <SortMenu
          state={state}
          fields={[
            { field: "issueDate", label: "Issue date", order: "desc" },
            { field: "dueDate", label: "Due date", order: "asc" },
            { field: "number", label: "Number", order: "desc" },
            { field: "totalCents", label: "Amount", order: "desc" },
            { field: "status", label: "Status", order: "asc" },
          ]}
        />

        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm" style={muted}>
            {formatMoney(data?.billedCents ?? 0)} across {data?.total ?? 0}
          </span>
          {/* What can be done to what is ticked. Nothing is offered until
              something is, and merging only when the selection can be merged:
              two or more, all of them still drafts. */}
          {picked.length > 0 ? (
            <>
              <span className="text-sm" style={muted}>
                {picked.length} selected
              </span>
              {picked.length > 1 &&
              picked.every(
                (id) => rows.find((r) => r.id === id)?.status === "draft",
              ) ? (
                <button
                  type="button"
                  className="text-sm link"
                  disabled={merge.isPending}
                  onClick={() => merge.mutate()}
                >
                  Merge into one
                </button>
              ) : null}
              <button
                type="button"
                className="text-sm link-muted"
                disabled={removeMany.isPending}
                onClick={() => removeMany.mutate()}
              >
                Delete
              </button>
              <button
                type="button"
                className="text-sm link-muted"
                onClick={() => setPicked([])}
              >
                Clear
              </button>
            </>
          ) : null}
          {merge.error ? <ErrorNote error={merge.error} /> : null}
          {/* A plain link, not a fetch: the browser downloads it with the
              filename the server sends, and the session cookie goes along.
              The same query the table is showing, so what is exported is what
              is on screen. */}
          <a
            href={`/api/invoices/export.csv?${query}`}
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
            style={border}
          >
            <Icon name="file-text" size={15} />
            Export
          </a>
          <Button onClick={() => setAdding(true)}>
            <span className="flex items-center gap-1.5">
              <Icon name="plus" size={15} />
              New invoice
            </span>
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <Empty title={state.q ? "No matches" : "Nothing here"}>
          {state.q
            ? "Try a different search."
            : tab === "all"
              ? "Raise an invoice and it posts to the ledger as you issue it."
              : "Nothing is in this state at the moment."}
        </Empty>
      ) : (
        <>
          <Card className="p-0">
            <Table
              headers={[
                "",
                "Number",
                "Customer",
                "Issued",
                "Due",
                { label: "Total", money: true },
                { label: "Owed", money: true },
                "Status",
                "",
              ]}
            >
              {rows.map((invoice) => {
                const state_ = statusOf(invoice);
                return (
                  <Row key={invoice.id}>
                    <td className="py-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${invoice.number}`}
                        checked={picked.includes(invoice.id)}
                        onChange={(e) =>
                          setPicked((current) =>
                            e.target.checked
                              ? [...current, invoice.id]
                              : current.filter((id) => id !== invoice.id),
                          )
                        }
                      />
                    </td>
                    <td className="whitespace-nowrap py-2 font-medium">
                      <button
                        type="button"
                        className="link"
                        onClick={() =>
                          open({
                            moduleId: "invoicing",
                            recordId: invoice.id,
                            title: invoice.number,
                          })
                        }
                      >
                        {invoice.number}
                      </button>
                      {/*
                        Whether the customer has opened it. A business chasing
                        an unpaid invoice is in a different conversation
                        depending on the answer, and "I never received it" is
                        the most common thing said on that call.
                      */}
                      {invoice.firstViewedAt ? (
                        <span
                          className="ml-1.5"
                          style={muted}
                          title={`Opened ${formatDate(invoice.firstViewedAt)}`}
                        >
                          <Icon name="check-square" size={13} />
                        </span>
                      ) : null}
                      {/* The labels, where somebody scanning the list will
                          see them: beside the number, not in a column that
                          is empty on most rows. */}
                      {(invoice.tags ?? []).map((tag) => (
                        <span
                          key={tag.id}
                          className="ml-1.5 rounded-full px-1.5 py-0.5 text-xs"
                          style={{ background: tag.color, color: "#111" }}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </td>
                    <td className="max-w-44 truncate">
                      {customer(invoice.contactId) ?? "—"}
                    </td>
                    <td className="whitespace-nowrap" style={muted}>
                      {formatDate(invoice.issueDate)}
                    </td>
                    <td className="whitespace-nowrap" style={muted}>
                      {invoice.dueDate ? formatDate(invoice.dueDate) : "—"}
                    </td>
                    <td className="money">{formatMoney(invoice.totalCents)}</td>
                    <td className="money">
                      {invoice.balanceCents > 0
                        ? formatMoney(invoice.balanceCents)
                        : "—"}
                    </td>
                    <td className="whitespace-nowrap">
                      <span className="text-sm" style={{ color: state_.tone }}>
                        {state_.label}
                      </span>
                    </td>
                    <td className="text-right">
                      <InvoiceActions
                        invoice={invoice}
                        onEdit={() => setEditing(invoice.id)}
                        onDone={refresh}
                      />
                    </td>
                  </Row>
                );
              })}
            </Table>
          </Card>

          {paginated ? (
            <Pagination state={state} total={data?.total ?? 0} />
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * What can be done to one invoice, behind three dots.
 *
 * Which actions are offered depends on where the document is: a draft can be
 * edited and issued, an issued one can be shared and voided, a paid one can
 * only be credited. Offering all of them and refusing most is how somebody
 * learns to ignore the menu.
 */
function InvoiceActions({
  invoice,
  onEdit,
  onDone,
}: {
  invoice: InvoiceRow;
  onEdit: () => void;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const act = useMutation({
    mutationFn: (path: string) =>
      api<Record<string, unknown>>(`/api/invoices/${invoice.id}/${path}`, {
        method: "POST",
      }),
    onSuccess: () => {
      setOpen(false);
      onDone();
    },
  });

  const share = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/invoices/${invoice.id}/share`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      navigator.clipboard?.writeText(data.url);
      setCopied(true);
      onDone();
    },
  });

  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  const paid = invoice.paidCents > 0;

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="link-muted px-1"
        aria-label={`More for ${invoice.number}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open ? (
        <span className="menu-panel z-10" onMouseLeave={() => setOpen(false)}>
          {/* Out of the bin. Deleting is soft, and a list that can show the
              deleted ones but not bring one back is a bin with no lid off. */}
          {invoice.deletedAt ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => act.mutate("restore")}
              disabled={act.isPending}
            >
              Restore
            </button>
          ) : null}

          {isDraft && !invoice.deletedAt ? (
            <>
              <button type="button" className="menu-item" onClick={onEdit}>
                Edit
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => act.mutate("issue")}
                disabled={act.isPending}
              >
                Issue it
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="menu-item"
            onClick={() => share.mutate()}
            disabled={share.isPending}
          >
            {copied ? "Link copied" : "Copy a link to send"}
          </button>

          <button
            type="button"
            className="menu-item"
            onClick={() => act.mutate("duplicate")}
            disabled={act.isPending}
          >
            Duplicate
          </button>

          {!isVoid && !paid ? (
            <button
              type="button"
              className="menu-item"
              style={{ color: "var(--color-danger)" }}
              onClick={() => act.mutate("void")}
              disabled={act.isPending}
            >
              Void it
            </button>
          ) : null}

          {/* Money has moved, so voiding would lose it. This is what a
              business does instead. */}
          {paid && invoice.kind !== "credit_note" ? (
            <button
              type="button"
              className="menu-item"
              onClick={() => act.mutate("credit")}
              disabled={act.isPending}
            >
              Raise a credit note
            </button>
          ) : null}
        </span>
      ) : null}
      {act.error ? <ErrorNote error={act.error} /> : null}
    </span>
  );
}
