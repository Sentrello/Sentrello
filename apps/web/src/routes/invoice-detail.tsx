import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Meta, api } from "../lib/api";
import { RelatedLink, useNavigation, useRecordTitle } from "../lib/navigation";
import { type TagChip, TagChips } from "../lib/tags";
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
  Table,
  border,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * One invoice, and everything that has happened to it.
 *
 * The reference puts three things on this screen and it is right about all
 * three: the document as the customer will see it, the money against it, and
 * the actions that make sense from here. What it does not do — and neither
 * does this — is let somebody quietly edit an invoice that has been issued.
 * That is a void or a credit note, because an issued document is a thing that
 * happened.
 */

interface Detail {
  invoice: {
    id: string;
    number: string;
    kind: string;
    status: string;
    currency: string;
    contactId: string | null;
    issueDate: string;
    dueDate: string | null;
    subtotalCents: number;
    discountCents: number;
    discountType: string | null;
    taxCents: number;
    totalCents: number;
    notes: string | null;
    paymentTerms: string | null;
    published: boolean;
    shareToken: string | null;
    viewCount: number;
    firstViewedAt: string | null;
    lastViewedAt: string | null;
    referenceInvoiceId: string | null;
  };
  /** The early-payment offer as the server sees it today, or none. */
  earlyPayment: {
    deadline: string | null;
    savingCents: number;
    discountedTotalCents: number;
    open: boolean;
  };
  earlyDiscountTakenCents: number;
  lines: {
    id: string;
    description: string;
    quantityMilli: number;
    unit: string;
    unitPriceCents: number;
    taxRateBp: number;
  }[];
  payments: {
    id: string;
    amountCents: number;
    method: string;
    receivedAt: string;
  }[];
  bands: { id: string; name: string; rateBp: number; taxCents: number }[];
  contact: { id: string; name: string; email: string | null } | null;
  /** What it has been labelled, for finding it again among four hundred. */
  tags: TagChip[];
  paidCents: number;
  balanceDue: number;
  computedStatus: string;
}

