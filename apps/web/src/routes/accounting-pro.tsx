import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { type Account, api } from "../lib/api";
import type { CustomField } from "../lib/crm-settings";
import { CustomFieldEditor, CustomFields } from "../lib/custom-fields";
import { toCents } from "../lib/money";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  StatusBadge,
  Table,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The half of Accounting a licence pays for.
 *
 * Bills, banking and budgets, on the same nav entry and the same ledger as the
 * Free half. A business that upgrades finds more of the screen it already
 * knows, not a second Accounting somewhere else.
 */

type Bill = {
  id: string;
  number: string | null;
  vendorId: string | null;
  status: string;
  currency: string;
  billDate: string;
  dueDate: string | null;
  totalCents: number;
  paidCents: number;
  balanceDue: number;
  receiptFileKey: string | null;
};

type Vendor = { id: string; name: string };

type BillLine = {
  id: string;
  description: string;
  quantityMilli: number;
  unitPriceCents: number;
  taxRateBp: number;
  accountId: string | null;
};

type BillPayment = {
  id: string;
  amountCents: number;
  withheldCents: number;
  paidAt: string;
  method: string | null;
  reference: string | null;
};

type Schedule = {
  id: string;
  name: string | null;
  interval: string;
  intervalCount: number;
  nextRunAt: string;
  generatedCount: number;
  active: boolean;
  templateBillId: string;
};

/**
 * The paper behind a figure.
 *
 * An inspector, an accountant and a bank all ask for the receipt rather than
 * the entry, so a row that has one says so and hands it over, and a row that
 * has none offers to take it.
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
      <span className="flex items-center gap-2">
        <a
          className="text-xs underline"
          href={`/api/${holder}/${id}/receipt`}
          style={muted}
        >
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
          className="text-xs underline"
          style={muted}
          disabled={detach.isPending}
          onClick={() => detach.mutate()}
        >
          remove
        </button>
      </span>
    );
  }
  return (
    <label className="cursor-pointer text-xs underline" style={muted}>
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
  );
}

/**
 * What a bill is actually made of.
 *
 * The list answers "what do we owe"; this answers "what for, and what have we
 * already paid" — which is the question somebody has open when the supplier
 * telephones.
 */
function BillDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["bill", id],
    queryFn: () =>
      api<{ lines: BillLine[]; payments: BillPayment[] }>(`/api/bills/${id}`),
  });

  if (detail.isLoading) return <Loading />;
  if (detail.error) return <ErrorNote error={detail.error} />;
  const { lines = [], payments = [] } = detail.data ?? {};

  return (
    <div className="space-y-3 px-2 py-3">
      <Table
        headers={[
          "Line",
          "Quantity",
          { label: "Each", money: true },
          "Tax",
          { label: "Line total", money: true },
        ]}
      >
        {lines.map((line) => (
          <Row key={line.id}>
            <td className="py-2">{line.description}</td>
            <td style={muted}>{line.quantityMilli / 1000}</td>
            <td className="money">{formatMoney(line.unitPriceCents)}</td>
            <td style={muted}>
              {line.taxRateBp ? `${(line.taxRateBp / 100).toFixed(2)}%` : "—"}
            </td>
            <td className="money">
              {formatMoney(
                Math.round((line.quantityMilli / 1000) * line.unitPriceCents),
              )}
            </td>
          </Row>
        ))}
      </Table>

      {payments.length > 0 ? (
        <Table
          headers={[
            "Paid",
            { label: "Amount", money: true },
            { label: "Withheld", money: true },
            "How",
          ]}
        >
          {payments.map((payment) => (
            <Row key={payment.id}>
              <td className="py-2">{formatDate(payment.paidAt)}</td>
              <td className="money">{formatMoney(payment.amountCents)}</td>
              <td className="money">
                {payment.withheldCents
                  ? formatMoney(payment.withheldCents)
                  : "—"}
              </td>
              <td style={muted}>{payment.method ?? "—"}</td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-xs" style={muted}>
          Nothing paid against it yet.
        </p>
      )}
    </div>
  );
}

/**
 * The fields this business keeps on its bills and its money in and out.
 *
 * A purchase-order number, a job reference, which van the fuel went into. The
 * editor and the rules are the platform's, shared with the CRM — what differs
 * is only which records the accounting module has.
 */
function AccountingCustomFields() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<CustomField[] | null>(null);

  const stored = useQuery({
    queryKey: ["accounting-custom-fields"],
    queryFn: () =>
      api<{ customFields: CustomField[] }>("/api/accounting/custom-fields"),
  });

  const save = useMutation({
    mutationFn: (fields: CustomField[]) =>
      api("/api/accounting/custom-fields", {
        method: "PUT",
        body: JSON.stringify({ customFields: fields }),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["accounting-custom-fields"] });
    },
  });

  const fields = draft ?? stored.data?.customFields ?? [];

  return (
    <div className="space-y-2">
      <CustomFieldEditor
        fields={fields}
        onChange={setDraft}
        subjects={ACCOUNTING_SUBJECTS}
        title="Your own fields"
        hint="Anything your business is asked about that the books do not ship with — a purchase order, a job number, which van. They appear on the form and on the record."
      />
      {draft ? (
        <div className="flex items-center gap-2">
          <Button disabled={save.isPending} onClick={() => save.mutate(draft)}>
            {save.isPending ? "Saving…" : "Save the fields"}
          </Button>
          <Button variant="secondary" onClick={() => setDraft(null)}>
            Cancel
          </Button>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </div>
      ) : null}
    </div>
  );
}

type Dimension = {
  id: string;
  kind: string;
  name: string;
  code: string | null;
  archivedAt: string | null;
};

/**
 * Which part of the business a figure belongs to.
 *
 * A builder wants to know whether the kitchen job made money; a shop with two
 * branches wants each one on its own. A chart of accounts cannot answer either
 * — it says *what* was spent, not *which part of the business* spent it — so a
 * business without these invents "Fuel — Branch A" and "Fuel — Branch B" and
 * doubles its chart every time it opens a shop.
 */
