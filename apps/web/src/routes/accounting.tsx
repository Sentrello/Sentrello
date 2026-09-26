import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Account, type Meta, type ProfitAndLoss, api } from "../lib/api";
import type { CustomField } from "../lib/crm-settings";
import { CustomFields } from "../lib/custom-fields";
import { Icon } from "../lib/icons";
import {
  PAGINATION_THRESHOLD,
  Pagination,
  SortMenu,
  listQueryString,
  useListState,
} from "../lib/list-ui";
import { toCents } from "../lib/money";
import { SavedViews } from "../lib/saved-views";
import {
  Button,
  Card,
  ConfirmButton,
  Dialog,
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
  Select,
  StatFigure,
  Table,
  Tabs,
  Toolbar,
  Warning,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The books.
 *
 * Four screens, in the order somebody actually uses them: what the business
 * earned and spent, the money going in and out, the accounts it lands in, and
 * the journal underneath when a figure has to be explained.
 */

type Transaction = {
  id: string;
  kind: "income" | "expense";
  accountId: string | null;
  paidThroughAccountId: string | null;
  amountCents: number;
  occurredAt: string;
  description: string | null;
  reference: string | null;
  method: string | null;
  receiptFileKey: string | null;
  reversedAt: string | null;
};

/**
 * Putting right a line that was entered wrong.
 *
 * Kept to the four things people actually mistype — the date, what it says,
 * how much, and which category it belongs under. Everything else on a
 * transaction is set by the thing that created it.
 *
 * The category list is filtered by the kind, the same rule the server
 * enforces: money out must land on an expense account and money in on an
 * income account, and a screen that offered the wrong ones would be asking for
 * a 400 the person cannot act on.
 */
function CorrectTransaction({
  transaction,
  accounts,
  onClose,
  onSave,
  saving,
  error,
}: {
  transaction: Transaction | null;
  accounts: Account[];
  onClose: () => void;
  onSave: (input: {
    id: string;
    description: string;
    amount: string;
    accountId: string;
    occurredAt: string;
  }) => void;
  saving: boolean;
  error: unknown;
}) {
  const [draft, setDraft] = useState({
    description: "",
    amount: "",
    accountId: "",
    occurredAt: "",
  });
  // Reset to the row being corrected each time a different one is opened.
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (transaction && openedFor !== transaction.id) {
    setOpenedFor(transaction.id);
    setDraft({
      description: transaction.description ?? "",
      amount: (transaction.amountCents / 100).toFixed(2),
      accountId: transaction.accountId ?? "",
      occurredAt: transaction.occurredAt.slice(0, 10),
    });
  }

  const categories = accounts.filter((a) =>
    transaction?.kind === "expense"
      ? a.type === "expense"
      : a.type === "income",
  );

  return (
    <Dialog
      title="Correct this entry"
      open={Boolean(transaction)}
      onClose={onClose}
    >
      <p className="mb-(--gap-stack) text-xs" style={muted}>
        The books are put right as well: the entry that was posted is reversed
        and the corrected one posted in its place, so a report printed last week
        can still be explained.
      </p>
      <Field label="Date">
        <Input
          type="date"
          value={draft.occurredAt}
          onChange={(e) => setDraft({ ...draft, occurredAt: e.target.value })}
        />
      </Field>
      <Field label="Detail">
        <Input
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </Field>
      <Field label="Amount">
        <Input
          value={draft.amount}
          inputMode="decimal"
          onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
        />
      </Field>
      <Field label="Category">
        <Select
          value={draft.accountId}
          onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}
        >
          {categories.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
        </Select>
      </Field>
      {error ? <ErrorNote error={error} /> : null}
      <Toolbar className="mt-(--gap-stack) justify-end">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={saving || !transaction}
          onClick={() =>
            transaction && onSave({ id: transaction.id, ...draft })
          }
        >
          Save the correction
        </Button>
      </Toolbar>
    </Dialog>
  );
}

type AccountTotal = {
  accountId: string;
  code: string;
  name: string;
  balanceCents: number;
};

type Statement = ProfitAndLoss & {
  income: AccountTotal[];
  expenses: AccountTotal[];
};

type BalanceSheet = {
  asOf: string;
  assets: AccountTotal[];
  liabilities: AccountTotal[];
  equity: AccountTotal[];
  assetsCents: number;
  liabilitiesCents: number;
  equityCents: number;
  earningsCents: number;
  balanced: boolean;
};

function startOfYear(): string {
  return `${new Date().getFullYear()}-01-01`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Profit and loss and balance sheet, read straight from the ledger.
 *
 * Nothing is recomputed here: the journal is the source of truth, so an invoice
 * paid and an expense recorded show up in the same numbers an accountant would
 * arrive at from the entries.
 */
export function Summary() {
  const [from, setFrom] = useState(startOfYear());
  const [to, setTo] = useState(today());
  /**
   * Which question the profit and loss is answering.
   *
   * Accrual counts an invoice the day it is issued; cash counts it the day it
   * is paid. Both are correct answers to different questions, and a great many
   * small businesses file on the cash basis — so the report they file from has
   * to be one they can produce here rather than in a spreadsheet.
   *
   * Accrual stays the default: it is the honest answer to "how is the business
   * doing", and it is what a business must produce at all if it is over the
   * threshold to use the cash basis.
   */
  const [basis, setBasis] = useState("accrual");
  /**
   * One job, or one branch, or the business as a whole.
   *
   * A class is only worth tagging if a report can be asked for it — a
   * dimension the reports cannot read is a field somebody fills in for nothing.
   */
  const [classId, setClassId] = useState("");

  const dimensions = useQuery({
    queryKey: ["dimensions"],
    queryFn: () =>
      api<{ dimensions: { id: string; kind: string; name: string }[] }>(
        "/api/dimensions",
      ),
    // A Free instance has no dimensions route, and a failed query on this
    // screen would take the profit and loss down with it.
    retry: false,
  });
  const classes = (dimensions.data?.dimensions ?? []).filter(
    (d) => d.kind === "class",
  );

  const pnl = useQuery({
    queryKey: ["profit-and-loss", from, to, basis, classId],
    queryFn: () =>
      api<Statement>(
        `/api/reports/profit-and-loss?from=${from}&to=${to}&basis=${basis}${
          classId ? `&classId=${classId}` : ""
        }`,
      ),
  });
  const sheet = useQuery({
    queryKey: ["balance-sheet", to],
    queryFn: () => api<BalanceSheet>(`/api/reports/balance-sheet?asOf=${to}`),
  });

  return (
    <Page>
      <Card>
        <div className="grid gap-(--gap-toolbar) sm:grid-cols-[10rem_10rem_12rem_14rem]">
          <Field label="From">
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label="To">
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
          {classes.length > 0 ? (
            <Field label="For">
              <Select
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
              >
                <option value="">the business as a whole</option>
                {classes.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Field
            label="Count income and expenses"
            hint={
              basis === "cash"
                ? "When the money moved. The balance sheet is unaffected."
                : "When the work was invoiced or the bill arrived."
            }
          >
            <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
              <option value="accrual">when invoiced (accrual)</option>
              <option value="cash">when paid (cash)</option>
            </Select>
          </Field>
        </div>
      </Card>

      {pnl.isLoading ? <Loading /> : null}
      {pnl.error ? <ErrorNote error={pnl.error} /> : null}
      {pnl.data ? (
        <>
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-3">
            <Figure label="Income" cents={pnl.data.incomeCents} />
            <Figure label="Expenses" cents={pnl.data.expenseCents} />
            <Figure label="Net" cents={pnl.data.netCents} emphasise />
          </div>

          <Card>
            <SectionHeading
              hint={
                basis === "cash"
                  ? "on what was actually received and paid"
                  : null
              }
            >
              Profit and loss
            </SectionHeading>
            <Breakdown title="Income" rows={pnl.data.income} />
            <Breakdown title="Expenses" rows={pnl.data.expenses} />
          </Card>
        </>
      ) : null}

      <FxRevaluation asOf={to} />

      {sheet.data ? (
        <Card>
          <SectionHeading>
            Balance sheet as at {formatDate(sheet.data.asOf)}
          </SectionHeading>
          <Breakdown title="Assets" rows={sheet.data.assets} />
          <Breakdown title="Liabilities" rows={sheet.data.liabilities} />
          <Breakdown title="Equity" rows={sheet.data.equity} />
          <div className="mt-(--gap-stack) flex justify-between border-line border-t pt-2 text-sm">
            <span>Earnings not drawn out</span>
            <span className="money">
              {formatMoney(sheet.data.earningsCents)}
            </span>
          </div>
          {!sheet.data.balanced ? (
            <Warning className="mt-2">
              This balance sheet does not balance. Something has reached the
              ledger that should not have — the journal will show what.
            </Warning>
          ) : null}
        </Card>
      ) : null}
    </Page>
  );
}

/**
 * What the open foreign balances are worth at the end of the period.
 *
 * Absent unless there is something to say. A business that invoices in one
 * currency has nothing here, and a control offering to revalue nothing is a
 * question somebody has to work out the answer to before they can ignore it.
 *
 * The date is the one the balance sheet above is drawn to, deliberately: the
 * figure being restated is the receivable and payable on that very statement,
 * and two dates would let somebody revalue to a day the sheet does not show.
 */
function FxRevaluation({ asOf }: { asOf: string }) {
  const qc = useQueryClient();
  const movement = useQuery({
    queryKey: ["fx-revaluation", asOf],
    queryFn: () =>
      api<{
        baseCurrency: string;
        receivableCents: number;
        payableCents: number;
        alreadyPosted: boolean;
        missingRates: string[];
        lines: {
          kind: string;
          number: string | null;
          currency: string;
          outstandingCents: number;
          carryingCents: number;
          revaluedCents: number;
          differenceCents: number;
        }[];
      }>(`/api/accounting/fx-revaluation?asOf=${asOf}`),
    retry: false,
  });

  const post = useMutation({
    mutationFn: () =>
      api("/api/accounting/fx-revaluation", {
        method: "POST",
        body: JSON.stringify({ asOf }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fx-revaluation"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["journal"] });
    },
  });

  const data = movement.data;
  if (!data) return null;
  const nothing = data.lines.length === 0 && data.missingRates.length === 0;
  if (nothing) return null;

  const net = data.receivableCents - data.payableCents;

  return (
    <Card>
      <SectionHeading>
        Open foreign balances at {formatDate(asOf)}
      </SectionHeading>
      <p className="mb-2 text-sm" style={muted}>
        What is still outstanding in a currency the books are not kept in, at
        what it was worth when it was raised and what it is worth now. Posting
        it puts the difference in the books as an unrealised gain or loss, and
        reverses it on the first day of the next period so nothing compounds.
      </p>
      {data.missingRates.length > 0 ? (
        <p className="mb-2 text-sm" style={{ color: "var(--text-warning)" }}>
          No rate is recorded on or before this date for{" "}
          {data.missingRates.join(", ")}. Record one before revaluing, or the
          figure would be a guess.
        </p>
      ) : null}
      <Table
        headers={[
          "Document",
          { label: "Outstanding", money: true },
          { label: "In the books", money: true },
          { label: "Worth now", money: true },
          { label: "Difference", money: true },
        ]}
      >
        {data.lines.map((line) => (
          <Row key={`${line.kind}-${line.number}-${line.currency}`}>
            <td>
              {line.number ?? "—"}
              <span className="ml-1 text-xs" style={muted}>
                {line.kind === "receivable" ? "owed to you" : "you owe"}
              </span>
            </td>
            <td className="money">
              {formatMoney(line.outstandingCents)} {line.currency}
            </td>
            <td className="money">{formatMoney(line.carryingCents)}</td>
            <td className="money">{formatMoney(line.revaluedCents)}</td>
            <td className="money">{formatMoney(line.differenceCents)}</td>
          </Row>
        ))}
      </Table>
      <Toolbar className="mt-(--gap-stack) justify-between">
        <span className="text-sm" style={muted}>
          {net === 0
            ? `Nothing to post in ${data.baseCurrency}.`
            : net > 0
              ? `A gain of ${formatMoney(net)} ${data.baseCurrency}.`
              : `A loss of ${formatMoney(-net)} ${data.baseCurrency}.`}
        </span>
        <Button
          needs={{ bookkeeping: ["create"] }}
          onClick={() => post.mutate()}
          disabled={
            data.alreadyPosted ||
            data.missingRates.length > 0 ||
            post.isPending ||
            net === 0
          }
        >
          {data.alreadyPosted
            ? "Already revalued to this date"
            : post.isPending
              ? "Posting…"
              : "Post the revaluation"}
        </Button>
      </Toolbar>
      {post.error ? <ErrorNote error={post.error} /> : null}
    </Card>
  );
}

function Breakdown({ title, rows }: { title: string; rows: AccountTotal[] }) {
  /**
   * An account at zero is not a line on a statement.
   *
   * A settled payable reading "$0.00" is noise on the one screen where every
   * line should mean something — and after a few months of trading most of the
   * chart sits at zero.
   */
  const worth = rows.filter((row) => row.balanceCents !== 0);
  if (worth.length === 0) return null;
  return (
    <div className="mt-(--gap-stack)">
      <SectionHeading level={3}>{title}</SectionHeading>
      {worth.map((row) => (
        <div key={row.accountId} className="flex justify-between py-1 text-sm">
          <span>
            <span style={muted}>{row.code}</span> {row.name}
          </span>
          <span className="money">{formatMoney(row.balanceCents)}</span>
        </div>
      ))}
    </div>
  );
}

function Figure({
  label,
  cents,
  emphasise,
}: {
  label: string;
  cents: number;
  emphasise?: boolean;
}) {
  return (
    <Card>
      <StatFigure
        label={label}
        value={formatMoney(cents)}
        tone={emphasise && cents < 0 ? "bad" : "plain"}
      />
    </Card>
  );
}

/**
 * The paper behind a figure.
 *
 * An inspector, an accountant and a bank all ask for the receipt rather than
 * the entry, so a row that has one says so and hands it over, and a row that
 * has none offers to take it.
 *
 * Shared with Bills, which is part of the Pro half loaded on demand below —
 * kept here, in the half every instance already has, so opening the money
 * screen never has to fetch the Pro bundle just to attach a receipt.
 */
export function Receipt({
  holder,
  id,
  has,
  onDone,
}: {
  holder: "transactions" | "bills";
  id: string;
  has: boolean;
  onDone: () => void;
}) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // No content-type header: FormData sets its own with the boundary, and
      // overriding it makes the body unparseable at the other end.
      const res = await fetch(`/api/${holder}/${id}/receipt`, {
        method: "POST",
        body: form,
        credentials: "same-origin",
      });
      if (!res.ok) {
        throw new Error(
          ((await res.json().catch(() => ({}))) as { error?: string }).error ??
            "That file could not be attached.",
        );
      }
    },
    onSuccess: onDone,
  });

  const detach = useMutation({
    mutationFn: () => api(`/api/${holder}/${id}/receipt`, { method: "DELETE" }),
    onSuccess: onDone,
  });

  if (has) {
    return (
      <span className="flex items-center gap-(--gap-toolbar)">
        <a className="link-muted text-xs" href={`/api/${holder}/${id}/receipt`}>
          Receipt
        </a>
        {/*
          Taking one off, which nothing could do. A photo attached to the wrong
          line stayed on it, and re-attaching only replaced one wrong file with
          another. The route was registered from a template and so was invisible
          to every sweep in the platform until today.
        */}
        <button
          type="button"
          className="link-danger text-xs"
          disabled={detach.isPending}
          onClick={() => detach.mutate()}
        >
          remove
        </button>
        {detach.error ? <ErrorNote error={detach.error} /> : null}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-(--gap-toolbar)">
      <label className="link-muted cursor-pointer text-xs">
        {upload.isPending ? "Attaching…" : "Attach"}
        <input
          type="file"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload.mutate(file);
          }}
        />
      </label>
      {upload.error ? <ErrorNote error={upload.error} /> : null}
    </span>
  );
}

/** Money in and money out, where no invoice was involved. */
/** The tabs the reference puts across its transaction list. */
const MONEY_TABS: { id: string; label: string }[] = [
  { id: "", label: "Everything" },
  { id: "income", label: "Money in" },
  { id: "expense", label: "Money out" },
  { id: "transfer", label: "Transfers" },
];

export function Money() {
  const qc = useQueryClient();
  const [kind, setKind] = useState<"expense" | "income">("expense");
  /**
   * What the list is showing, as against what is being added.
   *
   * The server has taken `kind`, `from` and `to` since it was written and the
   * screen never sent any of them, so the only view of the books was
   * everything, newest first. "Fuel, this quarter" is the question a business
   * actually asks its bookkeeping.
   */
  const [tab, setTab] = useState("");
  const [q, setQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [paidThroughAccountId, setPaidThrough] = useState("");
  const [occurredAt, setOccurredAt] = useState("");

  /**
   * The business's own fields, where a licence defines them.
   *
   * The definitions live behind a route in the paid bundle, so they are only
   * asked for on a Pro instance — on Free there are no fields and no request.
   * Only the ones scoped to money in and out appear here; the bill-scoped
   * ones belong to the bundle's own screens. Defining a field for
   * "transaction" and never seeing it on the one form that records a
   * transaction was the gap.
   */
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;
  const customFields = useQuery({
    queryKey: ["accounting-custom-fields"],
    enabled: tier === "pro",
    queryFn: () =>
      api<{ customFields: CustomField[] }>("/api/accounting/custom-fields"),
  });
  const transactionFields = (customFields.data?.customFields ?? []).filter(
    (f) => f.appliesTo === "transaction",
  );
  const [custom, setCustom] = useState<
    Record<string, string | number | boolean | null>
  >({});

  const filter = [
    tab ? `kind=${tab}` : "",
    q.trim() ? `q=${encodeURIComponent(q.trim())}` : "",
    from ? `from=${from}` : "",
    to ? `to=${to}` : "",
  ]
    .filter(Boolean)
    .join("&");

  const transactions = useQuery({
    queryKey: ["transactions", filter],
    queryFn: () =>
      api<{
        transactions: Transaction[];
        totals: { inCents: number; outCents: number; netCents: number };
      }>(`/api/transactions${filter ? `?${filter}` : ""}`),
    placeholderData: (previous) => previous,
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["transactions"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api("/api/transactions", {
        method: "POST",
        body: JSON.stringify({
          kind,
          description: description || null,
          amountCents: toCents(amount),
          accountId: accountId || null,
          paidThroughAccountId: paidThroughAccountId || null,
          occurredAt: occurredAt || null,
          custom,
        }),
      }),
    onSuccess: () => {
      setDescription("");
      setAmount("");
      setOccurredAt("");
      setCustom({});
      refresh();
    },
  });

  const undo = useMutation({
    mutationFn: (id: string) =>
      api(`/api/transactions/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  /**
   * Correcting one that was typed wrong.
   *
   * Until now the only answer to a wrong figure was Undo — which is honest,
   * because it leaves the reversing entry in the ledger, and heavy-handed for
   * a date a day out or a line filed under the wrong category. The server has
   * always taken a correction: it reverses the old journal entry and posts the
   * new one, so the books stay explainable either way. Nothing called it.
   */
  const [editing, setEditing] = useState<Transaction | null>(null);
  const edit = useMutation({
    mutationFn: (input: {
      id: string;
      description: string;
      amount: string;
      accountId: string;
      occurredAt: string;
    }) =>
      api(`/api/transactions/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          description: input.description || null,
          amountCents: toCents(input.amount),
          accountId: input.accountId,
          occurredAt: input.occurredAt || null,
        }),
      }),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const accountName = (id: string | null) =>
    accounts.data?.accounts.find((a) => a.id === id)?.name ?? "—";

  const categoryAccounts = (accounts.data?.accounts ?? []).filter((a) =>
    kind === "expense" ? a.type === "expense" : a.type === "income",
  );
  const cashAccounts = (accounts.data?.accounts ?? []).filter(
    (a) => a.type === "asset",
  );

  return (
    <Page>
      <Card>
        <div className="grid gap-(--gap-toolbar) sm:grid-cols-[8rem_minmax(0,1fr)_8rem_minmax(0,1fr)_minmax(0,1fr)_9rem_auto]">
          <Field label="Kind">
            <Select
              value={kind}
              onChange={(e) => setKind(e.target.value as "expense" | "income")}
            >
              <option value="expense">Money out</option>
              <option value="income">Money in</option>
            </Select>
          </Field>
          <Field label={kind === "expense" ? "Paid to" : "Received from"}>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>
          <Field label="Amount">
            <Input
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>
          <Field label="Category">
            <Select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {categoryAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={kind === "expense" ? "Paid from" : "Paid into"}>
            <Select
              value={paidThroughAccountId}
              onChange={(e) => setPaidThrough(e.target.value)}
            >
              <option value="">Cash</option>
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Date">
            <Input
              type="date"
              value={occurredAt}
              onChange={(e) => setOccurredAt(e.target.value)}
            />
          </Field>
          <CustomFields
            fields={transactionFields}
            values={custom}
            onChange={setCustom}
          />
          <div className="flex items-end">
            <Button
              needs={{ bookkeeping: ["create"] }}
              onClick={() => add.mutate()}
              disabled={add.isPending || !amount}
            >
              Record
            </Button>
          </div>
        </div>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      <Tabs tabs={MONEY_TABS} active={tab} onChange={setTab} />

      <Toolbar>
        <Input
          value={q}
          className="w-56"
          placeholder="Search what it says"
          aria-label="Search transactions"
          onChange={(e) => setQ(e.target.value)}
        />
        <Field label="From">
          <Input
            type="date"
            value={from}
            className="w-40"
            onChange={(e) => setFrom(e.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={to}
            className="w-40"
            onChange={(e) => setTo(e.target.value)}
          />
        </Field>
        {/* What the rows on screen come to. Adding them up by hand off the
            screen is how a business gets a different answer every time. */}
        {transactions.data ? (
          <span className="ml-auto text-sm" style={muted}>
            in {formatMoney(transactions.data.totals.inCents)} · out{" "}
            {formatMoney(transactions.data.totals.outCents)} ·{" "}
            <strong
              style={{
                color:
                  transactions.data.totals.netCents < 0
                    ? "var(--text-danger)"
                    : "var(--text-success)",
              }}
            >
              {formatMoney(transactions.data.totals.netCents)}
            </strong>
          </span>
        ) : null}
      </Toolbar>

      {transactions.isLoading ? <Loading /> : null}
      {transactions.error ? <ErrorNote error={transactions.error} /> : null}
      {transactions.data && transactions.data.transactions.length === 0 ? (
        <Empty title={filter ? "Nothing matches" : "Nothing recorded yet"}>
          {filter
            ? "Try a wider date range, another tab, or part of what the line says."
            : "What you spend and take in goes here, and straight into the profit and loss."}
        </Empty>
      ) : null}
      <CorrectTransaction
        transaction={editing}
        accounts={accounts.data?.accounts ?? []}
        onClose={() => setEditing(null)}
        onSave={(input) => edit.mutate(input)}
        saving={edit.isPending}
        error={edit.error}
      />

      {transactions.data && transactions.data.transactions.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Detail",
            "Category",
            { label: "Amount", money: true },
            "Receipt",
            "",
          ]}
        >
          {transactions.data.transactions.map((t) => (
            <Row key={t.id}>
              <td className="py-2">{formatDate(t.occurredAt)}</td>
              <td style={t.reversedAt ? muted : undefined}>
                {t.description ?? "—"}
                {t.reversedAt ? " (undone)" : ""}
              </td>
              <td>{accountName(t.accountId)}</td>
              <td className="money">
                {t.kind === "expense" ? "−" : ""}
                {formatMoney(t.amountCents)}
              </td>
              <td>
                <Receipt
                  holder="transactions"
                  id={t.id}
                  has={Boolean(t.receiptFileKey)}
                  onDone={refresh}
                />
              </td>
              {/*
                Behind one menu, like every other row. Written into the row,
                the two of them put "Undo" in the danger colour on every line
                of the ledger — on the screen somebody opens to read what the
                business spent.

                And Undo asked nothing. It posts a reversing entry, so the
                books stay explainable and nothing is lost, but it is still a
                journal entry made on one press by somebody who might have
                meant Correct — which is the item directly above it.
              */}
              <td className="text-right">
                {t.reversedAt ? null : (
                  <RowMenu label={t.description ?? formatDate(t.occurredAt)}>
                    {(close) => (
                      <>
                        <MenuItem
                          needs={{ bookkeeping: ["update"] }}
                          onClick={() => {
                            close();
                            setEditing(t);
                          }}
                        >
                          Correct
                        </MenuItem>
                        <ConfirmButton
                          title="Undo this entry?"
                          message="A reversing entry is posted against it, so the books still show what happened and why. Nothing is deleted. If the figure or the category is simply wrong, Correct it instead."
                          confirmLabel="Undo it"
                          danger
                          needs={{ bookkeeping: ["delete"] }}
                          onConfirm={() => undo.mutate(t.id)}
                        >
                          Undo
                        </ConfirmButton>
                      </>
                    )}
                  </RowMenu>
                )}
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
      {undo.error ? <ErrorNote error={undo.error} /> : null}
    </Page>
  );
}

type ChartAccount = Account & { archivedAt: string | null };

/**
 * What the find box leaves, with every ancestor of a match kept.
 *
 * A tree filtered by matching alone loses the branch a match hangs from, and
 * `inTreeOrder` drops a child whose parent is not present — so searching for
 * "6100" would have shown nothing at all when its parent did not match the
 * same text. Keeping the ancestors is what makes the result still a chart
 * rather than a list of orphans.
 */
export function matchingAccounts<
  T extends {
    id: string;
    code: string;
    name: string;
    parentId?: string | null;
  },
>(rows: T[], term: string): T[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return rows;
  const byId = new Map(rows.map((a) => [a.id, a]));
  const keep = new Set<string>();
  for (const account of rows) {
    if (!`${account.code} ${account.name}`.toLowerCase().includes(needle)) {
      continue;
    }
    let at: T | undefined = account;
    while (at && !keep.has(at.id)) {
      keep.add(at.id);
      at = at.parentId ? byId.get(at.parentId) : undefined;
    }
  }
  return rows.filter((a) => keep.has(a.id));
}

/**
 * The chart in the order an accountant reads it: parents by code, children
 * under their parent.
 *
 * An account whose parent is missing from the list — archived, while the
 * child is not — is shown at the top rather than dropped. A chart that
 * silently loses a row is worse than one that is slightly untidy.
 */
export function inTreeOrder(
  accounts: ChartAccount[],
): { account: ChartAccount; depth: number }[] {
  const byParent = new Map<string, ChartAccount[]>();
  const present = new Set(accounts.map((account) => account.id));
  for (const account of accounts) {
    const key =
      account.parentId && present.has(account.parentId) ? account.parentId : "";
    byParent.set(key, [...(byParent.get(key) ?? []), account]);
  }

  const out: { account: ChartAccount; depth: number }[] = [];
  const walk = (key: string, depth: number) => {
    // Bounded because data can be edited outside the screen, and a chart that
    // never finishes rendering is a page nobody can close.
    if (depth > 12) return;
    for (const account of (byParent.get(key) ?? []).sort((a, b) =>
      a.code.localeCompare(b.code),
    )) {
      out.push({ account, depth });
      walk(account.id, depth + 1);
    }
  };
  walk("", 0);
  return out;
}

export function Accounts() {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState("expense");
  /** The new-account dialog, which used to be a form standing on the page. */
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  /**
   * Narrowing the chart, in the browser.
   *
   * **Deliberately not the list machinery the other Money lists use.** A
   * chart of accounts is dozens of rows, not thousands; ten places across
   * three screens read `/api/accounts` to fill a picker, and paging it would
   * quietly offer them the first twenty-five accounts; and this screen draws
   * a tree, where a parent falling off a page orphans its children. All three
   * are silent failures — a dropdown missing an account and a tree missing a
   * branch both look like working screens.
   *
   * So the search stays here, over rows already fetched, and the server keeps
   * answering with the whole chart.
   */
  const [find, setFind] = useState("");

  const accounts = useQuery({
    queryKey: ["accounts", showArchived],
    queryFn: () =>
      api<{ accounts: (Account & { archivedAt: string | null })[] }>(
        `/api/accounts${showArchived ? "?archived=1" : ""}`,
      ),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["accounts"] });
    // The balances are a second query over the same thing; refreshing one and
    // not the other is how a deleted account keeps its figure on the screen.
    qc.invalidateQueries({ queryKey: ["account-balances"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api("/api/accounts", {
        method: "POST",
        body: JSON.stringify({ code, name, type }),
      }),
    onSuccess: () => {
      setCode("");
      setName("");
      refresh();
    },
  });

  const standard = useMutation({
    mutationFn: () => api("/api/accounts/standard", { method: "POST" }),
    onSuccess: refresh,
  });

  /**
   * What is in each account.
   *
   * The chart listed every account and told you nothing about any of them,
   * which makes it a form rather than a report — "is 6100 the one we actually
   * use" is answered by the balance and by nothing else on this screen. The
   * route computed it from the journal and was fetched by nothing.
   *
   * Signed the way an accountant reads it: assets and expenses positive when
   * debited, everything else positive when credited, so no figure here needs a
   * minus sign explaining that liabilities work the other way round.
   */
  const balances = useQuery({
    queryKey: ["account-balances"],
    queryFn: () =>
      api<{ balances: { id: string; balanceCents: number }[] }>(
        "/api/accounts/balances",
      ),
  });
  const balanceOf = (id: string) =>
    balances.data?.balances.find((b) => b.id === id)?.balanceCents;

  const archive = useMutation({
    mutationFn: (input: { id: string; archived: boolean }) =>
      api(`/api/accounts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ archived: input.archived }),
      }),
    onSuccess: refresh,
  });

  /**
   * Filing an account under another.
   *
   * A chart of accounts is a tree in every accountant's head — Utilities under
   * Premises — even where the numbering already implies it. The server refuses
   * a loop however far round it goes, so this can offer every other account of
   * the same type and let it say no.
   */
  const reparent = useMutation({
    mutationFn: (input: { id: string; parentId: string }) =>
      api(`/api/accounts/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ parentId: input.parentId || null }),
      }),
    onSuccess: refresh,
  });

  /**
   * Removing one that was a mistake.
   *
   * Archiving is the right answer for an account with history, and the server
   * says so: it refuses to delete anything carrying postings or holding other
   * accounts under it. What was missing was the answer for the other case — a
   * code typed wrong five minutes ago, which archiving leaves in the chart for
   * ever. The route has always existed with nothing calling it.
   */
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/accounts/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  if (accounts.isLoading) return <Loading />;
  if (accounts.error) return <ErrorNote error={accounts.error} />;
  const rows = accounts.data?.accounts ?? [];
  const shown = matchingAccounts(rows, find);

  return (
    <Page>
      {/*
       * The new-account form is behind a button, not standing on the page.
       *
       * It was mounted permanently at the top, so the first thing anybody saw
       * on a screen whose job is to show a chart of accounts was four empty
       * boxes for an account they had probably already made — and the chart
       * itself started below the fold on a laptop.
       *
       * Same fault the Forms screen had and the same fix: the action goes in
       * the page's own title line and the form is a dialog behind it.
       */}
      <PageActions>
        {/*
          Primary, like every other page action in the product. It was the
          quiet one while a one-time setup helper below it carried the loud
          treatment — so the screen drew the eye to a button you press once
          and never again, and greyed the one you came here for.
        */}
        <Button onClick={() => setAdding(true)}>New account</Button>
      </PageActions>

      <Dialog
        title="New account"
        open={adding}
        onClose={() => setAdding(false)}
      >
        <div className="flex flex-col gap-(--gap-stack)">
          <div className="grid gap-(--gap-toolbar) sm:grid-cols-[7rem_minmax(0,1fr)]">
            <Field label="Code">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="6100"
              />
            </Field>
            <Field label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value)}>
              {["asset", "liability", "equity", "income", "expense"].map(
                (t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ),
              )}
            </Select>
          </Field>
          {add.error ? <ErrorNote error={add.error} /> : null}
          <Toolbar>
            <Button
              needs={{ bookkeeping: ["create"] }}
              onClick={() => add.mutate()}
              disabled={add.isPending || !code || !name}
            >
              {add.isPending ? "Adding…" : "Add account"}
            </Button>
          </Toolbar>
        </div>
      </Dialog>

      <Card>
        <Toolbar>
          <Button
            variant="secondary"
            needs={{ bookkeeping: ["create"] }}
            onClick={() => standard.mutate()}
            disabled={standard.isPending}
          >
            Fill in the standard chart
          </Button>
          <label
            className="flex items-center gap-(--gap-tight) text-xs"
            style={muted}
          >
            <input
              type="checkbox"
              checked={showArchived}
              onChange={(e) => setShowArchived(e.target.checked)}
            />
            Show archived
          </label>
        </Toolbar>
        <p className="mt-2 text-xs" style={muted}>
          The accounts Sentrello needs are created for you the first time they
          are used. The standard chart adds the ones a small business usually
          wants, and never adds one twice.
        </p>
        {standard.error ? <ErrorNote error={standard.error} /> : null}
      </Card>

      <Toolbar>
        <Input
          value={find}
          aria-label="Find an account"
          placeholder="Find a code or a name"
          className="w-56"
          onChange={(e) => setFind(e.target.value)}
        />
        {find ? (
          <Button variant="secondary" onClick={() => setFind("")}>
            Clear
          </Button>
        ) : null}
        <span className="ml-auto text-sm" style={muted}>
          {shown.length} of {rows.length}
        </span>
      </Toolbar>

      {shown.length === 0 ? (
        <Empty title={find ? "No account matches that" : "No accounts yet"} />
      ) : (
        <Table
          headers={[
            "Code",
            "Name",
            "Type",
            { label: "Balance", money: true },
            "Under",
            "",
          ]}
        >
          {inTreeOrder(shown).map(({ account: a, depth }) => (
            <Row key={a.id}>
              <td className="py-2 font-medium">{a.code}</td>
              <td style={a.archivedAt ? muted : undefined}>
                <span style={{ paddingLeft: `${depth * 1.25}rem` }}>
                  {depth > 0 ? "↳ " : ""}
                  {a.name}
                </span>
              </td>
              <td style={muted}>{a.type}</td>
              <td className="money">
                {balanceOf(a.id) === undefined
                  ? "—"
                  : formatMoney(balanceOf(a.id) as number)}
              </td>
              <td>
                <Select
                  needs={{ bookkeeping: ["update"] }}
                  value={a.parentId ?? ""}
                  // A column of identical dropdowns announces as "combo box"
                  // forty times over without this. The account's own name is
                  // what tells them apart.
                  aria-label={`Parent account for ${a.name}`}
                  onChange={(e) =>
                    reparent.mutate({ id: a.id, parentId: e.target.value })
                  }
                >
                  <option value="">On its own</option>
                  {rows
                    .filter(
                      (other) => other.id !== a.id && other.type === a.type,
                    )
                    .map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.code} {other.name}
                      </option>
                    ))}
                </Select>
              </td>
              {/*
                Behind one menu, like every other row in the product. Written
                out, the two of them put the word "Delete" in the danger
                colour twenty-five times down the right edge of the chart of
                accounts — which made deleting the loudest thing on a screen
                somebody opens to read a balance.
              */}
              <td className="text-right">
                <RowMenu label={`${a.code} ${a.name}`}>
                  {(close) => (
                    <>
                      <MenuItem
                        needs={{ bookkeeping: ["update"] }}
                        onClick={() => {
                          close();
                          archive.mutate({
                            id: a.id,
                            archived: !a.archivedAt,
                          });
                        }}
                      >
                        {a.archivedAt ? "Restore" : "Archive"}
                      </MenuItem>
                      {/*
                        Offered on every account, and refused by the server
                        where it must be: "this account has postings against
                        it — archive it instead so the history stays" is a
                        better answer than a missing button, because it says
                        what to do next. Whether an account has postings is
                        not on this screen — a zero balance is not an empty
                        account, since debits and credits can cancel — so
                        hiding it would mean hiding it from the wrong rows.
                      */}
                      <ConfirmButton
                        title="Delete this account?"
                        message="It leaves the chart for good. An account with postings against it, or with accounts under it, is refused — archive that one instead and the history stays."
                        confirmLabel="Delete it"
                        danger
                        needs={{ bookkeeping: ["delete"] }}
                        disabled={remove.isPending}
                        onConfirm={() => remove.mutate(a.id)}
                      >
                        Delete
                      </ConfirmButton>
                    </>
                  )}
                </RowMenu>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {reparent.error ? <ErrorNote error={reparent.error} /> : null}
      {archive.error ? <ErrorNote error={archive.error} /> : null}
      {/* "archive it instead so the history stays" is the useful half. */}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </Page>
  );
}

type JournalLine = {
  id: string;
  memo: string | null;
  source: string | null;
  postedAt: string;
  /** Who put it in the books, where a person did. */
  postedBy: string | null;
  debitCents: number;
  creditCents: number;
  accountCode: string | null;
  accountName: string | null;
};

/** One entry, with the lines that balance inside it. */
type JournalEntry = {
  id: string;
  memo: string | null;
  source: string | null;
  postedAt: string;
  postedBy: string | null;
  lines: JournalLine[];
};

/**
 * The rows come back one line at a time, and an entry is the unit.
 *
 * A journal is read entry by entry — a date, what it was for, and the lines
 * that balance inside it. Flat rows read as a list of halves, and there is no
 * single thing to reverse.
 */
function asEntries(lines: JournalLine[]): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const seen = new Map<string, JournalEntry>();
  for (const line of lines) {
    let entry = seen.get(line.id);
    if (!entry) {
      entry = {
        id: line.id,
        memo: line.memo,
        source: line.source,
        postedAt: line.postedAt,
        postedBy: line.postedBy,
        lines: [],
      };
      seen.set(line.id, entry);
      // Pushed in the order they arrive, which is the order the route sorted
      // them in. Rebuilding the sort here is a second chance to disagree.
      entries.push(entry);
    }
    entry.lines.push(line);
  }
  return entries;
}

/** Somebody typed this one; everything else was recorded by something. */
function postedByHand(entry: JournalEntry): boolean {
  return (entry.source ?? "").startsWith("manual:");
}

/** And this one undoes another. */
function isReversal(entry: JournalEntry): boolean {
  return (entry.source ?? "").startsWith("reversal:");
}

/**
 * The journal, which is what every figure above is made of.
 *
 * Nearly every entry arrives because something happened — an invoice issued, a
 * bill paid, a card taken — so the books cannot normally hold a figure no
 * document explains. The exception is the adjusting entry: depreciation, an
 * accrual, a correction, a debt written off. None of those is an event in the
 * business and all of them are needed, so a Pro instance can post one and
 * every one it posts says so.
 *
 * **Nothing here is ever edited or deleted.** A mistake is reversed, which is
 * what an auditor expects to find and the only version that survives being
 * checked.
 */
export function Journal() {
  const [composing, setComposing] = useState(false);
  /*
   * A page at a time, through the same list state every other screen uses.
   *
   * This used to ask for the whole ledger — every line the business had ever
   * posted — which at five years of trading is a 356 MB response the browser
   * cannot render and the server cannot build without taking the box with it.
   */
  const state = useListState({ sort: "postedAt", order: "desc" });
  /**
   * The chart, for the account filter.
   *
   * The whole list rather than a search: a chart of accounts is dozens of
   * rows, not thousands, and a select somebody can read down beats a box they
   * have to know the name to type into.
   */
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });
  const query = listQueryString(state, true);
  const journal = useQuery({
    queryKey: ["journal", query],
    queryFn: () =>
      api<{
        lines: JournalLine[];
        mayPost?: boolean;
        total: number;
      }>(`/api/journal?${query}`),
    // The page on screen stays while the next one loads, so a keystroke in
    // the search box does not blank the ledger to a spinner.
    placeholderData: (previous) => previous,
  });

  if (journal.isLoading) return <Loading />;
  if (journal.error) return <ErrorNote error={journal.error} />;

  const entries = asEntries(journal.data?.lines ?? []);
  const total = journal.data?.total ?? entries.length;
  // Asked of the server: a Free instance has no route to post to, and a person
  // without `bookkeeping.create` would be offered a button that answers 403.
  const mayPost = journal.data?.mayPost === true;

  return (
    <Page>
      {mayPost ? (
        <>
          <PageActions>
            <Button onClick={() => setComposing(true)} disabled={composing}>
              New entry
            </Button>
          </PageActions>
          {composing ? <NewEntry onDone={() => setComposing(false)} /> : null}
        </>
      ) : null}

      {/*
       * What the ledger can be asked.
       *
       * A business arrives here knowing what it wants — a figure it has to
       * explain, on a date, against an account. It had a page number and
       * nothing else while every other list had all of this.
       */}
      <Toolbar>
        <Input
          value={state.q}
          onChange={(e) => state.setQ(e.target.value)}
          placeholder="Search notes"
          aria-label="Search the journal"
          className="w-56"
        />

        <Input
          type="date"
          aria-label="Posted from"
          className="w-40"
          value={state.filters.from ?? ""}
          onChange={(e) =>
            state.setFilter({ from: e.target.value || undefined })
          }
        />
        <Input
          type="date"
          aria-label="Posted to"
          className="w-40"
          value={state.filters.to ?? ""}
          onChange={(e) => state.setFilter({ to: e.target.value || undefined })}
        />

        <Select
          aria-label="Filter by account"
          className="w-56"
          value={state.filters.accountId ?? ""}
          onChange={(e) =>
            state.setFilter({ accountId: e.target.value || undefined })
          }
        >
          <option value="">Any account</option>
          {(accounts.data?.accounts ?? []).map((account) => (
            <option key={account.id} value={account.id}>
              {account.code} {account.name}
            </option>
          ))}
        </Select>

        <SortMenu
          state={state}
          fields={[{ field: "postedAt", label: "Date posted", order: "desc" }]}
        />

        <SavedViews
          resource="journal"
          state={state}
          defaults={{ sort: "postedAt", order: "desc" }}
        />

        {state.hasFilters || state.q ? (
          <Button
            variant="secondary"
            onClick={() => {
              state.clearFilters();
              state.setQ("");
            }}
          >
            Clear
          </Button>
        ) : null}

        <span className="ml-auto text-sm" style={muted}>
          {total} {total === 1 ? "entry" : "entries"}
        </span>
      </Toolbar>

      {entries.length === 0 ? (
        <Empty
          title={
            state.hasFilters || state.q
              ? "Nothing matches that"
              : "Nothing posted yet"
          }
        />
      ) : (
        <>
          {entries.map((entry) => (
            <EntryCard key={entry.id} entry={entry} mayPost={mayPost} />
          ))}
          {total > PAGINATION_THRESHOLD ? (
            <Pagination state={state} total={total} />
          ) : null}
        </>
      )}
    </Page>
  );
}

/** One entry: what it was for, what it moved, and how to undo it. */
function EntryCard({
  entry,
  mayPost,
}: {
  entry: JournalEntry;
  mayPost: boolean;
}) {
  const qc = useQueryClient();
  const reverse = useMutation({
    mutationFn: () =>
      api(`/api/journal/entries/${entry.id}/reverse`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["journal"] }),
  });

  const byHand = postedByHand(entry);

  return (
    <Card>
      <div className="flex flex-wrap items-baseline justify-between gap-(--gap-toolbar)">
        <div>
          <span className="font-medium">{entry.memo ?? "—"}</span>{" "}
          <span style={muted}>{formatDate(entry.postedAt)}</span>
          {/**
           * Who put the figure in the books, where a person did.
           *
           * Absent on everything a job or a webhook wrote, which is most of
           * the ledger and is the honest answer: a nightly depreciation run is
           * not a person, and inventing one would be worse than saying nothing.
           */}
          {entry.postedBy ? (
            <span className="ml-2 text-xs" style={muted}>
              by {entry.postedBy}
            </span>
          ) : null}
          {byHand ? (
            <span className="ml-2 text-xs" style={muted}>
              posted by hand
            </span>
          ) : null}
          {isReversal(entry) ? (
            <span className="ml-2 text-xs" style={muted}>
              a reversal
            </span>
          ) : null}
        </div>
        {/**
         * Offered on entries somebody posted, not on the ones behind an
         * invoice or a payment.
         *
         * Reversing those would leave the books disagreeing with the document
         * that made them, and the fix for a wrong invoice is a credit note
         * rather than a journal entry nobody can trace back.
         */}
        {mayPost && byHand ? (
          <Button
            variant="secondary"
            needs={{ bookkeeping: ["create"] }}
            disabled={reverse.isPending}
            onClick={() => reverse.mutate()}
          >
            {reverse.isPending ? "Reversing…" : "Reverse"}
          </Button>
        ) : null}
      </div>

      <Table
        headers={[
          "Account",
          { label: "Debit", money: true },
          { label: "Credit", money: true },
        ]}
      >
        {entry.lines.map((line, i) => (
          <Row key={`${line.id}-${i}`}>
            <td className="py-2">
              {line.accountCode ? (
                <>
                  <span style={muted}>{line.accountCode}</span>{" "}
                  {line.accountName}
                </>
              ) : (
                "—"
              )}
            </td>
            <td className="money">
              {line.debitCents ? formatMoney(line.debitCents) : ""}
            </td>
            <td className="money">
              {line.creditCents ? formatMoney(line.creditCents) : ""}
            </td>
          </Row>
        ))}
      </Table>
      {reverse.error ? <ErrorNote error={reverse.error} /> : null}
    </Card>
  );
}

/** A line being typed, before it is money. */
type DraftLine = { accountId: string; debit: string; credit: string };

const EMPTY_LINE: DraftLine = { accountId: "", debit: "", credit: "" };

/**
 * Writing an adjusting entry.
 *
 * The one screen in the module that puts a figure in the books with no
 * document behind it, so it says what it is out by while it is being typed
 * rather than refusing at the end. Somebody entering depreciation across four
 * accounts should not have to find a fifty-cent difference by rereading their
 * own typing.
 */
function NewEntry({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [memo, setMemo] = useState("");
  const [postedAt, setPostedAt] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([EMPTY_LINE, EMPTY_LINE]);

  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const setLine = (index: number, patch: Partial<DraftLine>) =>
    setLines((old) =>
      old.map((line, i) => (i === index ? { ...line, ...patch } : line)),
    );

  const debits = lines.reduce((n, l) => n + toCents(l.debit), 0);
  const credits = lines.reduce((n, l) => n + toCents(l.credit), 0);
  const difference = debits - credits;
  const usable = lines.filter((l) => l.accountId && (l.debit || l.credit));

  const post = useMutation({
    mutationFn: () =>
      api("/api/journal/entries", {
        method: "POST",
        body: JSON.stringify({
          memo,
          // Left off entirely when nothing was typed, so the server dates it
          // now rather than being handed an empty string to interpret.
          ...(postedAt ? { postedAt: new Date(postedAt).toISOString() } : {}),
          lines: usable.map((line) => ({
            accountId: line.accountId,
            ...(toCents(line.debit) > 0
              ? { debitCents: toCents(line.debit) }
              : {}),
            ...(toCents(line.credit) > 0
              ? { creditCents: toCents(line.credit) }
              : {}),
          })),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["journal"] });
      // Everything downstream reads the ledger, so the figures on the other
      // screens are wrong until they are asked again.
      qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      onDone();
    },
  });

  const ready =
    memo.trim().length > 0 && usable.length >= 2 && difference === 0;

  return (
    <Card className="flex flex-col gap-(--gap-stack)">
      <Toolbar>
        <Field label="What this entry is for">
          <Input
            value={memo}
            placeholder="Depreciation, September"
            onChange={(e) => setMemo(e.target.value)}
          />
        </Field>
        <Field label="Date" hint="Left blank, it is dated today.">
          <Input
            type="date"
            value={postedAt}
            onChange={(e) => setPostedAt(e.target.value)}
          />
        </Field>
      </Toolbar>

      <Table
        headers={[
          "Account",
          { label: "Debit", money: true },
          { label: "Credit", money: true },
        ]}
      >
        {lines.map((line, i) => (
          // The rows have no identity of their own — they are positions in a
          // list being typed into, and two blank ones are the same row.
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
          <Row key={i}>
            <td className="py-2">
              <Select
                value={line.accountId}
                aria-label={`Account for line ${i + 1}`}
                onChange={(e) => setLine(i, { accountId: e.target.value })}
              >
                <option value="">Choose an account…</option>
                {(accounts.data?.accounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </td>
            <td className="money">
              <Input
                inputMode="decimal"
                value={line.debit}
                // A line is one or the other, so typing in this side clears
                // the other rather than being refused after the fact.
                onChange={(e) =>
                  setLine(i, { debit: e.target.value, credit: "" })
                }
              />
            </td>
            <td className="money">
              <Input
                inputMode="decimal"
                value={line.credit}
                onChange={(e) =>
                  setLine(i, { credit: e.target.value, debit: "" })
                }
              />
            </td>
          </Row>
        ))}
      </Table>

      <Toolbar className="justify-between">
        <span style={muted}>
          {difference === 0
            ? `Balanced at ${formatMoney(debits)}`
            : `Out by ${formatMoney(Math.abs(difference))} — ${
                difference > 0 ? "debits" : "credits"
              } are over`}
        </span>
        <div className="flex gap-(--gap-toolbar)">
          <Button
            variant="secondary"
            onClick={() => setLines((old) => [...old, EMPTY_LINE])}
          >
            Add a line
          </Button>
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            needs={{ bookkeeping: ["create"] }}
            disabled={!ready || post.isPending}
            onClick={() => post.mutate()}
          >
            {post.isPending ? "Posting…" : "Post entry"}
          </Button>
        </div>
      </Toolbar>
      {post.error ? <ErrorNote error={post.error} /> : null}
    </Card>
  );
}