/** "1.5" reads better than "1.500". Quantity is stored in thousandths. */
function quantity(milli: number): string {
  const value = milli / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

export function InvoiceDetail() {
  const qc = useQueryClient();
  const { current, go } = useNavigation();
  const id = current.recordId;
  const [copied, setCopied] = useState(false);
  const [portalCopied, setPortalCopied] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => api<Detail>(`/api/invoices/${id}`),
    enabled: Boolean(id),
  });

  // Already in the cache from the shell's own fetch, so this costs no request.
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;

  // The document's own number, so a refreshed page still says INV-0023.
  useRecordTitle(data?.invoice.number);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["invoice", id] });
    qc.invalidateQueries({ queryKey: ["invoices"] });
    qc.invalidateQueries({ queryKey: ["invoice-counts"] });
  };

  const act = useMutation({
    mutationFn: (path: string) =>
      api<Record<string, unknown>>(`/api/invoices/${id}/${path}`, {
        method: "POST",
      }),
    onSuccess: refresh,
  });

  const share = useMutation({
    mutationFn: () =>
      api<{ url: string }>(`/api/invoices/${id}/share`, { method: "POST" }),
    onSuccess: (result) => {
      navigator.clipboard?.writeText(result.url);
      setCopied(true);
      refresh();
    },
  });

  /**
   * Everything this customer owes, on one link.
   *
   * The endpoint has existed since the portal was built and nothing called it,
   * so the portal could only be reached from an emailed invoice. This is where
   * somebody is standing when a customer asks "can you send me everything".
   */
  /**
   * Whether this invoice could be sent as a structured e-invoice, and what is
   * stopping it.
   *
   * Asked before the button is offered rather than discovered by pressing it.
   * In Italy, France, Germany and Poland a PDF is not an invoice any more, and
   * the first a business should hear of a missing country is not a failed
   * download at the moment they need to issue.
   */
  const eInvoice = useQuery({
    queryKey: ["einvoice", id],
    queryFn: () =>
      api<{
        ready: boolean;
        missing: string[];
        addressedTo: string;
        country: string | null;
      }>(`/api/invoices/${id}/einvoice`),
  });

  const portalLink = useMutation({
    mutationFn: (contactId: string) =>
      api<{ url: string }>(`/api/contacts/${contactId}/portal-link`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      navigator.clipboard?.writeText(result.url);
      setPortalCopied(true);
    },
  });

  if (!id) return <Empty title="No invoice selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { invoice, lines, payments, bands, contact } = data;
  const isDraft = invoice.status === "draft";
  const isVoid = invoice.status === "void";
  const isCredit = invoice.kind === "credit_note";

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-semibold text-lg">
                {isCredit ? "Credit note" : "Invoice"} {invoice.number}
              </p>
              <p className="text-sm" style={muted}>
                Issued {formatDate(invoice.issueDate)}
                {invoice.dueDate ? ` · due ${formatDate(invoice.dueDate)}` : ""}
              </p>
              {contact ? (
                <p className="mt-1 text-sm">
                  <span style={muted}>For </span>
                  <RelatedLink
                    to={{
                      moduleId: "contacts",
                      recordId: contact.id,
                      title: contact.name,
                    }}
                  >
                    {contact.name}
                  </RelatedLink>
                  {/* Their whole account, not just this document — the thing
                      asked for on the phone when somebody queries one bill.
                      Pro, so the link is not offered on Free: an endpoint that
                      answers 404 is the enforcement, and a link that leads to
                      one is just a dead end somebody reports as a bug. */}
                  {tier === "pro" ? (
                    <a
                      className="link ml-2 text-xs"
                      href={`/api/invoicing/statements/${contact.id}?format=html`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Statement of account
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className="link ml-2 text-xs"
                    onClick={() => portalLink.mutate(contact.id)}
                    disabled={portalLink.isPending}
                  >
                    {portalCopied ? "Portal link copied" : "Copy portal link"}
                  </button>
                </p>
              ) : null}
              {/* Labels, on the document rather than only on the customer: a
                  business chases "disputed" and "with the accountant", and
                  those are true of one invoice, not of everything they buy. */}
              <div className="mt-2">
                <TagChips
                  path={`/api/invoices/${invoice.id}`}
                  attached={data.tags ?? []}
                  onChanged={refresh}
                />
              </div>
            </div>

            {/*
              Whether the customer has opened it.

              A business chasing an unpaid invoice is in a completely different
              conversation depending on the answer, and "I never received it"
              is the most common thing said on that call.
            */}
            <div className="text-right text-sm" style={muted}>
              {invoice.firstViewedAt ? (
                <>
                  <p>Opened {formatDate(invoice.firstViewedAt)}</p>
                  <p className="text-xs">
                    {invoice.viewCount} time{invoice.viewCount === 1 ? "" : "s"}
                  </p>
                </>
              ) : invoice.published ? (
                <p>Not opened yet</p>
              ) : (
                <p>No link sent</p>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-0">
          <Table
            headers={[
              "Description",
              { label: "Qty", money: true },
              { label: "Unit price", money: true },
              { label: "Amount", money: true },
            ]}
          >
            {lines.map((line) => (
              <Row key={line.id}>
                <td className="py-2">{line.description}</td>
                <td className="money">
                  {quantity(line.quantityMilli)}
                  {line.unit && line.unit !== "piece" ? (
                    <span className="ml-1 text-xs" style={muted}>
                      {line.unit}
                    </span>
                  ) : null}
                </td>
                <td className="money">{formatMoney(line.unitPriceCents)}</td>
                <td className="money">
                  {formatMoney(
                    Math.round(
                      (line.quantityMilli / 1000) * line.unitPriceCents,
                    ),
                  )}
                </td>
              </Row>
            ))}
          </Table>
        </Card>

        {invoice.notes || invoice.paymentTerms ? (
          <Card>
            {invoice.paymentTerms ? (
              <p className="text-sm" style={muted}>
                {invoice.paymentTerms}
              </p>
            ) : null}
            {invoice.notes ? (
              <p className="mt-1 whitespace-pre-line text-sm">
                {invoice.notes}
              </p>
            ) : null}
          </Card>
        ) : null}
      </div>

      <div className="space-y-4">
        <Card>
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td style={muted}>Subtotal</td>
                <td className="money">{formatMoney(invoice.subtotalCents)}</td>
              </tr>
              {invoice.discountCents > 0 ? (
                <tr>
                  <td style={muted}>Discount</td>
                  <td className="money">
                    −{formatMoney(invoice.discountCents)}
                  </td>
                </tr>
              ) : null}
              {/*
                The tax as it was banded when the document was issued. Not
                recomputed: a rate that changed afterwards must not change what
                an invoice already said.
              */}
              {bands
                .filter((b) => b.taxCents !== 0)
                .map((band) => (
                  <tr key={band.id}>
                    <td style={muted}>{band.name}</td>
                    <td className="money">{formatMoney(band.taxCents)}</td>
                  </tr>
                ))}
              <tr className="border-t font-semibold" style={border}>
                <td className="pt-1">Total</td>
                <td className="money pt-1">
                  {formatMoney(invoice.totalCents)}
                </td>
              </tr>
              {data.paidCents > 0 ? (
                <tr>
                  <td style={muted}>Paid</td>
                  <td className="money">−{formatMoney(data.paidCents)}</td>
                </tr>
              ) : null}
              {!isDraft && !isVoid ? (
                <tr className="font-semibold">
                  <td>{data.balanceDue > 0 ? "Still due" : "Settled"}</td>
                  <td className="money">{formatMoney(data.balanceDue)}</td>
                </tr>
              ) : null}
            </tbody>
          </table>

          {/*
            The stored status against what the payments actually say.

            Shown rather than believed: a stored status that has drifted from
            the money is the kind of thing nobody notices until a customer
            asks why they were chased for something they paid.
          */}
          {!isDraft && data.computedStatus !== invoice.status ? (
            <p
              className="mt-2 text-xs"
              style={{ color: "var(--color-warning)" }}
            >
              Stored as “{invoice.status}”, but the payments say “
              {data.computedStatus}”.
            </p>
          ) : null}
        </Card>

        <Card>
          <p className="mb-2 font-medium">What can be done</p>
          <div className="flex flex-wrap gap-2">
            {isDraft ? (
              <Button
                onClick={() => act.mutate("issue")}
                disabled={act.isPending}
              >
                Issue it
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => share.mutate()}
              disabled={share.isPending}
            >
              {copied ? "Link copied" : "Copy a link"}
            </Button>
            {/*
              Taking it back offline. A document could be published to a link
              anybody holding it can open, and never withdrawn — the route to
              do so has existed since sharing did, called by nothing, and only
              looked reached because a generic action caller beside it matches
              any word in that position.
            */}
            {invoice.published ? (
              <Button
                variant="secondary"
                onClick={() => act.mutate("unshare")}
                disabled={act.isPending}
              >
                Stop sharing
              </Button>
            ) : null}
            <Button
              variant="secondary"
              onClick={() => act.mutate("duplicate")}
              disabled={act.isPending}
            >
              Duplicate
            </Button>
            {!isVoid && data.paidCents === 0 ? (
              <Button
                variant="danger"
                onClick={() => act.mutate("void")}
                disabled={act.isPending}
              >
                Void it
              </Button>
            ) : null}
            {data.paidCents > 0 && !isCredit ? (
              <Button
                variant="secondary"
                onClick={() => act.mutate("credit")}
                disabled={act.isPending}
              >
                Credit note
              </Button>
            ) : null}
            {/*
              A structured e-invoice, where the data allows one. Offered only
              when it would actually validate: a download that fails is worse
              than a button that explains itself.
            */}
            {eInvoice.data?.ready ? (
              <Button
                variant="secondary"
                onClick={() =>
                  window.open(
                    `/api/invoices/${id}/einvoice.xml`,
                    "_blank",
                    "noopener",
                  )
                }
              >
                E-invoice (XML)
              </Button>
            ) : null}
            {/*
              Why the button above is absent, when it is.

              Silence would be the wrong answer here: a business in the EU that
              needs a structured invoice would never learn the feature exists,
              and would find out from a rejected submission instead. Shown only
              once somebody has set their own country — a business that has
              never engaged with structured invoicing is not nagged about it on
              every invoice.
            */}
            {eInvoice.data && !eInvoice.data.ready && eInvoice.data.country ? (
              <p className="w-full text-xs" style={muted}>
                Not yet sendable as a structured e-invoice:{" "}
                {eInvoice.data.missing.join("; ")}.
              </p>
            ) : null}
            <button
              type="button"
              className="text-sm link-muted"
              onClick={() => go("invoicing", "Invoices")}
            >
              Back to the list
            </button>
          </div>
          {act.error ? <ErrorNote error={act.error} /> : null}
          {share.error ? <ErrorNote error={share.error} /> : null}
        </Card>

        {!isDraft && !isVoid ? (
          <Payments
            invoiceId={invoice.id}
            payments={payments}
            balanceDue={data.balanceDue}
            earlyPayment={data.earlyPayment}
            alreadyTaken={data.earlyDiscountTakenCents > 0}
            onDone={refresh}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * The money actually received, and a way to record more of it.
 *
 * Partial payments are the normal case, not the exception — a deposit and a
 * balance is how most trades are paid — so the box is prefilled with what is
 * still owed rather than with the invoice total.
 */
function Payments({
  invoiceId,
  payments,
  balanceDue,
  earlyPayment,
  alreadyTaken,
  onDone,
}: {
  invoiceId: string;
  payments: Detail["payments"];
  balanceDue: number;
  earlyPayment: Detail["earlyPayment"];
  alreadyTaken: boolean;
  onDone: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("manual");
  const [receivedAt, setReceivedAt] = useState("");
  const [takeDiscount, setTakeDiscount] = useState(false);
  const [gatewayRef, setGatewayRef] = useState("");

  /**
   * Whether there is a discount to take right now.
   *
   * The server decides: it computes the same terms this reads, and it refuses
   * a discount whose window has closed rather than settling the invoice for
   * less than it asks. Deciding it here as well would be two clocks.
   */
  const canTakeDiscount =
    Boolean(earlyPayment.deadline) && earlyPayment.open && !alreadyTaken;

  const record = useMutation({
    mutationFn: () =>
      api(`/api/invoices/${invoiceId}/payments`, {
        method: "POST",
        body: JSON.stringify({
          amountCents: Math.round(
            Number.parseFloat(amount.replace(/,/g, "") || "0") * 100,
          ),
          method,
          // Blank means today, which is the common case; a cheque that
          // cleared on Friday and is entered on Monday belongs to Friday.
          receivedAt: receivedAt || null,
          applyEarlyDiscount: takeDiscount,
          gatewayRef: gatewayRef.trim() || null,
        }),
      }),
    onSuccess: () => {
      setAmount("");
      setReceivedAt("");
      setTakeDiscount(false);
      setGatewayRef("");
      onDone();
    },
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Payments</p>

      {payments.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing received yet.
        </p>
      ) : (
        <ul className="mb-3 space-y-1 text-sm">
          {payments.map((payment) => (
            <li
              key={payment.id}
              className="flex items-baseline justify-between gap-2"
            >
              <span style={muted}>
                {formatDate(payment.receivedAt)}
                <span className="ml-1.5 text-xs">{payment.method}</span>
              </span>
              <span className="money">{formatMoney(payment.amountCents)}</span>
            </li>
          ))}
        </ul>
      )}

      {balanceDue > 0 ? (
        <div className="space-y-2 border-t pt-3" style={border}>
          <div className="grid gap-2 sm:grid-cols-3">
            <Field label="Record a payment">
              <Input
                value={amount}
                inputMode="decimal"
                placeholder={(balanceDue / 100).toFixed(2)}
                aria-label="Amount received"
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="How">
              {/* Recorded because a business reconciling a bank statement
                  needs to know which payments to look for in it. */}
              <Select
                value={method}
                aria-label="Payment method"
                onChange={(e) => setMethod(e.target.value)}
              >
                <option value="manual">Bank transfer</option>
                <option value="cash">Cash</option>
                <option value="card">Card</option>
                <option value="cheque">Cheque</option>
                <option value="other">Something else</option>
              </Select>
            </Field>
            <Field label="When">
              <Input
                type="date"
                value={receivedAt}
                aria-label="Date received"
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Reference"
            hint="What it says on the statement. Stored, never shown to the customer."
          >
            <Input
              value={gatewayRef}
              placeholder="FT24091200123"
              aria-label="Payment reference"
              onChange={(e) => setGatewayRef(e.target.value)}
            />
          </Field>
          {canTakeDiscount ? (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={takeDiscount}
                onChange={(e) => {
                  setTakeDiscount(e.target.checked);
                  // The discounted total is what they owe if they are taking
                  // it, so offering the old figure would invite a short
                  // payment that leaves a balance nobody owes.
                  if (e.target.checked) {
                    setAmount(
                      (earlyPayment.discountedTotalCents / 100).toFixed(2),
                    );
                  }
                }}
              />
              <span>
                They paid early — take {formatMoney(earlyPayment.savingCents)}{" "}
                off
                {earlyPayment.deadline ? (
                  <span style={muted}>
                    {" "}
                    (offer stands until {formatDate(earlyPayment.deadline)})
                  </span>
                ) : null}
              </span>
            </label>
          ) : null}

          <div className="flex items-center gap-2">
            <Button
              onClick={() => record.mutate()}
              disabled={record.isPending || !amount.trim()}
            >
              {record.isPending ? "Recording…" : "Record it"}
            </Button>
            <button
              type="button"
              className="text-sm link-muted"
              onClick={() => setAmount((balanceDue / 100).toFixed(2))}
            >
              Paid in full
            </button>
          </div>
          {record.error ? <ErrorNote error={record.error} /> : null}
        </div>
      ) : null}
    </Card>
  );
}