function Dimensions() {
  const qc = useQueryClient();
  const [kind, setKind] = useState("class");
  const [name, setName] = useState("");

  const dimensions = useQuery({
    queryKey: ["dimensions"],
    queryFn: () => api<{ dimensions: Dimension[] }>("/api/dimensions"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["dimensions"] });

  const add = useMutation({
    mutationFn: () =>
      api("/api/dimensions", {
        method: "POST",
        body: JSON.stringify({ kind, name }),
      }),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) =>
      api(`/api/dimensions/${id}/archive`, { method: "POST" }),
    onSuccess: refresh,
  });

  const of = (which: string) =>
    (dimensions.data?.dimensions ?? []).filter((d) => d.kind === which);

  return (
    <Card className="space-y-3">
      <div>
        <p className="text-sm font-medium">Jobs, departments and places</p>
        <p className="text-sm" style={muted}>
          Tag what you spend and earn, and every report can be asked for one job
          or one branch at a time — without a second copy of every account.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Kind">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="class">a job, project or department</option>
            <option value="location">a branch, van or site</option>
          </Select>
        </Field>
        <Field label="Called">
          <Input
            value={name}
            placeholder="Kitchen job"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Button
          disabled={add.isPending || !name.trim()}
          onClick={() => add.mutate()}
        >
          Add
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}

      <div className="grid gap-4 sm:grid-cols-2">
        {[
          ["class", "Jobs and departments"],
          ["location", "Branches and sites"],
        ].map(([which, title]) => (
          <div key={which}>
            <p className="mb-1 text-sm font-medium">{title}</p>
            {of(which as string).length === 0 ? (
              <p className="text-sm" style={muted}>
                None yet.
              </p>
            ) : (
              <ul className="space-y-1 text-sm">
                {of(which as string).map((d) => (
                  <li key={d.id} className="flex justify-between">
                    <span>{d.name}</span>
                    {/**
                     * Retired, never deleted: a job that ended still has a
                     * year of figures posted against it.
                     */}
                    <button
                      type="button"
                      className="text-xs underline"
                      disabled={archive.isPending}
                      onClick={() => archive.mutate(d.id)}
                    >
                      finished
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      {dimensions.error ? <ErrorNote error={dimensions.error} /> : null}
      {archive.error ? <ErrorNote error={archive.error} /> : null}
    </Card>
  );
}

/** What an accounting field can be attached to, in the order offered. */
const ACCOUNTING_SUBJECTS = [
  { value: "bill", label: "Bills" },
  { value: "transaction", label: "Money in and out" },
];

type VendorCredit = {
  id: string;
  vendorId: string | null;
  number: string | null;
  issuedAt: string;
  amountCents: number;
  expenseAccountId: string;
  voidedAt: string | null;
  appliedCents: number;
  remainingCents: number;
};

type CreditApplication = {
  id: string;
  creditId: string;
  billId: string;
  amountCents: number;
};

/**
 * What the supplier credited, which is not what they were paid.
 *
 * Goods went back or a bill was overcharged: the business owes less and no
 * money moved. Recording it as a payment makes every future bank
 * reconciliation wrong; recording nothing leaves a bill on the payables report
 * that nobody owes. Neither is available from this screen — a credit is its
 * own thing, and it goes on a bill when somebody decides which.
 */
function VendorCredits({
  bills,
  vendors,
  accounts,
  onChange,
}: {
  bills: Bill[];
  vendors: Vendor[];
  accounts: Account[];
  onChange: () => void;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    vendorId: "",
    number: "",
    amount: "",
    expenseAccountId: "",
  });

  const credits = useQuery({
    queryKey: ["vendor-credits"],
    queryFn: () =>
      api<{ credits: VendorCredit[]; applications: CreditApplication[] }>(
        "/api/vendor-credits",
      ),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vendor-credits"] });
    onChange();
  };

  const save = useMutation({
    mutationFn: () =>
      api("/api/vendor-credits", {
        method: "POST",
        body: JSON.stringify({
          vendorId: draft.vendorId || null,
          number: draft.number || null,
          amountCents: toCents(draft.amount),
          expenseAccountId: draft.expenseAccountId,
        }),
      }),
    onSuccess: () => {
      setDraft({ vendorId: "", number: "", amount: "", expenseAccountId: "" });
      setOpen(false);
      refresh();
    },
  });

  const apply = useMutation({
    mutationFn: (input: { creditId: string; billId: string }) =>
      api(`/api/vendor-credits/${input.creditId}/apply`, {
        method: "POST",
        body: JSON.stringify({ billId: input.billId }),
      }),
    onSuccess: refresh,
  });

  const unapply = useMutation({
    mutationFn: (id: string) =>
      api(`/api/vendor-credits/applications/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const cancel = useMutation({
    mutationFn: (id: string) =>
      api(`/api/vendor-credits/${id}/void`, { method: "POST" }),
    onSuccess: refresh,
  });

  const rows = credits.data?.credits ?? [];
  const applications = credits.data?.applications ?? [];
  // Only bills somebody still owes money on can take one.
  const owing = bills.filter(
    (bill) =>
      (bill.status === "open" || bill.status === "partial") &&
      bill.balanceDue > 0,
  );

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Credits from suppliers</p>
        <Button variant="secondary" onClick={() => setOpen(!open)}>
          {open ? "Cancel" : "Record a credit"}
        </Button>
      </div>

      {open ? (
        <div className="mb-3 flex flex-wrap items-end gap-3 border-b pb-3">
          <Field label="Supplier">
            <Select
              value={draft.vendorId}
              onChange={(e) => setDraft({ ...draft, vendorId: e.target.value })}
            >
              <option value="">Not recorded</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Their reference">
            <Input
              value={draft.number}
              placeholder="CN-204"
              onChange={(e) => setDraft({ ...draft, number: e.target.value })}
            />
          </Field>
          <Field label="Amount">
            <Input
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          </Field>
          <Field
            label="Comes back off"
            hint="The expense it was charged to in the first place."
          >
            <Select
              value={draft.expenseAccountId}
              onChange={(e) =>
                setDraft({ ...draft, expenseAccountId: e.target.value })
              }
            >
              <option value="">Choose</option>
              {accounts
                .filter((a) => a.type === "expense")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Button
            disabled={
              save.isPending || !draft.amount || !draft.expenseAccountId
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Record it"}
          </Button>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-sm" style={muted}>
          None. A credit note reduces what you owe the moment it is recorded,
          and goes on a bill when you decide which.
        </p>
      ) : (
        <ul className="space-y-2 text-sm">
          {rows.map((credit) => {
            const used = applications.filter((a) => a.creditId === credit.id);
            return (
              <li key={credit.id} className="border-b pb-2 last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    {credit.number ?? "Credit"}{" "}
                    <span style={muted}>
                      {formatDate(credit.issuedAt)} ·{" "}
                      {formatMoney(credit.amountCents)}
                      {credit.voidedAt
                        ? " · cancelled"
                        : ` · ${formatMoney(credit.remainingCents)} left`}
                    </span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2">
                    {!credit.voidedAt && credit.remainingCents > 0 ? (
                      <Select
                        value=""
                        aria-label="Put this credit on a bill"
                        onChange={(e) =>
                          e.target.value &&
                          apply.mutate({
                            creditId: credit.id,
                            billId: e.target.value,
                          })
                        }
                      >
                        <option value="">Put it on a bill…</option>
                        {owing.map((bill) => (
                          <option key={bill.id} value={bill.id}>
                            {bill.number ?? bill.id.slice(0, 8)} —{" "}
                            {formatMoney(bill.balanceDue)}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                    {/**
                     * Cancelling is offered only while none of it has been
                     * used: taking back a credit that settled a bill would
                     * make the bill outstanding again with nothing on the
                     * screen to say why.
                     */}
                    {!credit.voidedAt && used.length === 0 ? (
                      <button
                        type="button"
                        className="text-xs underline"
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(credit.id)}
                      >
                        cancel
                      </button>
                    ) : null}
                  </span>
                </div>
                {used.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-xs" style={muted}>
                    {used.map((application) => {
                      const bill = bills.find(
                        (b) => b.id === application.billId,
                      );
                      return (
                        <li key={application.id}>
                          {formatMoney(application.amountCents)} on{" "}
                          {bill?.number ?? application.billId.slice(0, 8)}{" "}
                          <button
                            type="button"
                            className="underline"
                            disabled={unapply.isPending}
                            onClick={() => unapply.mutate(application.id)}
                          >
                            take it off
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {credits.error ? <ErrorNote error={credits.error} /> : null}
      {apply.error ? <ErrorNote error={apply.error} /> : null}
      {unapply.error ? <ErrorNote error={unapply.error} /> : null}
      {cancel.error ? <ErrorNote error={cancel.error} /> : null}
    </Card>
  );
}

export function Bills() {
  const qc = useQueryClient();
  const [number, setNumber] = useState("");
  const [vendorId, setVendorId] = useState("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [custom, setCustom] = useState<
    Record<string, string | number | boolean | null>
  >({});
  const [classId, setClassId] = useState("");

  const bills = useQuery({
    queryKey: ["bills"],
    queryFn: () => api<{ bills: Bill[] }>("/api/bills"),
  });
  const customFields = useQuery({
    queryKey: ["accounting-custom-fields"],
    queryFn: () =>
      api<{ customFields: CustomField[] }>("/api/accounting/custom-fields"),
  });
  const dimensions = useQuery({
    queryKey: ["dimensions"],
    queryFn: () => api<{ dimensions: Dimension[] }>("/api/dimensions"),
  });
  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: () => api<{ vendors: Vendor[] }>("/api/bills/vendors"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bills"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
  };

  const add = useMutation({
    mutationFn: () =>
      api("/api/bills", {
        method: "POST",
        body: JSON.stringify({
          number: number || null,
          vendorId: vendorId || null,
          dueDate: dueDate || null,
          custom,
          lines: [
            {
              description: description || "Bill",
              unitPriceCents: toCents(amount),
              accountId: accountId || null,
              // On the line, because a bill can cover two jobs. This form
              // makes one line; the split lives in the bill editor.
              classId: classId || null,
            },
          ],
        }),
      }),
    onSuccess: () => {
      setNumber("");
      setDescription("");
      setAmount("");
      setCustom({});
      setClassId("");
      refresh();
    },
  });

  const approve = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bills/${id}/approve`, { method: "POST" }),
    onSuccess: refresh,
  });

  const pay = useMutation({
    mutationFn: (input: { id: string; amountCents: number }) =>
      api(`/api/bills/${input.id}/payments`, {
        method: "POST",
        body: JSON.stringify({ amountCents: input.amountCents }),
      }),
    onSuccess: refresh,
  });

  const voidBill = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bills/${id}/void`, { method: "POST" }),
    onSuccess: refresh,
  });

  const schedules = useQuery({
    queryKey: ["recurring-bills"],
    queryFn: () => api<{ schedules: Schedule[] }>("/api/recurring-bills"),
  });

  /**
   * Repeating a bill means pointing a schedule at the one on the screen.
   *
   * The bill itself is the template — a real draft somebody can open and
   * correct — rather than a form of its own, for the same reason recurring
   * invoices work that way: what arrives each month is a document, and it
   * should be edited with the screen that edits documents.
   */
  const repeat = useMutation({
    mutationFn: (input: { id: string; interval: string }) =>
      api("/api/recurring-bills", {
        method: "POST",
        body: JSON.stringify({
          templateBillId: input.id,
          interval: input.interval,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring-bills"] });
    },
  });

  const stop = useMutation({
    mutationFn: (input: { id: string; active: boolean }) =>
      api(`/api/recurring-bills/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: input.active }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-bills"] }),
  });

  const vendorName = (id: string | null) =>
    vendors.data?.vendors.find((v) => v.id === id)?.name ?? "—";

  return (
    <div className="space-y-4">
      <Dimensions />

      <AccountingCustomFields />

      <VendorCredits
        bills={bills.data?.bills ?? []}
        vendors={vendors.data?.vendors ?? []}
        accounts={accounts.data?.accounts ?? []}
        onChange={refresh}
      />

      <Card>
        <div className="grid gap-3 sm:grid-cols-[9rem_1fr_1fr_8rem_1fr_9rem_auto]">
          <Field label="Their reference">
            <Input
              value={number}
              onChange={(e) => setNumber(e.target.value)}
              placeholder="SUP-1042"
            />
          </Field>
          <Field label="Supplier">
            <Select
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
            >
              <option value="">Not recorded</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="For">
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
              <option value="">General expenses</option>
              {(accounts.data?.accounts ?? [])
                .filter((a) => a.type === "expense")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Due">
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </Field>
          {/**
           * Whatever this business decided it keeps on a bill.
           *
           * Rendered from the definitions rather than hard-coded, so a field
           * added in the settings appears here without a release.
           */}
          {(dimensions.data?.dimensions ?? []).some(
            (d) => d.kind === "class",
          ) ? (
            <Field label="For">
              <Select
                value={classId}
                onChange={(e) => setClassId(e.target.value)}
              >
                <option value="">the business as a whole</option>
                {(dimensions.data?.dimensions ?? [])
                  .filter((d) => d.kind === "class")
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
              </Select>
            </Field>
          ) : null}
          <CustomFields
            fields={(customFields.data?.customFields ?? []).filter(
              (field) => field.appliesTo === "bill",
            )}
            values={custom}
            onChange={setCustom}
          />
          <div className="flex items-end">
            <Button
              onClick={() => add.mutate()}
              disabled={add.isPending || !amount}
            >
              Add
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          A bill is a draft until you approve it. Nothing reaches the books
          before that, so a mistyped draft costs nothing to throw away.
        </p>
        {add.error ? <ErrorNote error={add.error} /> : null}
      </Card>

      {bills.isLoading ? <Loading /> : null}
      {bills.error ? <ErrorNote error={bills.error} /> : null}
      {bills.data && bills.data.bills.length === 0 ? (
        <Empty title="No bills yet">
          What your suppliers ask you for goes here, and into Accounts Payable
          once you approve it.
        </Empty>
      ) : null}
      {bills.data && bills.data.bills.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Supplier",
            "Reference",
            "Status",
            { label: "Total", money: true },
            { label: "Owing", money: true },
            "Receipt",
            "",
          ]}
        >
          {bills.data.bills.map((bill) => (
            <Row key={bill.id}>
              <td className="py-2">{formatDate(bill.billDate)}</td>
              <td>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setOpen(open === bill.id ? null : bill.id)}
                >
                  {vendorName(bill.vendorId)}
                </button>
              </td>
              <td style={muted}>{bill.number ?? "—"}</td>
              <td>
                <StatusBadge status={bill.status} />
              </td>
              <td className="money">
                {formatMoney(bill.totalCents, bill.currency)}
              </td>
              <td className="money">
                {formatMoney(bill.balanceDue, bill.currency)}
              </td>
              <td>
                <Receipt
                  holder="bills"
                  id={bill.id}
                  has={Boolean(bill.receiptFileKey)}
                  onDone={refresh}
                />
              </td>
              <td className="space-x-2 text-xs">
                {bill.status === "draft" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() => approve.mutate(bill.id)}
                  >
                    Approve
                  </button>
                ) : null}
                {bill.balanceDue > 0 && bill.status !== "draft" ? (
                  <button
                    type="button"
                    className="underline"
                    onClick={() =>
                      pay.mutate({ id: bill.id, amountCents: bill.balanceDue })
                    }
                  >
                    Pay in full
                  </button>
                ) : null}
                {schedules.data?.schedules.some(
                  (s) => s.templateBillId === bill.id,
                ) ? null : (
                  <button
                    type="button"
                    className="underline"
                    style={muted}
                    onClick={() =>
                      repeat.mutate({ id: bill.id, interval: "monthly" })
                    }
                  >
                    Repeat monthly
                  </button>
                )}
                {bill.status !== "void" && bill.paidCents === 0 ? (
                  <button
                    type="button"
                    className="underline"
                    style={muted}
                    onClick={() => voidBill.mutate(bill.id)}
                  >
                    Void
                  </button>
                ) : null}
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
      {open ? (
        <Card>
          <p className="mb-1 text-sm font-medium">
            {bills.data?.bills.find((b) => b.id === open)?.number ??
              "This bill"}{" "}
            <button
              type="button"
              className="ml-2 text-xs underline"
              style={muted}
              onClick={() => setOpen(null)}
            >
              close
            </button>
          </p>
          <BillDetail id={open} />
        </Card>
      ) : null}

      {schedules.data && schedules.data.schedules.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">Bills that repeat</p>
          <Table headers={["What", "How often", "Next", "Raised so far", ""]}>
            {schedules.data.schedules.map((s) => (
              <Row key={s.id}>
                <td className="py-2">{s.name ?? "Repeating bill"}</td>
                <td style={muted}>
                  {s.intervalCount > 1
                    ? `every ${s.intervalCount} ${s.interval}`
                    : s.interval}
                </td>
                <td>{s.active ? formatDate(s.nextRunAt) : "stopped"}</td>
                <td style={muted}>{s.generatedCount}</td>
                <td>
                  <button
                    type="button"
                    className="text-xs underline"
                    style={muted}
                    onClick={() => stop.mutate({ id: s.id, active: !s.active })}
                  >
                    {s.active ? "Stop" : "Start again"}
                  </button>
                </td>
              </Row>
            ))}
          </Table>
          <p className="mt-2 text-xs" style={muted}>
            Each run copies the bill it points at into a new draft. Nothing is
            approved for you — a bill is somebody else's claim, and the figure
            is often not last month's.
          </p>
          {stop.error ? <ErrorNote error={stop.error} /> : null}
        </Card>
      ) : null}

      {approve.error ? <ErrorNote error={approve.error} /> : null}
      {pay.error ? <ErrorNote error={pay.error} /> : null}
      {repeat.error ? <ErrorNote error={repeat.error} /> : null}
      {voidBill.error ? <ErrorNote error={voidBill.error} /> : null}
    </div>
  );
}

type BankTransaction = {
  id: string;
  date: string;
  description: string | null;
  amountCents: number;
  matchedEntryId: string | null;
  pending: boolean;
  /** Posted by a rule or a categorisation, so this screen may undo it. */
  undoable: boolean;
};

type BankRule = {
  id: string;
  name: string;
  matchType: string;
  matchText: string;
  direction: string;
  minCents: number | null;
  maxCents: number | null;
  accountId: string;
  priority: number;
  enabled: boolean;
  timesApplied: number;
};

type Suggestion = {
  bankTransactionId: string;
  amountCents: number;
  date: string;
  candidates: {
    kind: "invoice" | "bill";
    id: string;
    number: string | null;
    balanceDue: number;
  }[];
};

/**
 * The bank, and making it agree with the books.
 *
 * Every match is confirmed by a person. A wrong automatic match is a wrong
 * ledger, and a wrong ledger found six months later costs far more than the
 * typing it saved.
 */
/** What a provider can do, as it describes itself. */
type BankProviderInfo = {
  id: string;
  name: string;
  countries: string[];
  payments: boolean;
  rails: string[];
  recurringPayments: boolean;
  onboarding: string;
  connected: boolean;
  clientId: string | null;
  testMode: boolean;
  verifiedAt: string | null;
};

type BankConnection = {
  id: string;
  provider: string;
  institutionName: string | null;
  testMode: boolean;
  lastSyncedAt: string | null;
  lastError: string | null;
};

/**
 * Connecting a bank, for somebody who has never heard of a bank aggregator.
 *
 * The hard part of this feature is not the API. It is that a business owner
 * who wants their statement to appear has to understand that a third company
 * sits between them and their bank, choose which one, sign up for it, and
 * paste two strings — none of which they came here to do.
 *
 * So the screen answers, in this order: what this is for, which of the two to
 * pick and why, what each cannot do, and only then asks for anything. What a
 * provider cannot do comes from the provider itself, so the page and the code
 * cannot drift apart and quietly offer somebody a payment their choice will
 * refuse.
 */
function BankFeeds() {
  const qc = useQueryClient();
  const [opening, setOpening] = useState<string | null>(null);

  const providers = useQuery({
    queryKey: ["bank-providers"],
    queryFn: () =>
      api<{ mayConnect: boolean; providers: BankProviderInfo[] }>(
        "/api/bank-feeds/providers",
      ),
  });
  const connections = useQuery({
    queryKey: ["bank-feeds"],
    queryFn: () => api<{ connections: BankConnection[] }>("/api/bank-feeds"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bank-feeds"] });
    qc.invalidateQueries({ queryKey: ["bank-providers"] });
    // A sync writes bank transactions, which is what the rest of this screen
    // is about.
    qc.invalidateQueries({ queryKey: ["bank-transactions"] });
  };

  /**
   * Coming back from the provider's own page.
   *
   * The address carries the token the session started with and nothing else —
   * no public token, because the browser was never given one. The instance
   * asks the provider what happened.
   */
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const startToken = params.get("bank_start");
    const provider = params.get("bank_provider");
    if (!startToken || !provider) return;

    // Taken out of the address before anything else, so a refresh does not
    // try to finish the same session twice.
    window.history.replaceState({}, "", window.location.pathname);

    api("/api/bank-feeds/connect/finish", {
      method: "POST",
      body: JSON.stringify({ provider, startToken }),
    })
      .then(() => qc.invalidateQueries())
      .catch(() => qc.invalidateQueries());
    // Once, on the way back from the provider. `refresh` is rebuilt every
    // render and listing it here would finish the same session repeatedly;
    // the query client is stable, so it is the one thing this depends on.
  }, [qc]);

  const connect = useMutation({
    mutationFn: async (provider: string) => {
      const start = await api<{ token: string; url?: string }>(
        "/api/bank-feeds/connect/start",
        { method: "POST", body: JSON.stringify({ provider }) },
      );
      if (!start.url) {
        throw new Error(
          "that provider needs its own window, which this screen cannot open yet",
        );
      }
      /*
        Their page, in this tab.

        Where the person comes back to is decided by the instance when the
        session is created, so the token can be handed back without ever
        being in a link somebody might share.
      */
      const back = new URL(window.location.href);
      back.searchParams.set("bank_start", start.token);
      back.searchParams.set("bank_provider", provider);
      window.sessionStorage.setItem("bank_return", back.toString());
      window.location.href = start.url;
    },
  });

  const syncNow = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bank-feeds/${id}/sync`, { method: "POST" }),
    onSuccess: refresh,
  });

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bank-feeds/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const found = providers.data?.providers ?? [];
  const live = connections.data?.connections ?? [];
  const anyCredentials = found.some((p) => p.connected);
  /**
   * Whether this person may link a bank at all.
   *
   * The server decides, because the server is where the rule is. A bookkeeper
   * sees the connections and can fetch a statement — that is the job — and is
   * not offered a button that would answer 403.
   */
  const mayConnect = providers.data?.mayConnect ?? false;

  return (
    <Card>
      <p className="mb-1 font-medium">Your bank, brought in automatically</p>
      <p className="mb-3 text-sm" style={muted}>
        Instead of downloading a statement and uploading it here, your bank can
        send its transactions in on its own. Banks do not do that directly — one
        of the two companies below sits in between, and you sign up with
        whichever suits you. Sentrello never sees your bank login, and the
        connection belongs to you.
      </p>

      {live.length > 0 ? (
        <ul className="mb-4 space-y-2">
          {live.map((connection) => (
            <li
              key={connection.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border p-3"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="min-w-0">
                <p className="font-medium">
                  {connection.institutionName ?? "Your bank"}
                  {connection.testMode ? (
                    <span className="ml-2 text-xs" style={muted}>
                      test mode
                    </span>
                  ) : null}
                </p>
                {connection.lastError ? (
                  /*
                    A feed that has quietly stopped is worse than one that
                    never worked: the figures look right and are a month old.
                    The bank's own words, because they usually say what to do.
                  */
                  <p
                    className="text-sm"
                    style={{ color: "var(--color-warning)" }}
                  >
                    {connection.lastError}
                  </p>
                ) : (
                  <p className="text-xs" style={muted}>
                    {connection.lastSyncedAt
                      ? `Last brought in ${formatDate(connection.lastSyncedAt)}`
                      : // Not a failure: a bank spends a few seconds preparing
                        // its history, and a blank list with no explanation
                        // reads as something that did not work.
                        "Your bank is preparing its history — this can take a minute"}
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  onClick={() => syncNow.mutate(connection.id)}
                  disabled={syncNow.isPending}
                >
                  {syncNow.isPending ? "Fetching…" : "Fetch now"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => disconnect.mutate(connection.id)}
                  disabled={disconnect.isPending}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      {syncNow.error ? <ErrorNote error={syncNow.error} /> : null}
      {connect.error ? <ErrorNote error={connect.error} /> : null}

      {!mayConnect ? (
        <p className="text-sm" style={muted}>
          {live.length > 0
            ? "Connecting or disconnecting a bank is done by an administrator. You can fetch a statement whenever you need one."
            : "No bank is connected yet. An administrator can connect one — it is kept apart from the books on purpose, because it decides who can reach the account."}
        </p>
      ) : null}

      <div className={mayConnect ? "grid gap-3 sm:grid-cols-2" : "hidden"}>
        {found.map((provider) => (
          <div
            key={provider.id}
            className="rounded border p-3"
            style={{ borderColor: "var(--border)" }}
          >
            <p className="font-medium">{provider.name}</p>
            <ul className="mt-1 mb-2 space-y-0.5 text-xs" style={muted}>
              <li>Banks in {provider.countries.join(", ")}</li>
              <li>
                {provider.payments
                  ? `Can pay suppliers by ${provider.rails.join(", ")}`
                  : "Reads your accounts only"}
              </li>
              <li>
                {provider.recurringPayments
                  ? "Can set up a payment that repeats"
                  : "Cannot set up a repeating payment"}
              </li>
            </ul>
            <p className="mb-2 text-xs" style={muted}>
              {provider.onboarding}
            </p>

            {provider.connected ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs" style={muted}>
                  {provider.verifiedAt
                    ? "Details checked"
                    : "Details saved, not checked yet"}
                </span>
                <Button
                  onClick={() => connect.mutate(provider.id)}
                  disabled={connect.isPending}
                >
                  Connect a bank
                </Button>
                <button
                  type="button"
                  className="text-xs underline"
                  style={muted}
                  onClick={() =>
                    setOpening(opening === provider.id ? null : provider.id)
                  }
                >
                  Change details
                </button>
              </div>
            ) : (
              <Button
                variant="secondary"
                onClick={() => setOpening(provider.id)}
              >
                Set {provider.name} up
              </Button>
            )}

            {opening === provider.id ? (
              <ProviderDetails
                provider={provider}
                onDone={() => {
                  setOpening(null);
                  refresh();
                }}
              />
            ) : null}
          </div>
        ))}
      </div>

      {mayConnect && !anyCredentials ? (
        <p className="mt-3 text-xs" style={muted}>
          Not sure? Most businesses pick the first. It works with banks in every
          country Sentrello supports and can pay a supplier every month on its
          own. The second is simpler and cheaper if you are in the United States
          and only want to see your transactions.
        </p>
      ) : null}
    </Card>
  );
}

/** Pasting in the two strings a provider gives you, and proving they work. */
function ProviderDetails({
  provider,
  onDone,
}: {
  provider: BankProviderInfo;
  onDone: () => void;
}) {
  const [clientId, setClientId] = useState(provider.clientId ?? "");
  const [secret, setSecret] = useState("");
  const [testMode, setTestMode] = useState(provider.testMode);
  const [checked, setChecked] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () =>
      api(`/api/bank-feeds/providers/${provider.id}`, {
        method: "PUT",
        body: JSON.stringify({ clientId, secret, testMode }),
      }),
    onSuccess: () => {
      // Never held in the browser longer than the request needs it.
      setSecret("");
      setChecked(null);
    },
  });

  /**
   * Save, then check, then use — the same order as the payment settings.
   *
   * Somebody who mistypes a secret finds out here rather than when a bank
   * connection fails days later with a message about tokens.
   */
  const check = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; error?: string }>(
        `/api/bank-feeds/providers/${provider.id}/test`,
        { method: "POST" },
      ),
    onSuccess: (result) => {
      setChecked(result.ok ? "These details work." : (result.error ?? "No."));
      if (result.ok) onDone();
    },
  });

  return (
    <div className="mt-3 space-y-2 border-t pt-3">
      <Field label="Client ID" hint="From your account with them. Not secret.">
        <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
      </Field>
      <Field
        label="Secret"
        hint="Stored encrypted and never shown again, like a password."
      >
        <Input
          type="password"
          value={secret}
          placeholder={provider.connected ? "•••••• (unchanged)" : ""}
          onChange={(e) => setSecret(e.target.value)}
        />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={testMode}
          onChange={(e) => setTestMode(e.target.checked)}
        />
        These are test details, not my real bank
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          onClick={() => save.mutate()}
          disabled={save.isPending || !secret.trim()}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => check.mutate()}
          disabled={check.isPending || !provider.connected}
        >
          {check.isPending ? "Checking…" : "Check they work"}
        </Button>
        {checked ? (
          <span className="text-sm" style={muted}>
            {checked}
          </span>
        ) : null}
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
      {check.error ? <ErrorNote error={check.error} /> : null}
    </div>
  );
}

export function Banking() {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [importAccountId, setImportAccountId] = useState("");
  const [fromAccountId, setFrom] = useState("");
  const [toAccountId, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [markAccountId, setMarkAccountId] = useState("");
  const [bankName, setBankName] = useState("");
  const [accountNumber, setAccountNumber] = useState("");

  const rows = useQuery({
    queryKey: ["bank-transactions"],
    queryFn: () =>
      api<{ bankTransactions: BankTransaction[]; unmatchedCount: number }>(
        "/api/bank-transactions",
      ),
  });
  const suggestions = useQuery({
    queryKey: ["bank-suggestions"],
    queryFn: () =>
      api<{ suggestions: Suggestion[] }>("/api/bank-transactions/suggestions"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });
  /**
   * Which accounts are actually bank accounts.
   *
   * Statements could be imported and transactions matched, and nothing could
   * say *which* accounts the business banks with — the route for it has
   * existed, gated behind the licence, with nothing calling it. A business
   * that had not seeded one was reconciling against a list it could not add
   * to.
   */
  const bankAccounts = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<{ bankAccounts: Account[] }>("/api/bank-accounts"),
  });

  const markAsBank = useMutation({
    mutationFn: () =>
      api("/api/bank-accounts", {
        method: "POST",
        body: JSON.stringify({
          accountId: markAccountId,
          bankName: bankName || null,
          accountNumber,
        }),
      }),
    onSuccess: () => {
      setMarkAccountId("");
      setBankName("");
      setAccountNumber("");
      qc.invalidateQueries({ queryKey: ["bank-accounts"] });
      qc.invalidateQueries({ queryKey: ["accounts"] });
    },
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bank-transactions"] });
    qc.invalidateQueries({ queryKey: ["bank-suggestions"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  };

  const importCsv = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("choose a file first");
      const account = importAccountId
        ? `&bankAccountId=${encodeURIComponent(importAccountId)}`
        : "";
      return api(
        `/api/bank-imports?filename=${encodeURIComponent(file.name)}${account}`,
        { method: "POST", body: await file.text() },
      );
    },
    onSuccess: () => {
      setFile(null);
      refresh();
    },
  });

  const match = useMutation({
    mutationFn: (input: {
      id: string;
      kind: "invoice" | "bill";
      refId: string;
    }) =>
      api(`/api/bank-transactions/${input.id}/match`, {
        method: "POST",
        body: JSON.stringify(
          input.kind === "invoice"
            ? { invoiceId: input.refId }
            : { billId: input.refId },
        ),
      }),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: ["bills"] });
    },
  });

  const transfer = useMutation({
    mutationFn: () =>
      api("/api/transfers", {
        method: "POST",
        body: JSON.stringify({
          fromAccountId,
          toAccountId,
          amountCents: toCents(amount),
        }),
      }),
    onSuccess: () => {
      setAmount("");
      refresh();
    },
  });

  const assets = (accounts.data?.accounts ?? []).filter(
    (a) => a.type === "asset",
  );

  return (
    <div className="space-y-4">
      <BankFeeds />

      <BankRules onApplied={refresh} />

      <Reconcile onDone={refresh} />

      <Card>
        <p className="mb-2 text-sm font-medium">Import a statement</p>
        <div className="flex flex-wrap items-end gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            className="text-sm"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {/**
           * Which account the file is a statement of.
           *
           * Only asked when there is more than one to choose between: with a
           * single bank account there is nothing to say, and with two, a line
           * categorised without knowing which account it left is money taken
           * out of the wrong one.
           */}
          {(bankAccounts.data?.bankAccounts ?? []).length > 1 ? (
            <Field label="Statement for">
              <Select
                value={importAccountId}
                onChange={(e) => setImportAccountId(e.target.value)}
              >
                <option value="">Choose</option>
                {(bankAccounts.data?.bankAccounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          <Button
            onClick={() => importCsv.mutate()}
            disabled={!file || importCsv.isPending}
          >
            Import
          </Button>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          Rows whose date or amount cannot be read are reported back rather than
          imported as nothing.
        </p>
        {importCsv.error ? <ErrorNote error={importCsv.error} /> : null}
      </Card>

      <Card>
        <p className="mb-2 font-medium text-sm">The accounts you bank with</p>
        {(bankAccounts.data?.bankAccounts ?? []).length === 0 ? (
          <p className="mb-3 text-sm" style={muted}>
            None yet. Say which of your asset accounts is a bank account and
            imported statements can be reconciled against it.
          </p>
        ) : (
          <ul className="mb-3 space-y-1 text-sm">
            {(bankAccounts.data?.bankAccounts ?? []).map((account) => (
              <li key={account.id}>
                {account.code} {account.name}
                {account.bankName ? (
                  <span style={muted}> · {account.bankName}</span>
                ) : null}
                {account.bankAccountLast4 ? (
                  <span style={muted}> ····{account.bankAccountLast4}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]">
          <Field label="Account">
            <Select
              value={markAccountId}
              onChange={(e) => setMarkAccountId(e.target.value)}
            >
              <option value="">Choose</option>
              {assets
                .filter((a) => !a.isBank)
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="Bank">
            <Input
              value={bankName}
              placeholder="Barclays"
              onChange={(e) => setBankName(e.target.value)}
            />
          </Field>
          <Field label="Account number" hint="Only the last four are kept.">
            <Input
              value={accountNumber}
              onChange={(e) => setAccountNumber(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => markAsBank.mutate()}
              disabled={!markAccountId || markAsBank.isPending}
            >
              {markAsBank.isPending ? "Saving…" : "It is a bank account"}
            </Button>
          </div>
        </div>
        {markAsBank.error ? <ErrorNote error={markAsBank.error} /> : null}
      </Card>

      <Card>
        <p className="mb-2 text-sm font-medium">Move money between accounts</p>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_8rem_auto]">
          <Field label="From">
            <Select
              value={fromAccountId}
              onChange={(e) => setFrom(e.target.value)}
            >
              <option value="">Choose</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="To">
            <Select value={toAccountId} onChange={(e) => setTo(e.target.value)}>
              <option value="">Choose</option>
              {assets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
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
          <div className="flex items-end">
            <Button
              onClick={() => transfer.mutate()}
              disabled={
                transfer.isPending || !amount || !fromAccountId || !toAccountId
              }
            >
              Transfer
            </Button>
          </div>
        </div>
        {transfer.error ? <ErrorNote error={transfer.error} /> : null}
      </Card>

      {suggestions.data && suggestions.data.suggestions.length > 0 ? (
        <Card>
          <p className="mb-2 text-sm font-medium">
            These look like they settle something
          </p>
          {suggestions.data.suggestions.map((s) => (
            <div
              key={s.bankTransactionId}
              className="flex items-center justify-between border-b py-2 text-sm last:border-0"
            >
              <span>
                {formatDate(s.date)} &middot;{" "}
                <span className="money">{formatMoney(s.amountCents)}</span>
              </span>
              <span className="space-x-2">
                {s.candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    className="text-xs underline"
                    onClick={() =>
                      match.mutate({
                        id: s.bankTransactionId,
                        kind: candidate.kind,
                        refId: candidate.id,
                      })
                    }
                  >
                    {candidate.number ?? candidate.id.slice(0, 8)}
                  </button>
                ))}
              </span>
            </div>
          ))}
          {match.error ? <ErrorNote error={match.error} /> : null}
        </Card>
      ) : null}

      {rows.isLoading ? <Loading /> : null}
      {rows.error ? <ErrorNote error={rows.error} /> : null}
      {rows.data && rows.data.bankTransactions.length === 0 ? (
        <Empty title="No statement imported yet" />
      ) : null}
      {rows.data && rows.data.bankTransactions.length > 0 ? (
        <Table
          headers={[
            "Date",
            "Detail",
            { label: "Amount", money: true },
            "Account",
          ]}
        >
          {rows.data.bankTransactions.map((row) => (
            <Row key={row.id}>
              <td className="py-2">{formatDate(row.date)}</td>
              <td>
                {row.description ?? "—"}
                {row.pending ? (
                  <span className="ml-2 text-xs" style={muted}>
                    the bank still calls this provisional
                  </span>
                ) : null}
              </td>
              <td className="money">{formatMoney(row.amountCents)}</td>
              <td>
                <StatementLine
                  row={row}
                  accounts={accounts.data?.accounts ?? []}
                  onDone={refresh}
                />
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}

/**
 * One statement line, given an account.
 *
 * The thing a bookkeeper does hundreds of times a month, so it is one picker
 * in the row rather than a screen to open: choose where it belongs and it is
 * in the books. A line already posted shows what it cost to undo instead —
 * offered only where this screen is allowed to undo it, because a line
 * reconciled against an invoice belongs to that invoice.
 */
function StatementLine({
  row,
  accounts,
  onDone,
}: {
  row: BankTransaction;
  accounts: Account[];
  onDone: () => void;
}) {
  const [accountId, setAccountId] = useState("");

  const categorise = useMutation({
    mutationFn: () =>
      api(`/api/bank-transactions/${row.id}/categorise`, {
        method: "POST",
        body: JSON.stringify({ accountId }),
      }),
    onSuccess: onDone,
  });
  const undo = useMutation({
    mutationFn: () =>
      api(`/api/bank-transactions/${row.id}/uncategorise`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: onDone,
  });

  if (row.matchedEntryId) {
    return (
      <span className="flex items-center gap-2 text-sm" style={muted}>
        posted
        {row.undoable ? (
          <button
            type="button"
            className="text-xs underline"
            disabled={undo.isPending}
            onClick={() => undo.mutate()}
          >
            {undo.isPending ? "undoing…" : "undo"}
          </button>
        ) : null}
        {undo.error ? <ErrorNote error={undo.error} /> : null}
      </span>
    );
  }

  return (
    <span className="flex items-center gap-2">
      <Select
        value={accountId}
        onChange={(e) => setAccountId(e.target.value)}
        // The bank side of the entry is the account the statement is of, so
        // offering it here would be both sides of one line.
      >
        <option value="">Put it in…</option>
        {accounts
          .filter((a) => !a.isBank)
          .map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} {a.name}
            </option>
          ))}
      </Select>
      {accountId ? (
        <Button
          variant="secondary"
          disabled={categorise.isPending}
          onClick={() => categorise.mutate()}
        >
          {categorise.isPending ? "Posting…" : "Post"}
        </Button>
      ) : null}
      {categorise.error ? <ErrorNote error={categorise.error} /> : null}
    </span>
  );
}

const MATCH_LABELS: Record<string, string> = {
  contains: "contains",
  starts: "starts with",
  equals: "is exactly",
};

/**
 * Rules, so nobody categorises the same coffee shop twice.
 *
 * The statement brings in the same words every month — the connection, the
 * fuel, the software — and typing the account against each one is the work
 * that makes people give up on their books. A rule says where those belong and
 * the next statement arrives already posted.
 *
 * It is the only thing in the product that writes to the ledger while nobody
 * is watching, so it is written in front of a count of what it will take. A
 * rule matching on "a" would otherwise be discovered by way of a hundred
 * journal entries.
 */
function BankRules({ onApplied }: { onApplied: () => void }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({
    name: "",
    matchType: "contains",
    matchText: "",
    direction: "any",
    accountId: "",
  });

  const rules = useQuery({
    queryKey: ["bank-rules"],
    queryFn: () => api<{ rules: BankRule[] }>("/api/bank-rules"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  /**
   * What it would take, asked as it is typed.
   *
   * Of the rule in the form rather than the rule as saved, which is the whole
   * point: the answer has to arrive before the decision does.
   */
  const preview = useQuery({
    queryKey: ["bank-rule-preview", draft],
    enabled:
      open && draft.matchText.trim().length > 0 && Boolean(draft.accountId),
    queryFn: () =>
      api<{ matched: number; wouldPost: number }>("/api/bank-rules/preview", {
        method: "POST",
        body: JSON.stringify({ ...draft, name: draft.name || "Preview" }),
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bank-rules"] });
    onApplied();
  };

  const save = useMutation({
    mutationFn: () =>
      api("/api/bank-rules", { method: "POST", body: JSON.stringify(draft) }),
    onSuccess: () => {
      setDraft({
        name: "",
        matchType: "contains",
        matchText: "",
        direction: "any",
        accountId: "",
      });
      setOpen(false);
      refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bank-rules/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
  /**
   * Off, rather than gone.
   *
   * A rule that is wrong for a month — a supplier changed, a subscription
   * paused — is turned off and back on. Deleting it loses the count of what it
   * has already done, which is the only record of how much of the business's
   * bookkeeping it was doing.
   */
  const toggle = useMutation({
    mutationFn: (rule: BankRule) =>
      api(`/api/bank-rules/${rule.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...rule, enabled: !rule.enabled }),
      }),
    onSuccess: refresh,
  });
  const runNow = useMutation({
    mutationFn: () =>
      api<{ applied: number; skipped: number }>("/api/bank-rules/apply", {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  const named = (id: string) => {
    const account = (accounts.data?.accounts ?? []).find((a) => a.id === id);
    return account ? `${account.code} ${account.name}` : "an account";
  };

  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">Rules</p>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            {runNow.isPending ? "Running…" : "Run them now"}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "New rule"}
          </Button>
        </div>
      </div>

      {runNow.data ? (
        <p className="mb-2 text-sm" style={muted}>
          {runNow.data.applied} posted
          {runNow.data.skipped > 0
            ? `, ${runNow.data.skipped} left alone — say which bank account those came out of, or the period is closed`
            : ""}
          .
        </p>
      ) : null}

      {open ? (
        <div className="mb-3 space-y-3 border-b pb-3">
          <div className="flex flex-wrap gap-3">
            <Field label="Name">
              <Input
                value={draft.name}
                placeholder="Fuel"
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="When the line">
              <Select
                value={draft.matchType}
                onChange={(e) =>
                  setDraft({ ...draft, matchType: e.target.value })
                }
              >
                {Object.entries(MATCH_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="These words">
              <Input
                value={draft.matchText}
                placeholder="ACME FUEL"
                onChange={(e) =>
                  setDraft({ ...draft, matchText: e.target.value })
                }
              />
            </Field>
            <Field label="And the money">
              <Select
                value={draft.direction}
                onChange={(e) =>
                  setDraft({ ...draft, direction: e.target.value })
                }
              >
                <option value="any">either way</option>
                <option value="out">went out</option>
                <option value="in">came in</option>
              </Select>
            </Field>
            <Field label="Put it in">
              <Select
                value={draft.accountId}
                onChange={(e) =>
                  setDraft({ ...draft, accountId: e.target.value })
                }
              >
                <option value="">Choose</option>
                {(accounts.data?.accounts ?? [])
                  .filter((a) => !a.isBank)
                  .map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.code} {a.name}
                    </option>
                  ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={muted}>
              {preview.data
                ? `${preview.data.matched} lines on your statements say this — ${preview.data.wouldPost} of them would be posted now.`
                : "Say what the line has to contain and where it goes."}
            </span>
            <Button
              disabled={
                save.isPending ||
                !draft.name.trim() ||
                !draft.matchText.trim() ||
                !draft.accountId
              }
              onClick={() => save.mutate()}
            >
              {save.isPending ? "Saving…" : "Save the rule"}
            </Button>
          </div>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </div>
      ) : null}

      {(rules.data?.rules ?? []).length === 0 ? (
        <p className="text-sm" style={muted}>
          None yet. A rule reads the words your bank sends and puts the line
          straight into an account, so next month's statement arrives posted.
        </p>
      ) : (
        <ul className="space-y-1 text-sm">
          {(rules.data?.rules ?? []).map((rule) => (
            <li key={rule.id} className="flex items-center justify-between">
              <span>
                <span className="font-medium">{rule.name}</span>{" "}
                <span style={muted}>
                  {MATCH_LABELS[rule.matchType] ?? rule.matchType} “
                  {rule.matchText}”
                  {rule.direction === "out"
                    ? ", going out"
                    : rule.direction === "in"
                      ? ", coming in"
                      : ""}{" "}
                  → {named(rule.accountId)}
                  {rule.timesApplied > 0
                    ? ` · used ${rule.timesApplied} times`
                    : ""}
                  {rule.enabled ? "" : " · off"}
                </span>
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  className="text-xs underline"
                  disabled={toggle.isPending}
                  onClick={() => toggle.mutate(rule)}
                >
                  {rule.enabled ? "turn off" : "turn on"}
                </button>
                <button
                  type="button"
                  className="text-xs underline"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(rule.id)}
                >
                  delete
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {rules.error ? <ErrorNote error={rules.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
      {toggle.error ? <ErrorNote error={toggle.error} /> : null}
      {runNow.error ? <ErrorNote error={runNow.error} /> : null}
    </Card>
  );
}

type Reconciliation = {
  id: string;
  accountId: string;
  statementDate: string;
  statementBalanceCents: number;
  openingBalanceCents: number;
  completedAt: string | null;
};

type ReconcileLine = {
  id: string;
  date: string;
  description: string | null;
  amountCents: number;
  cleared: boolean;
  posted: boolean;
};

/**
 * The month the bank and the books agreed, and somebody said so.
 *
 * Matching a line against an invoice says the money has been recorded; it does
 * not say the account is right. A payment that never arrived, a fee nobody
 * recorded, a transaction entered twice — the only thing that catches all
 * three is adding up what the bank says, adding up what the books say, and
 * refusing a difference.
 *
 * So this screen has one number on it that matters, and it will not let
 * anybody past while it is not zero.
 */
function Reconcile({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState({
    accountId: "",
    statementDate: "",
    balance: "",
  });

  const list = useQuery({
    queryKey: ["reconciliations"],
    queryFn: () =>
      api<{ reconciliations: Reconciliation[] }>("/api/reconciliations"),
  });
  const bankAccounts = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<{ bankAccounts: Account[] }>("/api/bank-accounts"),
  });

  const current =
    openId ??
    (list.data?.reconciliations ?? []).find((r) => !r.completedAt)?.id ??
    null;

  const progress = useQuery({
    queryKey: ["reconciliation", current],
    enabled: Boolean(current),
    queryFn: () =>
      api<{
        reconciliation: Reconciliation;
        lines: ReconcileLine[];
        clearedCents: number;
        differenceCents: number;
      }>(`/api/reconciliations/${current}`),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["reconciliations"] });
    qc.invalidateQueries({ queryKey: ["reconciliation"] });
    onDone();
  };

  const begin = useMutation({
    mutationFn: () =>
      api<{ reconciliation: Reconciliation }>("/api/reconciliations", {
        method: "POST",
        body: JSON.stringify({
          accountId: draft.accountId,
          statementDate: draft.statementDate
            ? new Date(draft.statementDate).toISOString()
            : "",
          statementBalanceCents: toCents(draft.balance),
        }),
      }),
    onSuccess: (made) => {
      setOpenId(made.reconciliation.id);
      setDraft({ accountId: "", statementDate: "", balance: "" });
      refresh();
    },
  });

  const toggle = useMutation({
    mutationFn: (line: ReconcileLine) =>
      api(`/api/reconciliations/${current}/lines/${line.id}`, {
        method: "POST",
        body: JSON.stringify({ cleared: !line.cleared }),
      }),
    onSuccess: refresh,
  });

  const finish = useMutation({
    mutationFn: () =>
      api(`/api/reconciliations/${current}/finish`, { method: "POST" }),
    onSuccess: () => {
      setOpenId(null);
      refresh();
    },
  });

  const abandon = useMutation({
    mutationFn: () =>
      api(`/api/reconciliations/${current}`, { method: "DELETE" }),
    onSuccess: () => {
      setOpenId(null);
      refresh();
    },
  });

  const state = progress.data;
  const difference = state?.differenceCents ?? 0;

  return (
    <Card className="space-y-3">
      <p className="text-sm font-medium">Reconcile against a statement</p>

      {state && !state.reconciliation.completedAt ? (
        <>
          <p className="text-sm" style={muted}>
            Statement to {formatDate(state.reconciliation.statementDate)},
            closing at{" "}
            <span className="money">
              {formatMoney(state.reconciliation.statementBalanceCents)}
            </span>
            , opening from{" "}
            <span className="money">
              {formatMoney(state.reconciliation.openingBalanceCents)}
            </span>
            . Tick everything the statement shows.
          </p>

          {state.lines.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nothing on this account up to that date. Import the statement or
              connect the bank first.
            </p>
          ) : (
            <Table
              headers={[
                "",
                "Date",
                "Detail",
                { label: "Amount", money: true },
                "In the books",
              ]}
            >
              {state.lines.map((line) => (
                <Row key={line.id}>
                  <td className="py-2">
                    <input
                      type="checkbox"
                      checked={line.cleared}
                      aria-label={`Clear ${line.description ?? "line"}`}
                      disabled={toggle.isPending}
                      onChange={() => toggle.mutate(line)}
                    />
                  </td>
                  <td>{formatDate(line.date)}</td>
                  <td>{line.description ?? "—"}</td>
                  <td className="money">{formatMoney(line.amountCents)}</td>
                  {/**
                   * A line the bank shows that the books have not recorded is
                   * the commonest reason a reconciliation will not come to
                   * zero, and saying so here saves somebody hunting for it.
                   */}
                  <td style={muted}>{line.posted ? "yes" : "not yet"}</td>
                </Row>
              ))}
            </Table>
          )}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span style={muted}>
              {difference === 0
                ? "The bank and your books agree."
                : `Out by ${formatMoney(Math.abs(difference))} — something the statement shows is missing from your books, or something in your books is not on it.`}
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={abandon.isPending}
                onClick={() => abandon.mutate()}
              >
                Abandon
              </Button>
              <Button
                disabled={difference !== 0 || finish.isPending}
                onClick={() => finish.mutate()}
              >
                {finish.isPending ? "Finishing…" : "It agrees"}
              </Button>
            </div>
          </div>
          {finish.error ? <ErrorNote error={finish.error} /> : null}
          {toggle.error ? <ErrorNote error={toggle.error} /> : null}
          {abandon.error ? <ErrorNote error={abandon.error} /> : null}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Account">
              <Select
                value={draft.accountId}
                onChange={(e) =>
                  setDraft({ ...draft, accountId: e.target.value })
                }
              >
                <option value="">Choose</option>
                {(bankAccounts.data?.bankAccounts ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Statement closes">
              <Input
                type="date"
                value={draft.statementDate}
                onChange={(e) =>
                  setDraft({ ...draft, statementDate: e.target.value })
                }
              />
            </Field>
            <Field label="Closing balance" hint="As the statement prints it.">
              <Input
                inputMode="decimal"
                value={draft.balance}
                onChange={(e) =>
                  setDraft({ ...draft, balance: e.target.value })
                }
              />
            </Field>
            <Button
              disabled={
                begin.isPending || !draft.accountId || !draft.statementDate
              }
              onClick={() => begin.mutate()}
            >
              Start
            </Button>
          </div>
          {begin.error ? <ErrorNote error={begin.error} /> : null}
        </>
      )}

      {(list.data?.reconciliations ?? []).filter((r) => r.completedAt).length >
      0 ? (
        <ul className="space-y-1 text-sm">
          {(list.data?.reconciliations ?? [])
            .filter((r) => r.completedAt)
            .slice(0, 6)
            .map((r) => (
              <li key={r.id} style={muted}>
                Agreed to {formatDate(r.statementDate)} at{" "}
                <span className="money">
                  {formatMoney(r.statementBalanceCents)}
                </span>
              </li>
            ))}
        </ul>
      ) : null}
      {list.error ? <ErrorNote error={list.error} /> : null}
    </Card>
  );
}

type FixedAsset = {
  id: string;
  name: string;
  description: string | null;
  costCents: number;
  salvageCents: number;
  acquiredOn: string;
  method: string;
  lifeMonths: number;
  rateBp: number | null;
  assetAccountId: string;
  expenseAccountId: string;
  accumulatedAccountId: string;
  disposedOn: string | null;
  takenCents: number;
  bookValueCents: number;
};

/**
 * The van, and the fact that it wears out.
 *
 * A business that buys a £30,000 van has not spent £30,000 this year: it has
 * swapped cash for something that will be worth nothing in six years. Putting
 * the whole cost through as an expense makes this year look terrible and the
 * next five look better than they were — so the cost sits here and a slice of
 * it becomes an expense every month, on its own.
 *
 * What each is worth now is read from the ledger rather than from the
 * schedule, because the accumulated account is exactly the one an accountant
 * adjusts, and after an adjustment the books are the truth and the schedule is
 * not.
 */
export function Assets() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [disposing, setDisposing] = useState<FixedAsset | null>(null);

  const assets = useQuery({
    queryKey: ["fixed-assets"],
    queryFn: () => api<{ assets: FixedAsset[] }>("/api/fixed-assets"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["fixed-assets"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
  };

  const catchUp = useMutation({
    mutationFn: () =>
      api<{ posted: number; skipped: number }>("/api/fixed-assets/depreciate", {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  if (assets.isLoading) return <Loading />;
  if (assets.error) return <ErrorNote error={assets.error} />;
  const rows = assets.data?.assets ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Button onClick={() => setOpen(!open)}>
            {open ? "Cancel" : "Add an asset"}
          </Button>
          {/**
           * Depreciation posts itself on the first of every month. This is for
           * the business that started keeping its books in September for a van
           * it bought in January, and would otherwise be owed eight months it
           * has to work out by hand.
           */}
          <Button
            variant="secondary"
            disabled={catchUp.isPending}
            onClick={() => catchUp.mutate()}
          >
            {catchUp.isPending ? "Posting…" : "Catch up on depreciation"}
          </Button>
        </div>
        {catchUp.data ? (
          <span style={muted}>
            {catchUp.data.posted} months posted
            {catchUp.data.skipped > 0
              ? `, ${catchUp.data.skipped} left — the period is closed`
              : ""}
            .
          </span>
        ) : null}
      </div>
      {catchUp.error ? <ErrorNote error={catchUp.error} /> : null}

      {open ? (
        <NewAsset
          accounts={accounts.data?.accounts ?? []}
          onDone={() => {
            setOpen(false);
            refresh();
          }}
        />
      ) : null}

      {disposing ? (
        <DisposeAsset
          asset={disposing}
          accounts={accounts.data?.accounts ?? []}
          onDone={() => {
            setDisposing(null);
            refresh();
          }}
        />
      ) : null}

      {rows.length === 0 ? (
        <Empty title="Nothing on the books yet">
          A van, a laptop, a coffee machine — anything the business bought that
          it will still have next year.
        </Empty>
      ) : (
        <Table
          headers={[
            "Asset",
            "Bought",
            { label: "Cost", money: true },
            { label: "Taken so far", money: true },
            { label: "Worth now", money: true },
            "",
          ]}
        >
          {rows.map((row) => (
            <Row key={row.id}>
              <td className="py-2">
                {row.name}
                <span style={muted}>
                  {" "}
                  ·{" "}
                  {row.method === "reducing-balance"
                    ? `reducing balance, ${asPercent(row.rateBp ?? 0)} a year`
                    : `straight line over ${row.lifeMonths} months`}
                </span>
              </td>
              <td>{formatDate(row.acquiredOn)}</td>
              <td className="money">{formatMoney(row.costCents)}</td>
              <td className="money">{formatMoney(row.takenCents)}</td>
              <td className="money">{formatMoney(row.bookValueCents)}</td>
              <td>
                {row.disposedOn ? (
                  <span style={muted}>gone {formatDate(row.disposedOn)}</span>
                ) : (
                  <button
                    type="button"
                    className="text-xs underline"
                    onClick={() => setDisposing(row)}
                  >
                    sold or scrapped
                  </button>
                )}
              </td>
            </Row>
          ))}
        </Table>
      )}
    </div>
  );
}

/**
 * Adding one, with the schedule shown before it is saved.
 *
 * "What does this do to my profit and loss" is the question somebody has while
 * they are typing, and it is answered from the same function that will post
 * it — a preview computed a second way is a preview that will eventually
 * disagree with the books.
 */
function NewAsset({
  accounts,
  onDone,
}: {
  accounts: Account[];
  onDone: () => void;
}) {
  const [draft, setDraft] = useState({
    name: "",
    cost: "",
    salvage: "",
    acquiredOn: "",
    method: "straight-line",
    lifeMonths: "60",
    ratePercent: "25",
    assetAccountId: "",
    expenseAccountId: "",
    accumulatedAccountId: "",
    paidFromAccountId: "",
  });

  const terms = {
    costCents: toCents(draft.cost),
    salvageCents: toCents(draft.salvage),
    acquiredOn: draft.acquiredOn
      ? new Date(draft.acquiredOn).toISOString()
      : "",
    method: draft.method,
    lifeMonths: Number(draft.lifeMonths) || 0,
    // Basis points, the same as every other rate in the module.
    rateBp: Math.round((Number(draft.ratePercent) || 0) * 100),
  };

  const schedule = useQuery({
    queryKey: ["asset-schedule", terms],
    enabled:
      terms.costCents > 0 && terms.lifeMonths > 0 && Boolean(terms.acquiredOn),
    queryFn: () =>
      api<{
        slices: { month: string; amountCents: number }[];
        totalCents: number;
      }>("/api/fixed-assets/schedule", {
        method: "POST",
        body: JSON.stringify(terms),
      }),
  });

  const save = useMutation({
    mutationFn: () =>
      api("/api/fixed-assets", {
        method: "POST",
        body: JSON.stringify({
          name: draft.name,
          ...terms,
          assetAccountId: draft.assetAccountId,
          expenseAccountId: draft.expenseAccountId,
          accumulatedAccountId: draft.accumulatedAccountId,
          ...(draft.paidFromAccountId
            ? { paidFromAccountId: draft.paidFromAccountId }
            : {}),
        }),
      }),
    onSuccess: onDone,
  });

  const picker = (
    label: string,
    key: keyof typeof draft,
    hint?: string,
    only?: (account: Account) => boolean,
  ) => (
    <Field label={label} hint={hint}>
      <Select
        value={draft[key]}
        onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
      >
        <option value="">Choose</option>
        {accounts.filter(only ?? (() => true)).map((a) => (
          <option key={a.id} value={a.id}>
            {a.code} {a.name}
          </option>
        ))}
      </Select>
    </Field>
  );

  const first = schedule.data?.slices[0]?.amountCents ?? 0;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <Field label="What it is">
          <Input
            value={draft.name}
            placeholder="Transit van"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </Field>
        <Field label="What it cost">
          <Input
            inputMode="decimal"
            value={draft.cost}
            onChange={(e) => setDraft({ ...draft, cost: e.target.value })}
          />
        </Field>
        <Field
          label="Worth at the end"
          hint="Leave blank if it will be worth nothing."
        >
          <Input
            inputMode="decimal"
            value={draft.salvage}
            onChange={(e) => setDraft({ ...draft, salvage: e.target.value })}
          />
        </Field>
        <Field label="Bought on">
          <Input
            type="date"
            value={draft.acquiredOn}
            onChange={(e) => setDraft({ ...draft, acquiredOn: e.target.value })}
          />
        </Field>
        <Field label="How it wears out">
          <Select
            value={draft.method}
            onChange={(e) => setDraft({ ...draft, method: e.target.value })}
          >
            <option value="straight-line">the same every month</option>
            <option value="reducing-balance">
              faster at first (reducing balance)
            </option>
          </Select>
        </Field>
        {draft.method === "reducing-balance" ? (
          <Field label="Rate a year" hint="25 means 25%.">
            <Input
              inputMode="decimal"
              value={draft.ratePercent}
              onChange={(e) =>
                setDraft({ ...draft, ratePercent: e.target.value })
              }
            />
          </Field>
        ) : null}
        <Field label="How many months it lasts">
          <Input
            inputMode="numeric"
            value={draft.lifeMonths}
            onChange={(e) => setDraft({ ...draft, lifeMonths: e.target.value })}
          />
        </Field>
      </div>

      <div className="flex flex-wrap gap-3">
        {picker(
          "The asset account",
          "assetAccountId",
          undefined,
          (a) => a.type === "asset",
        )}
        {picker(
          "Accumulated depreciation",
          "accumulatedAccountId",
          "A second asset account, which holds what has been taken.",
          (a) => a.type === "asset",
        )}
        {picker(
          "The expense",
          "expenseAccountId",
          undefined,
          (a) => a.type === "expense",
        )}
        {picker(
          "Paid from",
          "paidFromAccountId",
          "Leave blank if the purchase is already in your books on a bill.",
          (a) => a.type === "asset" || a.type === "liability",
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={muted}>
          {schedule.data
            ? `About ${formatMoney(first)} a month, ${schedule.data.slices.length} months, ${formatMoney(schedule.data.totalCents)} in all.`
            : "Fill in the cost, the date and the life to see what it costs a month."}
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={
              save.isPending ||
              !draft.name.trim() ||
              !draft.assetAccountId ||
              !draft.expenseAccountId ||
              !draft.accumulatedAccountId
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Add it"}
          </Button>
        </div>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * Selling it, scrapping it, or writing it off.
 *
 * Three things have to happen at once: the cost comes off, everything taken so
 * far comes off with it, and the difference between what is left and what was
 * received is this year's gain or loss. Doing half of it leaves an asset the
 * business no longer owns on its balance sheet forever, which is the commonest
 * thing wrong with a small business's books.
 */
function DisposeAsset({
  asset,
  accounts,
  onDone,
}: {
  asset: FixedAsset;
  accounts: Account[];
  onDone: () => void;
}) {
  const [proceeds, setProceeds] = useState("");
  const [receivedIntoAccountId, setReceived] = useState("");
  const [gainLossAccountId, setGainLoss] = useState("");

  const proceedsCents = toCents(proceeds);
  const difference = proceedsCents - asset.bookValueCents;

  const dispose = useMutation({
    mutationFn: () =>
      api(`/api/fixed-assets/${asset.id}/dispose`, {
        method: "POST",
        body: JSON.stringify({
          proceedsCents,
          ...(proceedsCents > 0 ? { receivedIntoAccountId } : {}),
          gainLossAccountId,
        }),
      }),
    onSuccess: onDone,
  });

  return (
    <Card className="space-y-3">
      <p className="text-sm font-medium">
        {asset.name} — worth {formatMoney(asset.bookValueCents)} on the books
      </p>
      <div className="flex flex-wrap gap-3">
        <Field label="Sold for" hint="Nothing, if it was scrapped.">
          <Input
            inputMode="decimal"
            value={proceeds}
            onChange={(e) => setProceeds(e.target.value)}
          />
        </Field>
        {proceedsCents > 0 ? (
          <Field label="Money went into">
            <Select
              value={receivedIntoAccountId}
              onChange={(e) => setReceived(e.target.value)}
            >
              <option value="">Choose</option>
              {accounts
                .filter((a) => a.type === "asset")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} {a.name}
                  </option>
                ))}
            </Select>
          </Field>
        ) : null}
        <Field
          label={difference >= 0 ? "Gain goes to" : "Loss goes to"}
          hint="An income or expense account for gains on disposal."
        >
          <Select
            value={gainLossAccountId}
            onChange={(e) => setGainLoss(e.target.value)}
          >
            <option value="">Choose</option>
            {accounts
              .filter((a) => a.type === "income" || a.type === "expense")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
          </Select>
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span style={muted}>
          {difference === 0
            ? "Sold for exactly what it is worth on the books."
            : difference > 0
              ? `A gain of ${formatMoney(difference)}.`
              : `A loss of ${formatMoney(-difference)}.`}
        </span>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button
            disabled={
              dispose.isPending ||
              !gainLossAccountId ||
              (proceedsCents > 0 && !receivedIntoAccountId)
            }
            onClick={() => dispose.mutate()}
          >
            {dispose.isPending ? "Posting…" : "It has gone"}
          </Button>
        </div>
      </div>
      {dispose.error ? <ErrorNote error={dispose.error} /> : null}
    </Card>
  );
}

type Budget = { id: string; name: string; year: number };

type StoredBudgetLine = {
  accountId: string;
  month: number;
  amountCents: number;
};

type BudgetRow = {
  accountId: string;
  code: string;
  name: string;
  budgetedCents: number;
  actualCents: number;
  varianceCents: number;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export function Budgets() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [year, setYear] = useState(String(new Date().getFullYear()));
  const [chosen, setChosen] = useState("");
  /** 0 is the whole year, which is how most small businesses budget. */
  const [month, setMonth] = useState(0);
  /** What has been typed but not yet saved, in whole currency units. */
  const [edits, setEdits] = useState<Record<string, string>>({});

  const budgets = useQuery({
    queryKey: ["budgets"],
    queryFn: () => api<{ budgets: Budget[] }>("/api/budgets"),
  });
  const accounts = useQuery({
    queryKey: ["accounts"],
    queryFn: () => api<{ accounts: Account[] }>("/api/accounts"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/budgets", {
        method: "POST",
        body: JSON.stringify({ name, year: Number(year) }),
      }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["budgets"] });
    },
  });

  const id = chosen || budgets.data?.budgets[0]?.id || "";
  const actuals = useQuery({
    queryKey: ["budget-actuals", id, month],
    queryFn: () =>
      api<{
        budget: Budget;
        month: number | null;
        lines: StoredBudgetLine[];
        rows: BudgetRow[];
      }>(`/api/budgets/${id}/actuals${month ? `?month=${month}` : ""}`),
    enabled: Boolean(id),
  });

  /**
   * The whole grid is sent, not the row that changed.
   *
   * A budget is read as a set of figures that add up to a plan, and a
   * half-applied grid is a plan nobody typed — so the server replaces the lot.
   * Which means the screen has to send back the months it is not showing:
   * editing March must not quietly delete the figure somebody set for the
   * year, or for April.
   */
  const save = useMutation({
    mutationFn: () => {
      const untouched = (actuals.data?.lines ?? []).filter(
        (line) => line.month !== month || !(line.accountId in edits),
      );
      const changed = Object.entries(edits)
        .map(([accountId, value]) => ({
          accountId,
          month,
          amountCents: toCents(value),
        }))
        .filter((line) => line.amountCents > 0);
      return api(`/api/budgets/${id}/lines`, {
        method: "PUT",
        body: JSON.stringify({ lines: [...untouched, ...changed] }),
      });
    },
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ["budget-actuals", id] });
    },
  });

  /** Every account worth budgeting for, with whatever is already set on it. */
  const budgetable = (accounts.data?.accounts ?? []).filter(
    (account) => account.type === "expense" || account.type === "income",
  );
  /** What is stored against the period on screen, not what is derived for it. */
  const storedFor = (accountId: string) =>
    (actuals.data?.lines ?? [])
      .filter((line) => line.accountId === accountId && line.month === month)
      .reduce((sum, line) => sum + line.amountCents, 0);
  const budgetedFor = (accountId: string) =>
    actuals.data?.rows.find((row) => row.accountId === accountId)
      ?.budgetedCents ?? 0;
  const actualFor = (accountId: string) =>
    actuals.data?.rows.find((row) => row.accountId === accountId)
      ?.actualCents ?? 0;
  const valueFor = (accountId: string) =>
    edits[accountId] ??
    (storedFor(accountId) ? (storedFor(accountId) / 100).toFixed(2) : "");

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_7rem_auto]">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Operating budget"
            />
          </Field>
          <Field label="Year">
            <Input value={year} onChange={(e) => setYear(e.target.value)} />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => create.mutate()}
              disabled={create.isPending || !name}
            >
              Create
            </Button>
          </div>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {id ? (
        <Card>
          <div className="grid gap-3 sm:grid-cols-2">
            {budgets.data && budgets.data.budgets.length > 1 ? (
              <Field label="Budget">
                <Select
                  value={id}
                  onChange={(e) => {
                    setChosen(e.target.value);
                    setEdits({});
                  }}
                >
                  {budgets.data.budgets.map((budget) => (
                    <option key={budget.id} value={budget.id}>
                      {budget.name} ({budget.year})
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <Field label="Period">
              <Select
                value={String(month)}
                onChange={(e) => {
                  setMonth(Number(e.target.value));
                  setEdits({});
                }}
              >
                <option value="0">The whole year</option>
                {MONTHS.map((label, i) => (
                  <option key={label} value={i + 1}>
                    {label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Card>
      ) : null}

      {!id ? (
        <Empty title="No budget yet">
          Create one, then set a figure against the accounts you plan by.
        </Empty>
      ) : null}
      {actuals.isLoading && id ? <Loading /> : null}
      {actuals.error ? <ErrorNote error={actuals.error} /> : null}

      {id && budgetable.length > 0 ? (
        <Card>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-sm font-medium">
              {actuals.data?.budget.name ?? "Budget"} —{" "}
              {month ? `${MONTHS[month - 1]} ` : ""}
              {actuals.data?.budget.year ?? year}
            </p>
            <Button
              onClick={() => save.mutate()}
              disabled={save.isPending || Object.keys(edits).length === 0}
            >
              Save figures
            </Button>
          </div>
          <Table
            headers={[
              "Code",
              "Account",
              {
                label: month
                  ? `Budget for ${MONTHS[month - 1]}`
                  : "Budget for the year",
                money: true,
              },
              { label: "Allowed", money: true },
              { label: "Actual", money: true },
              { label: "Left", money: true },
            ]}
          >
            {budgetable.map((account) => {
              const spent = actualFor(account.id);
              const allowed = edits[account.id]
                ? budgetedFor(account.id) -
                  storedFor(account.id) +
                  toCents(edits[account.id] as string)
                : budgetedFor(account.id);
              return (
                <Row key={account.id}>
                  <td className="py-2 font-medium">{account.code}</td>
                  <td>{account.name}</td>
                  <td>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={valueFor(account.id)}
                      onChange={(e) =>
                        setEdits({ ...edits, [account.id]: e.target.value })
                      }
                    />
                  </td>
                  <td className="money">{formatMoney(allowed)}</td>
                  <td className="money">{formatMoney(spent)}</td>
                  <td
                    className="money"
                    style={
                      allowed > 0 && allowed - spent < 0
                        ? { color: "var(--color-danger)" }
                        : undefined
                    }
                  >
                    {allowed > 0 ? formatMoney(allowed - spent) : "—"}
                  </td>
                </Row>
              );
            })}
          </Table>
          <p className="mt-2 text-xs" style={muted}>
            {month
              ? `A figure here is for ${MONTHS[month - 1]} alone. "Allowed" adds a twelfth of anything set for the whole year, because that is what a yearly figure means for one month of it.`
              : "A figure here is for the whole year. The actuals beside it are what the ledger says happened in it."}
          </p>
          {save.error ? <ErrorNote error={save.error} /> : null}
        </Card>
      ) : null}
    </div>
  );
}
type BookTax = {
  id: string;
  name: string;
  rateBp: number;
  categoryCode: string;
  active: boolean;
  appliesTo: string;
  compound: boolean;
  withholding: boolean;
  recoverable: boolean;
  regime: string | null;
  jurisdiction: string | null;
};

type Rate = { id: string; code: string; rateMicro: number; asOf: string };

/**
 * What a regime's rates are called where a person reads them.
 *
 * The regimes themselves come from the server — it holds the presets, and a
 * second list here was a second list to remember: adding one there and not
 * here would have left it unofferable, and the route that serves them was
 * fetched by nothing at all.
 */
const REGIME_LABELS: Record<string, string> = {
  us: "United States",
  ca: "Canada",
  uk: "United Kingdom",
  eu: "European Union",
};

/**
 * One rate a regime would add, as the server describes it.
 *
 * Only the name, the rate and the tax category are on every preset. The rest
 * are set where they say something — a US sales tax rate is not reclaimable
 * and says so; UK VAT carries no such field, and rendering its absence as
 * "no" told a business it could not reclaim its VAT, which is both wrong and
 * exactly the kind of wrong a screen should never invent.
 */
type TaxPreset = {
  name: string;
  rateBp: number;
  categoryCode: string;
  description?: string;
  appliesTo?: string;
  recoverable?: boolean;
};

/** 875 → "8.75%". Rates are basis points everywhere they are stored. */
function asPercent(rateBp: number): string {
  return `${(rateBp / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

/**
 * Tax and currency — the parts of both that only the books care about.
 *
 * The rate itself, its name and its category belong to Invoicing, because they
 * appear on a document. Whether a rate compounds, is withheld, or comes back on
 * a purchase changes the journal entry rather than the document, so it is set
 * here. One list of rates either way: two would be two answers to what the
 * standard rate is.
 */
/**
 * Closing the books to a date.
 *
 * Its own card on this screen rather than a hidden setting, because the thing
 * it prevents is invisible: until now anybody with invoicing permission could
 * post into a month that had already been reported on, and nothing anywhere
 * said so. A business that has filed a return needs those figures to stay
 * filed.
 */
/**
 * Drawing a line under a year.
 *
 * Until a year is closed, "what the business has kept" is a subtraction done
 * on the spot — every penny of profit it has ever made, recomputed on every
 * request — and a profit and loss for this year has to be read by taking last
 * year's off the total. Closing posts one entry that empties every income and
 * expense account into equity, so the new year starts at zero because its
 * accounts do.
 *
 * The figure is shown before the button is pressed, from the same code that
 * posts it. An accountant checks it against their own working, and finding out
 * by posting is the wrong order.
 */
type Payee = {
  id: string;
  name: string;
  kind: string;
  accountLast4: string | null;
};

type BankPayment = {
  id: string;
  payeeId: string;
  amountCents: number;
  description: string | null;
  status: string;
  expectedAt: string | null;
  lastError: string | null;
  createdAt: string;
};

type PaymentSchedule = {
  id: string;
  payeeId: string;
  amountCents: number;
  description: string | null;
  every: string;
  startsOn: string;
  active: boolean;
};

/**
 * Sending money, which is the one thing here that cannot be taken back.
 *
 * Everything else on these screens can be corrected. A payment that has left
 * the bank has left the bank — so this screen asks for confirmation of the
 * name and the last four digits before the button does anything, offers
 * nothing the connected bank cannot actually do, and is hidden entirely from
 * somebody who keeps the books but is not trusted to move money.
 */
function BankPaymentsCard() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [draft, setDraft] = useState({
    payeeId: "",
    connectionId: "",
    fromAccountReference: "",
    fromLedgerAccountId: "",
    amount: "",
    description: "",
    every: "",
    startsOn: "",
  });
  const [payee, setPayee] = useState({
    name: "",
    accountNumber: "",
    routingNumber: "",
    kind: "business",
  });

  const payees = useQuery({
    queryKey: ["payees"],
    queryFn: () => api<{ payees: Payee[]; maySend: boolean }>("/api/payees"),
  });
  const payments = useQuery({
    queryKey: ["bank-payments"],
    queryFn: () =>
      api<{ payments: BankPayment[]; schedules: PaymentSchedule[] }>(
        "/api/bank-payments",
      ),
  });
  const connections = useQuery({
    queryKey: ["bank-feeds"],
    queryFn: () => api<{ connections: BankConnection[] }>("/api/bank-feeds"),
  });
  const providers = useQuery({
    queryKey: ["bank-providers"],
    queryFn: () =>
      api<{ providers: BankProviderInfo[] }>("/api/bank-feeds/providers"),
  });
  const accounts = useQuery({
    queryKey: ["bank-accounts"],
    queryFn: () => api<{ bankAccounts: Account[] }>("/api/bank-accounts"),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["payees"] });
    qc.invalidateQueries({ queryKey: ["bank-payments"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
  };

  const addPayee = useMutation({
    mutationFn: () =>
      api("/api/payees", { method: "POST", body: JSON.stringify(payee) }),
    onSuccess: () => {
      setPayee({
        name: "",
        accountNumber: "",
        routingNumber: "",
        kind: "business",
      });
      setAdding(false);
      refresh();
    },
  });

  const send = useMutation({
    mutationFn: () =>
      api("/api/bank-payments", {
        method: "POST",
        body: JSON.stringify({
          payeeId: draft.payeeId,
          connectionId: draft.connectionId,
          fromAccountReference: draft.fromAccountReference,
          fromLedgerAccountId: draft.fromLedgerAccountId || null,
          amountCents: toCents(draft.amount),
          description: draft.description,
          /**
           * One key per attempt, made when the form is submitted.
           *
           * Two presses of a slow button are one payment: the second finds the
           * first rather than sending again.
           */
          idempotencyKey: crypto.randomUUID(),
        }),
      }),
    onSuccess: () => {
      setConfirming(false);
      setDraft({ ...draft, amount: "", description: "" });
      refresh();
    },
  });

  const schedule = useMutation({
    mutationFn: () =>
      api("/api/bank-payments/recurring", {
        method: "POST",
        body: JSON.stringify({
          payeeId: draft.payeeId,
          connectionId: draft.connectionId,
          fromAccountReference: draft.fromAccountReference,
          fromLedgerAccountId: draft.fromLedgerAccountId || null,
          amountCents: toCents(draft.amount),
          description: draft.description,
          every: draft.every,
          startsOn: draft.startsOn
            ? new Date(draft.startsOn).toISOString()
            : "",
        }),
      }),
    onSuccess: () => {
      setConfirming(false);
      refresh();
    },
  });

  const stop = useMutation({
    mutationFn: (id: string) =>
      api(`/api/bank-payments/recurring/${id}/stop`, { method: "POST" }),
    onSuccess: refresh,
  });

  /**
   * Taking somebody off the list.
   *
   * Retired rather than deleted: payments already sent point at them, and a
   * payment whose payee has vanished cannot be explained to anybody.
   */
  const removePayee = useMutation({
    mutationFn: (id: string) => api(`/api/payees/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  /**
   * Hidden entirely, not disabled.
   *
   * Somebody who keeps the books and is not trusted to move money should not
   * be looking at a payment form all day wondering why it refuses.
   */
  if (payees.data && !payees.data.maySend) {
    return (
      <Card>
        <p className="text-sm font-medium">Paying from the bank</p>
        <p className="text-sm" style={muted}>
          An administrator sends payments. It is kept separate from keeping the
          books on purpose — it is the one thing here that cannot be undone.
        </p>
      </Card>
    );
  }

  const linked = connections.data?.connections ?? [];
  const chosenConnection = linked.find((c) => c.id === draft.connectionId);
  const capability = (providers.data?.providers ?? []).find(
    (p) => p.id === chosenConnection?.provider,
  );
  const chosenPayee = (payees.data?.payees ?? []).find(
    (p) => p.id === draft.payeeId,
  );
  const nameOf = (id: string) =>
    (payees.data?.payees ?? []).find((p) => p.id === id)?.name ?? "—";

  const ready =
    Boolean(draft.payeeId) &&
    Boolean(draft.connectionId) &&
    Boolean(draft.fromAccountReference) &&
    toCents(draft.amount) > 0;

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Paying from the bank</p>
          <p className="text-sm" style={muted}>
            Money leaves the account you choose. Nothing here can be undone once
            the bank has it.
          </p>
        </div>
        <Button variant="secondary" onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "Add somebody to pay"}
        </Button>
      </div>

      {adding ? (
        <div className="flex flex-wrap items-end gap-3 border-b pb-3">
          <Field label="Their name">
            <Input
              value={payee.name}
              onChange={(e) => setPayee({ ...payee, name: e.target.value })}
            />
          </Field>
          <Field label="They are a">
            <Select
              value={payee.kind}
              onChange={(e) => setPayee({ ...payee, kind: e.target.value })}
            >
              <option value="business">business</option>
              <option value="personal">person</option>
            </Select>
          </Field>
          <Field label="Routing number" hint="Nine digits.">
            <Input
              value={payee.routingNumber}
              onChange={(e) =>
                setPayee({ ...payee, routingNumber: e.target.value })
              }
            />
          </Field>
          <Field
            label="Account number"
            hint="Stored sealed. Only the last four are ever shown again."
          >
            <Input
              value={payee.accountNumber}
              onChange={(e) =>
                setPayee({ ...payee, accountNumber: e.target.value })
              }
            />
          </Field>
          <Button
            disabled={addPayee.isPending || !payee.name.trim()}
            onClick={() => addPayee.mutate()}
          >
            {addPayee.isPending ? "Saving…" : "Save"}
          </Button>
          {addPayee.error ? <ErrorNote error={addPayee.error} /> : null}
        </div>
      ) : null}

      {(payees.data?.payees ?? []).length > 0 ? (
        <ul className="space-y-1 text-sm">
          {(payees.data?.payees ?? []).map((p) => (
            <li key={p.id} className="flex justify-between">
              <span>
                {p.name}
                {p.accountLast4 ? (
                  <span style={muted}> ····{p.accountLast4}</span>
                ) : null}
              </span>
              <button
                type="button"
                className="text-xs underline"
                disabled={removePayee.isPending}
                onClick={() => removePayee.mutate(p.id)}
              >
                remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {removePayee.error ? <ErrorNote error={removePayee.error} /> : null}

      {linked.length === 0 ? (
        <p className="text-sm" style={muted}>
          Connect a bank first — payments leave one of its accounts.
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Pay">
            <Select
              value={draft.payeeId}
              onChange={(e) => setDraft({ ...draft, payeeId: e.target.value })}
            >
              <option value="">Choose</option>
              {(payees.data?.payees ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.accountLast4 ? ` ····${p.accountLast4}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Select
              value={draft.connectionId}
              onChange={(e) =>
                setDraft({ ...draft, connectionId: e.target.value })
              }
            >
              <option value="">Choose a bank</option>
              {linked.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.institutionName ?? c.provider}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Account" hint="The bank's own reference for it.">
            <Input
              value={draft.fromAccountReference}
              onChange={(e) =>
                setDraft({ ...draft, fromAccountReference: e.target.value })
              }
            />
          </Field>
          <Field label="In the books">
            <Select
              value={draft.fromLedgerAccountId}
              onChange={(e) =>
                setDraft({ ...draft, fromLedgerAccountId: e.target.value })
              }
            >
              <option value="">do not post it</option>
              {(accounts.data?.bankAccounts ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} {a.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Amount">
            <Input
              inputMode="decimal"
              value={draft.amount}
              onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
            />
          </Field>
          <Field label="What it is for">
            <Input
              value={draft.description}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value })
              }
            />
          </Field>
          <Button disabled={!ready} onClick={() => setConfirming(true)}>
            Continue
          </Button>
        </div>
      )}

      {/**
       * The last thing before the money goes.
       *
       * The name and the last four digits, said back, because the commonest
       * way money reaches the wrong account is a right-looking form filled in
       * against the wrong person.
       */}
      {confirming && chosenPayee ? (
        <div className="space-y-2 rounded border p-3">
          <p className="text-sm">
            Send <strong>{formatMoney(toCents(draft.amount))}</strong> to{" "}
            <strong>{chosenPayee.name}</strong>
            {chosenPayee.accountLast4
              ? `, account ending ${chosenPayee.accountLast4}`
              : ""}
            . This cannot be undone once the bank has it.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <Button disabled={send.isPending} onClick={() => send.mutate()}>
              {send.isPending ? "Sending…" : "Send it"}
            </Button>
            {/**
             * Only where the provider schedules them itself. Running our own
             * timer would make a business's rent depend on this server being
             * awake at the right minute.
             */}
            {capability?.recurringPayments ? (
              <>
                <Field label="Repeat">
                  <Select
                    value={draft.every}
                    onChange={(e) =>
                      setDraft({ ...draft, every: e.target.value })
                    }
                  >
                    <option value="">just this once</option>
                    <option value="week">every week</option>
                    <option value="month">every month</option>
                    <option value="quarter">every quarter</option>
                    <option value="year">every year</option>
                  </Select>
                </Field>
                {draft.every ? (
                  <>
                    <Field label="Starting">
                      <Input
                        type="date"
                        value={draft.startsOn}
                        onChange={(e) =>
                          setDraft({ ...draft, startsOn: e.target.value })
                        }
                      />
                    </Field>
                    <Button
                      variant="secondary"
                      disabled={schedule.isPending || !draft.startsOn}
                      onClick={() => schedule.mutate()}
                    >
                      {schedule.isPending ? "Setting up…" : "Set it up"}
                    </Button>
                  </>
                ) : null}
              </>
            ) : (
              <span style={muted}>
                {chosenConnection?.institutionName ?? "This bank"} cannot
                schedule repeating payments.
              </span>
            )}
            <Button variant="secondary" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
          {send.error ? <ErrorNote error={send.error} /> : null}
          {schedule.error ? <ErrorNote error={schedule.error} /> : null}
        </div>
      ) : null}

      {(payments.data?.schedules ?? []).length > 0 ? (
        <div>
          <p className="mb-1 text-sm font-medium">Repeating</p>
          <ul className="space-y-1 text-sm">
            {(payments.data?.schedules ?? []).map((s) => (
              <li key={s.id} className="flex justify-between">
                <span>
                  {formatMoney(s.amountCents)} to {nameOf(s.payeeId)}{" "}
                  <span style={muted}>
                    every {s.every} from {formatDate(s.startsOn)}
                    {s.active ? "" : " · stopped"}
                  </span>
                </span>
                {s.active ? (
                  <button
                    type="button"
                    className="text-xs underline"
                    disabled={stop.isPending}
                    onClick={() => stop.mutate(s.id)}
                  >
                    stop
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {(payments.data?.payments ?? []).length > 0 ? (
        <Table
          headers={[
            "Sent",
            "To",
            "For",
            { label: "Amount", money: true },
            "State",
          ]}
        >
          {(payments.data?.payments ?? []).slice(0, 20).map((p) => (
            <Row key={p.id}>
              <td className="py-2">{formatDate(p.createdAt)}</td>
              <td>{nameOf(p.payeeId)}</td>
              <td>{p.description ?? "—"}</td>
              <td className="money">{formatMoney(p.amountCents)}</td>
              <td style={muted}>
                {p.status}
                {p.lastError ? ` — ${p.lastError}` : ""}
              </td>
            </Row>
          ))}
        </Table>
      ) : null}
      {payments.error ? <ErrorNote error={payments.error} /> : null}
      {stop.error ? <ErrorNote error={stop.error} /> : null}
    </Card>
  );
}

type Contractor = {
  contactId: string;
  reportable: boolean;
  legalName: string | null;
  entityType: string | null;
  hasTaxId: boolean;
  taxIdLast4: string | null;
  addressLine1: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

type Form1099Row = {
  contactId: string;
  legalName: string | null;
  taxIdLast4: string | null;
  totalCents: number;
  excludedCents: number;
  reportable: boolean;
  missing: string[];
};

/**
 * The form a US business files in January about who it paid.
 *
 * Pay an unincorporated contractor $600 or more in a calendar year and a
 * 1099-NEC is due. The point of showing it here in December rather than
 * producing it in January is the "still needed" column: a taxpayer number that
 * was never collected means chasing somebody who has moved on.
 *
 * Nothing here files anything. It is the figures the form is filled in from,
 * with what each is made of, so a bookkeeper can check them rather than trust
 * them.
 */
function Contractors() {
  const qc = useQueryClient();
  const [year, setYear] = useState(String(new Date().getUTCFullYear()));
  const [editing, setEditing] = useState<string | null>(null);

  const vendors = useQuery({
    queryKey: ["vendors"],
    queryFn: () => api<{ vendors: Vendor[] }>("/api/bills/vendors"),
  });
  const contractors = useQuery({
    queryKey: ["contractors"],
    queryFn: () => api<{ contractors: Contractor[] }>("/api/contractors"),
  });
  const report = useQuery({
    queryKey: ["1099", year],
    queryFn: () =>
      api<{ thresholdCents: number; rows: Form1099Row[] }>(
        `/api/reports/1099?year=${year}`,
      ),
  });

  const nameOf = (id: string) =>
    vendors.data?.vendors.find((v) => v.id === id)?.name ?? id.slice(0, 8);

  const rows = report.data?.rows ?? [];

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-sm font-medium">Contractors and 1099s</p>
          <p className="text-sm" style={muted}>
            What each contractor was actually paid in the year, and what is
            still needed before a form can be filed.
          </p>
        </div>
        <Field label="Year">
          <Input
            inputMode="numeric"
            className="w-24"
            value={year}
            onChange={(e) => setYear(e.target.value)}
          />
        </Field>
      </div>

      {editing ? (
        <ContractorDetails
          contactId={editing}
          name={nameOf(editing)}
          existing={(contractors.data?.contractors ?? []).find(
            (c) => c.contactId === editing,
          )}
          onDone={() => {
            setEditing(null);
            qc.invalidateQueries({ queryKey: ["contractors"] });
            qc.invalidateQueries({ queryKey: ["1099"] });
          }}
        />
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Set up a contractor">
            <Select
              value=""
              onChange={(e) => e.target.value && setEditing(e.target.value)}
            >
              <option value="">Choose a supplier…</option>
              {(vendors.data?.vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing to report for {year}. Only suppliers you have set up as
          contractors appear here.
        </p>
      ) : (
        <Table
          headers={[
            "Contractor",
            "Number",
            { label: "Paid", money: true },
            { label: "On a card", money: true },
            "Still needed",
            "",
          ]}
        >
          {rows.map((row) => (
            <Row key={row.contactId}>
              <td className="py-2">
                {row.legalName ?? nameOf(row.contactId)}
                {row.reportable ? null : (
                  <span className="ml-2 text-xs" style={muted}>
                    under the threshold
                  </span>
                )}
              </td>
              <td style={muted}>
                {row.taxIdLast4 ? `••• ${row.taxIdLast4}` : "—"}
              </td>
              <td className="money">{formatMoney(row.totalCents)}</td>
              {/**
               * Card and network payments are the processor's 1099-K, not
               * this business's form. Shown rather than hidden: somebody who
               * knows what they paid needs to see why the figure differs.
               */}
              <td className="money" style={muted}>
                {row.excludedCents ? formatMoney(row.excludedCents) : ""}
              </td>
              <td style={row.missing.length > 0 ? undefined : muted}>
                {row.missing.length > 0 ? row.missing.join(", ") : "nothing"}
              </td>
              <td>
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setEditing(row.contactId)}
                >
                  details
                </button>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {report.error ? <ErrorNote error={report.error} /> : null}
      {contractors.error ? <ErrorNote error={contractors.error} /> : null}
    </Card>
  );
}

/**
 * A contractor's details, including the number that is never shown again.
 *
 * For most sole traders a taxpayer number is their social security number, so
 * it is sealed in the database and the screen only ever sees its last four.
 * Which means an address change cannot send the number back — and the server
 * treats an absent one as "leave it alone" rather than "clear it".
 */
function ContractorDetails({
  contactId,
  name,
  existing,
  onDone,
}: {
  contactId: string;
  name: string;
  existing?: Contractor;
  onDone: () => void;
}) {
  const [draft, setDraft] = useState({
    legalName: existing?.legalName ?? name,
    entityType: existing?.entityType ?? "individual",
    taxId: "",
    addressLine1: existing?.addressLine1 ?? "",
    city: existing?.city ?? "",
    region: existing?.region ?? "",
    postalCode: existing?.postalCode ?? "",
    reportable: existing?.reportable ?? true,
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/contractors/${contactId}`, {
        method: "PUT",
        body: JSON.stringify({
          ...draft,
          // Absent rather than empty, so saving an address change does not
          // wipe a number this screen was never shown.
          ...(draft.taxId ? { taxId: draft.taxId } : { taxId: undefined }),
        }),
      }),
    onSuccess: onDone,
  });

  return (
    <div className="space-y-3 border-b pb-3">
      <div className="flex flex-wrap gap-3">
        <Field label="Legal name" hint="The name on the form.">
          <Input
            value={draft.legalName}
            onChange={(e) => setDraft({ ...draft, legalName: e.target.value })}
          />
        </Field>
        <Field label="They are a">
          <Select
            value={draft.entityType}
            onChange={(e) => setDraft({ ...draft, entityType: e.target.value })}
          >
            <option value="individual">person</option>
            <option value="sole-proprietor">sole proprietor</option>
            <option value="partnership">partnership</option>
            <option value="llc">LLC</option>
            <option value="corporation">corporation</option>
          </Select>
        </Field>
        <Field
          label="Taxpayer number"
          hint={
            existing?.hasTaxId
              ? `Ending ${existing.taxIdLast4}. Leave blank to keep it.`
              : "Nine digits. Stored sealed; only the last four are ever shown."
          }
        >
          <Input
            value={draft.taxId}
            placeholder={existing?.hasTaxId ? "•••••••••" : "123-45-6789"}
            onChange={(e) => setDraft({ ...draft, taxId: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-3">
        <Field label="Address">
          <Input
            value={draft.addressLine1}
            onChange={(e) =>
              setDraft({ ...draft, addressLine1: e.target.value })
            }
          />
        </Field>
        <Field label="City">
          <Input
            value={draft.city}
            onChange={(e) => setDraft({ ...draft, city: e.target.value })}
          />
        </Field>
        <Field label="State">
          <Input
            className="w-20"
            value={draft.region}
            onChange={(e) => setDraft({ ...draft, region: e.target.value })}
          />
        </Field>
        <Field label="ZIP">
          <Input
            className="w-28"
            value={draft.postalCode}
            onChange={(e) => setDraft({ ...draft, postalCode: e.target.value })}
          />
        </Field>
        <label className="flex items-center gap-2 self-end text-sm">
          <input
            type="checkbox"
            checked={draft.reportable}
            onChange={(e) =>
              setDraft({ ...draft, reportable: e.target.checked })
            }
          />
          File a 1099 for them
        </label>
      </div>
      <div className="flex gap-2">
        <Button disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </div>
  );
}

function YearEnd() {
  const qc = useQueryClient();
  const [endsOn, setEndsOn] = useState("");

  const years = useQuery({
    queryKey: ["year-end"],
    queryFn: () =>
      api<{
        closes: { id: string; endsOn: string }[];
        lastClosedOn: string | null;
      }>("/api/year-end"),
  });

  const preview = useQuery({
    queryKey: ["year-end-preview", endsOn],
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(endsOn),
    // A year that cannot be closed answers 400, and that is the answer the
    // screen wants to show rather than retry.
    retry: false,
    queryFn: () =>
      api<{ retainedCents: number }>("/api/year-end/preview", {
        method: "POST",
        body: JSON.stringify({ endsOn }),
      }),
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["year-end"] });
    qc.invalidateQueries({ queryKey: ["journal"] });
    qc.invalidateQueries({ queryKey: ["balance-sheet"] });
    qc.invalidateQueries({ queryKey: ["profit-and-loss"] });
    qc.invalidateQueries({ queryKey: ["period"] });
  };

  const close = useMutation({
    mutationFn: () =>
      api("/api/year-end/close", {
        method: "POST",
        body: JSON.stringify({ endsOn }),
      }),
    onSuccess: () => {
      setEndsOn("");
      refresh();
    },
  });

  const reopen = useMutation({
    mutationFn: (year: string) =>
      api("/api/year-end/reopen", {
        method: "POST",
        body: JSON.stringify({ endsOn: year }),
      }),
    onSuccess: refresh,
  });

  const closed = years.data?.closes ?? [];

  return (
    <Card className="space-y-3">
      <div>
        <p className="text-sm font-medium">The end of a year</p>
        <p className="text-sm" style={muted}>
          Empties this year's income and expenses into what the business has
          kept, and locks the year so the figures stay what they were.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <Field label="Last day of the year">
          <Input
            type="date"
            value={endsOn}
            onChange={(e) => setEndsOn(e.target.value)}
          />
        </Field>
        <Button
          disabled={close.isPending || !preview.data}
          onClick={() => close.mutate()}
        >
          {close.isPending ? "Closing…" : "Close the year"}
        </Button>
        <span style={muted}>
          {preview.data
            ? preview.data.retainedCents >= 0
              ? `${formatMoney(preview.data.retainedCents)} would go to what the business has kept.`
              : `${formatMoney(-preview.data.retainedCents)} would come off what the business has kept.`
            : preview.error
              ? ""
              : "Pick the last day of the year to see what it comes to."}
        </span>
      </div>
      {preview.error ? <ErrorNote error={preview.error} /> : null}
      {close.error ? <ErrorNote error={close.error} /> : null}

      {closed.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {closed.map((year) => (
            <li key={year.id} className="flex justify-between">
              <span style={muted}>Closed to {formatDate(year.endsOn)}</span>
              {/**
               * An accountant coming back with a change is ordinary. Reopening
               * reverses the closing entry rather than deleting it, so the
               * balance sheet that was printed and signed still has something
               * behind it.
               */}
              <button
                type="button"
                className="text-xs underline"
                disabled={reopen.isPending}
                onClick={() => reopen.mutate(year.endsOn)}
              >
                reopen
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {reopen.error ? <ErrorNote error={reopen.error} /> : null}
      {years.error ? <ErrorNote error={years.error} /> : null}
    </Card>
  );
}

function ClosingTheBooks() {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<string | null>(null);

  const period = useQuery({
    queryKey: ["accounting-period"],
    queryFn: () =>
      api<{ closedThrough: string | null }>("/api/accounting/period"),
  });

  const save = useMutation({
    mutationFn: (closedThrough: string | null) =>
      api("/api/accounting/period", {
        method: "PUT",
        body: JSON.stringify({ closedThrough }),
      }),
    onSuccess: () => {
      setDraft(null);
      qc.invalidateQueries({ queryKey: ["accounting-period"] });
    },
  });

  const closed = period.data?.closedThrough ?? null;
  const value = draft ?? closed ?? "";

  return (
    <Card>
      <p className="mb-1 text-sm font-medium">Closing the books</p>
      <p className="mb-3 text-sm" style={muted}>
        {closed
          ? `Everything on or before ${closed} is closed. Nothing can be posted into it — no invoice, no payment, no expense — until the date is moved.`
          : "Nothing is closed. Anybody who can raise an invoice can post into a month you have already reported on, and nothing will say so."}
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Closed through">
          <Input
            type="date"
            max={new Date().toISOString().slice(0, 10)}
            value={value}
            onChange={(e) => setDraft(e.target.value)}
          />
        </Field>
        <Button
          onClick={() => save.mutate(value || null)}
          disabled={save.isPending || value === (closed ?? "")}
        >
          {save.isPending ? "Saving…" : "Close to this date"}
        </Button>
        {closed ? (
          <Button
            variant="secondary"
            onClick={() => save.mutate(null)}
            disabled={save.isPending}
          >
            Reopen
          </Button>
        ) : null}
      </div>
      {/*
        Reopening is offered rather than hidden. An accountant asking for a
        correction in a closed month has to be possible, or the lock becomes
        something people avoid setting in the first place.
      */}
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * The reports a licence pays for that nothing could open.
 *
 * Seven Pro reports are built. Three reached a screen — cash flow, trial
 * balance and who owes us, all on the dashboard — and four did not: what tax
 * is owed, where the money goes by category, who this business owes, and the
 * ledger as a file. Every one of them was written, gated, tested against its
 * numbers, and described in the plan as built.
 *
 * The tax summary is the one that matters most. It is what a return is filed
 * from, and a business paying for the accounting tier could not open it.
 */
type TaxSummary = {
  chargedCents: number;
  reclaimedCents: number;
  dueCents: number;
};

/**
 * What the report actually returns.
 *
 * `balanceCents`, not `cents`. Getting the name wrong put "$NaN" beside every
 * account on the screen — the route was right, the arithmetic was right, and
 * the only thing wrong was what this file expected to read. No test could see
 * it: a wrong property name on a correctly typed `unknown` response is
 * invisible until somebody looks at the page.
 */
type CategoryTotals = {
  income: AccountTotal[];
  expenses: AccountTotal[];
};

type AccountTotal = {
  accountId: string;
  code: string;
  name: string;
  balanceCents: number;
};

type Payable = {
  bills: {
    id: string;
    number: string | null;
    vendorName: string | null;
    dueDate: string | null;
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
};

const AGE_BUCKETS: [keyof Payable["aging"], string][] = [
  ["current", "Not yet due"],
  ["days30", "1–30 days"],
  ["days60", "31–60 days"],
  ["days90plus", "Over 60 days"],
];

export function Reports() {
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const range = `from=${from}&to=${to}`;

  const tax = useQuery({
    queryKey: ["tax-summary", from, to],
    queryFn: () => api<TaxSummary>(`/api/reports/tax-summary?${range}`),
  });
  const categories = useQuery({
    queryKey: ["by-category", from, to],
    queryFn: () => api<CategoryTotals>(`/api/reports/by-category?${range}`),
  });
  const payable = useQuery({
    queryKey: ["accounts-payable"],
    queryFn: () => api<Payable>("/api/reports/accounts-payable"),
  });

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[10rem_10rem_auto] sm:items-end">
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
          {/* A plain link, not a fetch: the response is a file with its own
              filename, and the browser already knows how to save one. */}
          <a
            className="text-sm underline"
            href={`/api/reports/export.csv?${range}`}
          >
            Download the ledger as a spreadsheet
          </a>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          Every entry between those dates, with its account and its side. What
          an accountant asks for when the answer cannot be “log in to our
          thing”.
        </p>
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold text-sm">Tax</h2>
        {tax.isLoading ? <Loading /> : null}
        {tax.error ? <ErrorNote error={tax.error} /> : null}
        {tax.data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <Figure label="Charged on sales" cents={tax.data.chargedCents} />
              <Figure
                label="Reclaimed on purchases"
                cents={tax.data.reclaimedCents}
              />
              <Figure label="Owed" cents={tax.data.dueCents} emphasise />
            </div>
            <p className="mt-2 text-xs" style={muted}>
              Read from the tax account in the ledger over the dates above, not
              recomputed from invoices — so it agrees with the books rather than
              with a second opinion about them. Check it against the return
              before filing.
            </p>
          </>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold text-sm">Where the money goes</h2>
        {categories.isLoading ? <Loading /> : null}
        {categories.error ? <ErrorNote error={categories.error} /> : null}
        {categories.data ? (
          <>
            <Breakdown title="Income" rows={categories.data.income} />
            <Breakdown title="Expenses" rows={categories.data.expenses} />
          </>
        ) : null}
      </Card>

      <Card>
        <h2 className="mb-2 font-semibold text-sm">What this business owes</h2>
        {payable.isLoading ? <Loading /> : null}
        {payable.error ? <ErrorNote error={payable.error} /> : null}
        {payable.data ? (
          payable.data.bills.length === 0 ? (
            <Empty title="Nothing outstanding">
              Approved bills with a balance appear here, oldest first.
            </Empty>
          ) : (
            <>
              <div className="mb-3 grid gap-3 sm:grid-cols-4">
                {AGE_BUCKETS.map(([key, label]) => (
                  <Figure
                    key={key}
                    label={label}
                    cents={payable.data.aging[key]}
                  />
                ))}
              </div>
              <Table
                headers={[
                  "Bill",
                  "Supplier",
                  "Due",
                  { label: "Outstanding", money: true },
                  "Age",
                ]}
              >
                {payable.data.bills.map((bill) => (
                  <Row key={bill.id}>
                    <td className="px-3 py-2">{bill.number ?? "—"}</td>
                    <td className="px-3 py-2">{bill.vendorName ?? "—"}</td>
                    <td className="px-3 py-2">
                      {bill.dueDate ? formatDate(bill.dueDate) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(bill.balanceDue)}
                    </td>
                    <td className="px-3 py-2">
                      {bill.ageDays > 0 ? `${bill.ageDays} days` : "—"}
                    </td>
                  </Row>
                ))}
              </Table>
            </>
          )
        ) : null}
      </Card>
    </div>
  );
}

/** One figure, in the shape the summary screen uses. */
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
      <p className="text-xs" style={muted}>
        {label}
      </p>
      <p
        className={
          emphasise
            ? "font-semibold text-xl tabular-nums"
            : "text-lg tabular-nums"
        }
      >
        {formatMoney(cents)}
      </p>
    </Card>
  );
}

function Breakdown({
  title,
  rows,
}: {
  title: string;
  rows: AccountTotal[];
}) {
  if (rows.length === 0) {
    return (
      <p className="mb-2 text-sm" style={muted}>
        No {title.toLowerCase()} in this period.
      </p>
    );
  }
  return (
    <div className="mb-3">
      <p className="mb-1 font-medium text-sm">{title}</p>
      <Table headers={["Account", { label: "Total", money: true }]}>
        {rows.map((row) => (
          <Row key={row.code}>
            <td className="px-3 py-2">
              <span style={muted}>{row.code}</span> {row.name}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {formatMoney(row.balanceCents)}
            </td>
          </Row>
        ))}
      </Table>
    </div>
  );
}

export function TaxAndCurrency() {
  const qc = useQueryClient();
  const [regime, setRegime] = useState("uk");
  const [code, setCode] = useState("");
  const [rate, setRate] = useState("");
  const [base, setBaseDraft] = useState("");

  const taxes = useQuery({
    queryKey: ["invoicing-taxes"],
    queryFn: () => api<{ taxes: BookTax[] }>("/api/invoicing/taxes"),
  });
  const currencies = useQuery({
    queryKey: ["currencies"],
    queryFn: () =>
      api<{ baseCurrency: string; rates: Rate[] }>(
        "/api/accounting/currencies",
      ),
  });

  /**
   * The regimes on offer, and what each of them would add.
   *
   * Pressing "Add these rates" used to be blind: a business chose a country
   * and found out what it had bought afterwards, on another screen. The route
   * that answers both questions has always existed and nothing called it.
   */
  const presets = useQuery({
    queryKey: ["tax-presets"],
    queryFn: () =>
      api<{ regimes: string[]; presets: Record<string, TaxPreset[]> }>(
        "/api/accounting/taxes/presets",
      ),
  });

  const install = useMutation({
    mutationFn: () =>
      api("/api/accounting/taxes/presets", {
        method: "POST",
        body: JSON.stringify({ regime }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoicing-taxes"] }),
  });

  const setFlag = useMutation({
    mutationFn: (input: { id: string; patch: Record<string, unknown> }) =>
      api(`/api/accounting/taxes/${input.id}`, {
        method: "PATCH",
        body: JSON.stringify(input.patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoicing-taxes"] }),
  });

  const addRate = useMutation({
    mutationFn: () =>
      api("/api/accounting/currencies", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim().toUpperCase(),
          // Typed as a rate, stored in millionths: 1.0925 → 1_092_500.
          rateMicro: Math.round(Number(rate) * 1_000_000),
        }),
      }),
    onSuccess: () => {
      setCode("");
      setRate("");
      qc.invalidateQueries({ queryKey: ["currencies"] });
    },
  });

  /**
   * What the books are kept in.
   *
   * The screen has always *shown* the base currency and never let anybody set
   * it, so an instance kept its books in whatever it was created with. The
   * route refuses the change once anything is posted — reinterpreting entries
   * converted into the old currency would restate every report the business
   * has ever run — and that refusal is worth showing rather than hiding the
   * field, because "why can I not change this" has an answer.
   */
  const setBase = useMutation({
    mutationFn: () =>
      api("/api/accounting/currencies/base", {
        method: "PUT",
        body: JSON.stringify({ code: base.trim().toUpperCase() }),
      }),
    onSuccess: () => {
      setBaseDraft("");
      // Every figure on every report is denominated in it.
      qc.invalidateQueries();
    },
  });

  const rows = (taxes.data?.taxes ?? []).filter((tax) => tax.active);

  return (
    <div className="space-y-4">
      <BankPaymentsCard />

      <Contractors />

      <YearEnd />

      <ClosingTheBooks />

      <Card>
        <p className="mb-2 text-sm font-medium">Start from a regime's rates</p>
        <div className="flex items-end gap-3">
          <Field label="Where you trade">
            <Select value={regime} onChange={(e) => setRegime(e.target.value)}>
              {(presets.data?.regimes ?? []).map((code) => (
                <option key={code} value={code}>
                  {REGIME_LABELS[code] ?? code}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            onClick={() => install.mutate()}
            disabled={install.isPending || !presets.data}
          >
            Add these rates
          </Button>
        </div>

        {/* What pressing that button will actually add. */}
        {presets.data?.presets[regime]?.length ? (
          <Table
            headers={["Rate", { label: "Percent", money: true }, "Category"]}
          >
            {(presets.data.presets[regime] ?? []).map((preset) => (
              <Row key={preset.name}>
                <td className="py-2">
                  {preset.name}
                  {preset.description ? (
                    <span className="block text-xs" style={muted}>
                      {preset.description}
                    </span>
                  ) : null}
                  {preset.appliesTo || preset.recoverable !== undefined ? (
                    <span className="block text-xs" style={muted}>
                      {[
                        preset.appliesTo
                          ? `charged on ${preset.appliesTo}`
                          : "",
                        preset.recoverable === undefined
                          ? ""
                          : preset.recoverable
                            ? "reclaimable"
                            : "not reclaimable",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  ) : null}
                </td>
                <td className="money">{asPercent(preset.rateBp)}</td>
                <td style={muted}>{preset.categoryCode}</td>
              </Row>
            ))}
          </Table>
        ) : null}

        <p className="mt-2 text-xs" style={muted}>
          Rates move, so these are a starting point you edit — nothing is ever
          added twice, and US sales tax has no national figure to ship.
        </p>
        {install.error ? <ErrorNote error={install.error} /> : null}
      </Card>

      {taxes.isLoading ? <Loading /> : null}
      {taxes.error ? <ErrorNote error={taxes.error} /> : null}
      {rows.length === 0 ? (
        <Empty title="No tax rates yet">
          Add a regime's rates above, or write your own on the invoice settings
          screen.
        </Empty>
      ) : (
        <Table
          headers={[
            "Rate",
            "Charged on",
            "Comes back",
            "Compound",
            "Withheld",
            "Where",
          ]}
        >
          {rows.map((tax) => (
            <Row key={tax.id}>
              <td className="py-2">
                <span className="font-medium">{tax.name}</span>{" "}
                <span style={muted}>{asPercent(tax.rateBp)}</span>
              </td>
              <td>
                <Select
                  value={tax.appliesTo}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { appliesTo: e.target.value },
                    })
                  }
                >
                  <option value="both">sales and purchases</option>
                  <option value="sales">sales</option>
                  <option value="purchases">purchases</option>
                </Select>
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.recoverable}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { recoverable: e.target.checked },
                    })
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.compound}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { compound: e.target.checked },
                    })
                  }
                />
              </td>
              <td>
                <input
                  type="checkbox"
                  checked={tax.withholding}
                  onChange={(e) =>
                    setFlag.mutate({
                      id: tax.id,
                      patch: { withholding: e.target.checked },
                    })
                  }
                />
              </td>
              <td style={muted}>{tax.jurisdiction ?? "—"}</td>
            </Row>
          ))}
        </Table>
      )}
      <p className="text-xs" style={muted}>
        "Comes back" is what separates VAT and GST from US sales tax: tax you
        reclaim on a purchase is a debit against what you owe, and tax you
        cannot is part of what the thing cost.
      </p>
      {setFlag.error ? <ErrorNote error={setFlag.error} /> : null}

      <Card>
        <p className="mb-2 text-sm font-medium">
          Currency — the books are kept in{" "}
          {currencies.data?.baseCurrency ?? "…"}
        </p>
        <div className="mb-3 grid gap-3 sm:grid-cols-[8rem_auto] sm:items-end">
          <Field
            label="Keep the books in"
            hint="Three letters, and only before anything is posted."
          >
            <Input
              value={base}
              onChange={(e) => setBaseDraft(e.target.value)}
              placeholder={currencies.data?.baseCurrency ?? "GBP"}
              maxLength={3}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => setBase.mutate()}
              disabled={setBase.isPending || base.trim().length !== 3}
            >
              {setBase.isPending ? "Changing…" : "Change"}
            </Button>
          </div>
        </div>
        {setBase.error ? <ErrorNote error={setBase.error} /> : null}
        <div className="grid gap-3 sm:grid-cols-[8rem_10rem_auto]">
          <Field label="Currency">
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="EUR"
              maxLength={3}
            />
          </Field>
          <Field
            label={`1 unit is worth (${currencies.data?.baseCurrency ?? ""})`}
          >
            <Input
              type="number"
              step="0.000001"
              min="0"
              placeholder="1.085000"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button
              onClick={() => addRate.mutate()}
              disabled={addRate.isPending || !code || !rate}
            >
              Record rate
            </Button>
          </div>
        </div>
        <p className="mt-2 text-xs" style={muted}>
          A document is converted at the rate recorded on or before its own
          date, so last year's accounts do not change when a rate does.
        </p>
        {addRate.error ? <ErrorNote error={addRate.error} /> : null}
      </Card>

      {currencies.data && currencies.data.rates.length > 0 ? (
        <Table headers={["Currency", { label: "Rate", money: false }, "As at"]}>
          {currencies.data.rates.map((r) => (
            <Row key={r.id}>
              <td className="py-2 font-medium">{r.code}</td>
              <td>{(r.rateMicro / 1_000_000).toFixed(6)}</td>
              <td style={muted}>{formatDate(r.asOf)}</td>
            </Row>
          ))}
        </Table>
      ) : null}
    </div>
  );
}
