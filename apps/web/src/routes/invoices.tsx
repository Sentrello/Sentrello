import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, may } from "../lib/api";
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
import type { TagChip } from "../lib/tags";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Input,
  Loading,
  MenuItem,
  Page,
  PageActions,
  REFUSED,
  Row,
  RowMenu,
  Select,
  Table,
  Tabs,
  Toolbar,
  formatDate,
  formatMoney,
  muted,
  textOn,
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
  /** Resolved on the server, per page, not by fetching every contact. */
  contactName: string | null;
  status: string;
  currency: string;
  issueDate: string;
  dueDate: string | null;
  subtotalCents: number;
  discountCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  /** Settled by credit note rather than by money. */
  creditedCents: number;
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
    return { label: "Credit note", tone: "var(--text-info)" };
  }
  switch (invoice.status) {
    case "draft":
      return { label: "Draft", tone: "var(--text-muted)" };
    case "paid":
      return { label: "Paid", tone: "var(--text-success)" };
    case "credited":
      // Settled without money moving: nobody paid it, the business gave the
      // debt up by credit note. Its own word, because "Paid" would be false.
      return { label: "Credited", tone: "var(--text-info)" };
    case "void":
      return { label: "Void", tone: "var(--text-muted)" };
    case "partial":
      return {
        label: invoice.overdue ? "Part paid, overdue" : "Part paid",
        tone: invoice.overdue ? "var(--text-danger)" : "var(--text-warning)",
      };
    default:
      return invoice.overdue
        ? { label: "Overdue", tone: "var(--text-danger)" }
        : { label: "Unpaid", tone: "var(--text-warning)" };
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
  /**
   * Whether Delete has been pressed once already.
   *
   * The toolbar is already saying how many are ticked, so a dialog over it
   * would read the count back at somebody who can see it. What was missing is
   * the pause: one press turned a whole page of ticked invoices into deleted
   * ones with nothing asked. Cleared wherever the selection empties, the way
   * the same two-step on contacts is cleared by unmounting.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  /** Narrowed to one label, when a business is working through a pile. */
  const [tagId, setTagId] = useState("");

  const state = useListState({ sort: "issueDate", order: "desc" });
  /**
   * Which columns are worth the width on this screen.
   *
   * The number, the total and the row's own actions are fixed: a list of
   * invoices without them is not a list of invoices. Everything else is
   * somebody's own choice — a business that never uses due dates because it
   * is paid on the day should not scroll past them for ever.
   */
  const columns = useColumns("invoices", [
    { field: "number", label: "Number", fixed: true },
    { field: "customer", label: "Customer" },
    { field: "issueDate", label: "Issued" },
    { field: "dueDate", label: "Due" },
    { field: "totalCents", label: "Total", fixed: true },
    { field: "balanceCents", label: "Owed" },
    { field: "status", label: "Status" },
  ]);
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
      setConfirmingDelete(false);
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
      setConfirmingDelete(false);
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
    <Page>
      {/*
        The one thing this screen is for, in the title line every screen puts
        its primary action in.
      */}
      <PageActions>
        <Button
          needs={{ invoicing: ["create"] }}
          onClick={() => setAdding(true)}
        >
          <span className="flex items-center gap-1.5">
            <Icon name="plus" size={15} />
            New invoice
          </span>
        </Button>
      </PageActions>

      {/*
        Status first. The tabs carry their own counts, which is what turns
        this from a list into a summary somebody can act on.
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
          aria-label="Search invoices"
          className="w-64"
        />

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

        <SavedViews
          resource="invoices"
          state={state}
          defaults={{ sort: "issueDate", order: "desc" }}
        />

        <ColumnsMenu state={columns} />

        <div className="ml-auto flex flex-wrap items-center gap-(--gap-toolbar)">
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
                <MenuItem
                  needs={{ invoicing: ["create"] }}
                  className="text-sm link"
                  disabled={merge.isPending}
                  onClick={() => merge.mutate()}
                >
                  Merge into one
                </MenuItem>
              ) : null}
              {confirmingDelete ? (
                <button
                  type="button"
                  className="text-sm link-danger"
                  // A bare button with no kit primitive to hang `needs` on,
                  // so it asks directly. It deletes every invoice somebody
                  // has ticked, and it was open to anybody who could read
                  // the list.
                  disabled={removeMany.isPending || !may("invoicing", "delete")}
                  title={may("invoicing", "delete") ? undefined : REFUSED}
                  onClick={() => removeMany.mutate()}
                >
                  {removeMany.isPending
                    ? "Deleting…"
                    : `Really delete ${picked.length}`}
                </button>
              ) : (
                <button
                  type="button"
                  className="text-sm link-muted"
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </button>
              )}
              <button
                type="button"
                className="text-sm link-muted"
                onClick={() => {
                  setPicked([]);
                  setConfirmingDelete(false);
                }}
              >
                Clear
              </button>
            </>
          ) : null}
          {merge.error ? <ErrorNote error={merge.error} /> : null}
          {/* The loop stops at the first refusal, so some of the ticked rows
              may already be gone. Saying so is the difference between reading
              the shorter list as the delete having worked and knowing to
              look. */}
          {removeMany.error ? <ErrorNote error={removeMany.error} /> : null}
          {/* A plain link, not a fetch: the browser downloads it with the
              filename the server sends, and the session cookie goes along.
              The same query the table is showing, so what is exported is what
              is on screen. */}
          <a
            href={`/api/invoices/export.csv?${query}`}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm"
          >
            Export
          </a>
        </div>
      </Toolbar>

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
          <Card className="table-inset p-0">
            <Table
              headers={[
                "",
                "Number",
                ...(columns.shown("customer") ? ["Customer"] : []),
                ...(columns.shown("issueDate") ? ["Issued"] : []),
                ...(columns.shown("dueDate") ? ["Due"] : []),
                { label: "Total", money: true },
                ...(columns.shown("balanceCents")
                  ? [{ label: "Owed", money: true }]
                  : []),
                ...(columns.shown("status") ? ["Status"] : []),
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
                          <Icon name="tick" size={13} />
                        </span>
                      ) : null}
                      {/* The labels, where somebody scanning the list will
                          see them: beside the number, not in a column that
                          is empty on most rows. */}
                      {(invoice.tags ?? []).map((tag) => (
                        <span
                          key={tag.id}
                          className="ml-1.5 rounded-full px-1.5 py-0.5 text-xs"
                          style={{
                            background: tag.color,
                            color: textOn(tag.color),
                          }}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </td>
                    {columns.shown("customer") ? (
                      <td className="max-w-44 truncate">
                        {invoice.contactName ?? "—"}
                      </td>
                    ) : null}
                    {columns.shown("issueDate") ? (
                      <td className="whitespace-nowrap" style={muted}>
                        {formatDate(invoice.issueDate)}
                      </td>
                    ) : null}
                    {columns.shown("dueDate") ? (
                      <td className="whitespace-nowrap" style={muted}>
                        {invoice.dueDate ? formatDate(invoice.dueDate) : "—"}
                      </td>
                    ) : null}
                    <td className="money">{formatMoney(invoice.totalCents)}</td>
                    {columns.shown("balanceCents") ? (
                      <td className="money">
                        {invoice.balanceCents > 0
                          ? formatMoney(invoice.balanceCents)
                          : "—"}
                      </td>
                    ) : null}
                    {columns.shown("status") ? (
                      <td className="whitespace-nowrap">
                        <span
                          className="text-sm"
                          style={{ color: state_.tone }}
                        >
                          {state_.label}
                        </span>
                      </td>
                    ) : null}
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
    </Page>
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
  // A credit note already reversed some of it in the books, so voiding is
  // off the menu — the server refuses it for the same reason.
  const credited = invoice.creditedCents > 0;

  return (
    <>
      <RowMenu label={invoice.number} open={open} onOpenChange={setOpen}>
        {() => (
          <>
            {/* Out of the bin. Deleting is soft, and a list that can show the
              deleted ones but not bring one back is a bin with no lid off. */}
            {invoice.deletedAt ? (
              <MenuItem
                needs={{ invoicing: ["delete"] }}
                onClick={() => act.mutate("restore")}
                disabled={act.isPending}
              >
                Restore
              </MenuItem>
            ) : null}

            {isDraft && !invoice.deletedAt ? (
              <>
                <MenuItem needs={{ invoicing: ["update"] }} onClick={onEdit}>
                  Edit
                </MenuItem>
                <MenuItem
                  needs={{ invoicing: ["update"] }}
                  onClick={() => act.mutate("issue")}
                  disabled={act.isPending}
                >
                  Issue it
                </MenuItem>
              </>
            ) : null}

            <MenuItem
              needs={{ invoicing: ["send"] }}
              onClick={() => share.mutate()}
              disabled={share.isPending}
            >
              {copied ? "Link copied" : "Copy a link to send"}
            </MenuItem>

            <MenuItem
              needs={{ invoicing: ["create"] }}
              onClick={() => act.mutate("duplicate")}
              disabled={act.isPending}
            >
              Duplicate
            </MenuItem>

            {!isVoid && !paid && !credited ? (
              <MenuItem
                needs={{ invoicing: ["update"] }}
                style={{ color: "var(--text-danger)" }}
                onClick={() => act.mutate("void")}
                disabled={act.isPending}
              >
                Void it
              </MenuItem>
            ) : null}

            {/* Money has moved, so voiding would lose it. This is what a
              business does instead. */}
            {paid && invoice.kind !== "credit_note" ? (
              <MenuItem
                needs={{ invoicing: ["create"] }}
                onClick={() => act.mutate("credit")}
                disabled={act.isPending}
              >
                Raise a credit note
              </MenuItem>
            ) : null}
          </>
        )}
      </RowMenu>
      {act.error ? <ErrorNote error={act.error} /> : null}
      {share.error ? <ErrorNote error={share.error} /> : null}
    </>
  );
}
