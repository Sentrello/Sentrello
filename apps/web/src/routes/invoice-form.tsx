import { documentTotals } from "@sentrello/db/money";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type Contact, api } from "../lib/api";
import { Icon } from "../lib/icons";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Select,
  border,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * Writing an invoice.
 *
 * Three cards, in the order the reference puts them and for the reason it does:
 * who it is for and when it is due; what is on it; and what it comes to. The
 * middle one is where all the time goes, so it gets the width.
 *
 * The totals are worked out here as somebody types **and** on the server when
 * it saves. That is a deliberate second copy: a form that cannot show a
 * running total is a form people check on a calculator, and a total the
 * browser decides is a total a customer could edit. The screen's figure is a
 * preview; the server's is the invoice.
 */

interface TaxDefinition {
  id: string;
  name: string;
  rateBp: number;
  categoryCode: string;
  isDefault: boolean;
  active: boolean;
}

interface BillableItem {
  id: string;
  name: string;
  description: string | null;
  unitPriceCents: number;
  unit: string;
  taxDefinitionId: string | null;
  active: boolean;
}

/** Only the fields the editor puts back into its boxes. */
interface DocumentShape {
  contactId: string | null;
  notes: string | null;
  templateId: string | null;
  discountType: string | null;
  discountValue: number | null;
  dueDate?: string | null;
  paymentTerms?: string | null;
  validUntil?: string | null;
}

interface LineDraft {
  /**
   * A client-side identity, so React can tell two blank rows apart.
   *
   * Given at creation rather than using the array index: removing the second
   * of three lines with an index key makes React reuse the third row's DOM
   * for the second, and whatever was half-typed in it moves up a row.
   */
  key: string;
  billableItemId: string | null;
  description: string;
  /** What the box holds, as typed. Parsed on save, not on every keystroke. */
  quantity: string;
  unitPrice: string;
  unit: string;
  taxDefinitionId: string;
}

const blankLine = (unit = "piece"): LineDraft => ({
  key: crypto.randomUUID(),
  billableItemId: null,
  description: "",
  quantity: "1",
  unitPrice: "",
  // Whatever the business sells by first, so the common case needs no press.
  unit,
  taxDefinitionId: "",
});

/** "12.50" → 1250. Money is typed in units and stored in cents. */
function toCents(typed: string): number {
  const value = Number.parseFloat(typed.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** "1.5" → 1500. Quantity is thousandths, so half a day survives. */
function toMilli(typed: string): number {
  const value = Number.parseFloat(typed.replace(/,/g, ""));
  return Number.isFinite(value) ? Math.round(value * 1000) : 0;
}

export function InvoiceForm({
  documentId,
  asQuote = false,
  onDone,
}: {
  /**
   * Absent when raising a new one; the quote's id when `asQuote`.
   *
   * It used to be called `invoiceId`, was accepted, and was then used for
   * nothing but the heading: the form opened blank under "Edit invoice" and
   * saving POSTed, so editing a draft raised a second invoice and left the
   * first alone. It now loads the document and PATCHes it.
   */
  documentId?: string;
  /**
   * Writes a quote instead.
   *
   * One form, because a quote is the same document before it is owed — same
   * lines, same discount, same tax. Two forms would be two places to add a
   * field and one place to forget.
   */
  asQuote?: boolean;
  onDone: (saved?: { id: string; number: string }) => void;
}) {
  const taxes = useQuery({
    queryKey: ["invoicing-taxes"],
    queryFn: () => api<{ taxes: TaxDefinition[] }>("/api/invoicing/taxes"),
  });
  const items = useQuery({
    queryKey: ["invoicing-items"],
    queryFn: () => api<{ items: BillableItem[] }>("/api/invoicing/items"),
  });
  const contacts = useQuery({
    queryKey: ["contacts", "all"],
    queryFn: () => api<{ contacts: Contact[] }>("/api/contacts"),
  });
  /**
   * The terms and the units this business offers.
   *
   * Both were free-text boxes, which is how one business ends up with "hour",
   * "hours", "hr" and "Hrs" on four invoices, and with payment terms that say
   * thirty days beside a due date somebody set to next Tuesday.
   */
  const letterheads = useQuery({
    queryKey: ["invoicing-templates"],
    queryFn: () =>
      api<{ templates: { id: string; name: string; isDefault: boolean }[] }>(
        "/api/invoicing/templates",
      ),
  });
  const billing = useQuery({
    queryKey: ["invoicing-billing"],
    queryFn: () =>
      api<{
        settings: {
          paymentTermOptions: { label: string; days: number }[];
          units: string[];
        };
      }>("/api/invoicing/settings"),
  });

  const [contactId, setContactId] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [validUntil, setValidUntil] = useState("");
  const [paymentTerms, setPaymentTerms] = useState("");
  const [notes, setNotes] = useState("");
  /** Which letterhead this one goes out on. Empty means the business's own. */
  const [templateId, setTemplateId] = useState("");
  const [discountType, setDiscountType] = useState("");
  const [discountValue, setDiscountValue] = useState("");
  // Pay early, pay less. An invoice thing only — a quote is not owed yet.
  const [earlyType, setEarlyType] = useState("");
  const [earlyValue, setEarlyValue] = useState("");
  const [earlyDays, setEarlyDays] = useState("10");
  const [lines, setLines] = useState<LineDraft[]>([blankLine()]);

  /**
   * What is already on the document, when one is being edited.
   *
   * Fetched rather than passed in: the list rows carry totals and a customer
   * name, not the lines, and an editor opened from a row that only knows the
   * summary is exactly how this came to open blank.
   */
  const existing = useQuery({
    queryKey: [asQuote ? "quote" : "invoice", documentId],
    enabled: Boolean(documentId),
    queryFn: () =>
      api<{
        quote?: DocumentShape;
        invoice?: DocumentShape;
        lines: {
          description: string;
          quantityMilli: number;
          unitPriceCents: number;
          unit: string | null;
          taxDefinitionId: string | null;
        }[];
      }>(`/api/${asQuote ? "quotes" : "invoices"}/${documentId}`),
  });

  /**
   * Filled in once, when the document arrives.
   *
   * `loaded` rather than an effect on the data: react-query refetches, and a
   * refetch that overwrote the boxes would take back whatever had been typed
   * since.
   */
  const [loaded, setLoaded] = useState(false);
  if (documentId && !loaded && existing.data) {
    const doc = existing.data.quote ?? existing.data.invoice;
    if (doc) {
      setLoaded(true);
      setContactId(doc.contactId ?? "");
      setNotes(doc.notes ?? "");
      setTemplateId(doc.templateId ?? "");
      setDiscountType(doc.discountType ?? "");
      setDiscountValue(doc.discountValue ? String(doc.discountValue) : "");
      if (asQuote) {
        setValidUntil(doc.validUntil ? doc.validUntil.slice(0, 10) : "");
      } else {
        setDueDate(doc.dueDate ? doc.dueDate.slice(0, 10) : "");
        setPaymentTerms(doc.paymentTerms ?? "");
      }
      setLines(
        existing.data.lines.length
          ? existing.data.lines.map((l) => ({
              key: crypto.randomUUID(),
              billableItemId: null,
              description: l.description,
              quantity: String(l.quantityMilli / 1000),
              unitPrice: (l.unitPriceCents / 100).toFixed(2),
              unit: l.unit ?? "piece",
              taxDefinitionId: l.taxDefinitionId ?? "",
            }))
          : [blankLine()],
      );
    }
  }

  const rates = (taxes.data?.taxes ?? []).filter((t) => t.active);
  const catalogue = (items.data?.items ?? []).filter((i) => i.active);
  const terms = billing.data?.settings.paymentTermOptions ?? [];
  const units = billing.data?.settings.units ?? [];

  /**
   * Choosing terms sets the date they follow from.
   *
   * "Net 30" and a due date three days out is the contradiction the free-text
   * box invited, and the customer reads whichever suits them.
   */
  const chooseTerms = (label: string) => {
    setPaymentTerms(label);
    const found = terms.find((t) => t.label === label);
    if (!found) return;
    const due = new Date();
    due.setDate(due.getDate() + found.days);
    setDueDate(due.toISOString().slice(0, 10));
  };

  const rateOf = (id: string) => rates.find((r) => r.id === id)?.rateBp ?? 0;

  /**
   * The running total, from the same function the server uses.
   *
   * Not a second implementation. The screen and the invoice have to agree
   * exactly — including how a discount is apportioned across tax rates, which
   * is the part nobody would notice drifting — and the only way to guarantee
   * that is for both to call the same code. `documentTotals` lives in the db
   * package and touches no database, so the browser can have it.
   *
   * A line still being typed is worth nothing rather than throwing: the
   * preview updates on every keystroke, and half a number is not an error.
   */
  let preview = { subtotal: 0, discount: 0, tax: 0, total: 0 };
  try {
    preview = documentTotals(
      lines.map((l) => ({
        quantity: toMilli(l.quantity) / 1000,
        unitPrice: toCents(l.unitPrice),
        taxRateBp: rateOf(l.taxDefinitionId),
      })),
      discountType === "percent"
        ? {
            type: "percent",
            value: Math.round(Number.parseFloat(discountValue || "0") * 100),
          }
        : discountType === "amount"
          ? { type: "amount", value: toCents(discountValue) }
          : null,
    );
  } catch {
    // Mid-keystroke. The buttons are disabled until the lines are usable.
  }

  const setLine = (index: number, patch: Partial<LineDraft>) =>
    setLines((current) =>
      current.map((l, i) => (i === index ? { ...l, ...patch } : l)),
    );

  /** Picking from the catalogue fills the line in, and stays editable. */
  const pickItem = (index: number, itemId: string) => {
    const item = catalogue.find((i) => i.id === itemId);
    if (!item) return setLine(index, { billableItemId: null });
    setLine(index, {
      billableItemId: item.id,
      description: item.description?.trim() || item.name,
      unitPrice: (item.unitPriceCents / 100).toFixed(2),
      unit: item.unit,
      taxDefinitionId: item.taxDefinitionId ?? "",
    });
  };

  const save = useMutation({
    mutationFn: async (status: "draft" | "open") => {
      const body = {
        contactId: contactId || null,
        currency: "USD",
        status,
        ...(asQuote
          ? { validUntil: validUntil || undefined }
          : { dueDate: dueDate || undefined }),
        paymentTerms: paymentTerms.trim() || null,
        templateId: templateId || null,
        notes: notes.trim() || null,
        ...(discountType
          ? {
              discountType,
              discountValue:
                discountType === "percent"
                  ? Math.round(Number.parseFloat(discountValue || "0") * 100)
                  : toCents(discountValue),
            }
          : {}),
        ...(!asQuote && earlyType
          ? {
              earlyDiscountType: earlyType,
              earlyDiscountValue:
                earlyType === "percent"
                  ? Math.round(Number.parseFloat(earlyValue || "0") * 100)
                  : toCents(earlyValue),
              earlyDiscountDays: Number.parseInt(earlyDays || "0", 10),
            }
          : {}),
        lines: lines
          .filter((l) => l.description.trim())
          .map((l) => ({
            billableItemId: l.billableItemId,
            description: l.description.trim(),
            quantityMilli: toMilli(l.quantity),
            unitPriceCents: toCents(l.unitPrice),
            unit: l.unit,
            ...(l.taxDefinitionId
              ? { taxDefinitionId: l.taxDefinitionId }
              : {}),
          })),
      };
      // PATCH when there is a document, POST when there is not. Sending a
      // POST with an id in hand is what raised a second invoice every time
      // somebody pressed Edit.
      const path = asQuote ? "/api/quotes" : "/api/invoices";
      const url = documentId ? `${path}/${documentId}` : path;
      const method = documentId ? "PATCH" : "POST";

      if (asQuote) {
        const res = await api<{ quote: { id: string; number: string } }>(url, {
          method,
          body: JSON.stringify(body),
        });
        return res.quote;
      }
      const res = await api<{ invoice: { id: string; number: string } }>(url, {
        method,
        body: JSON.stringify(body),
      });
      return res.invoice;
    },
    onSuccess: (saved) => onDone(saved),
  });

  if (taxes.isLoading || contacts.isLoading) return <Loading />;

  const usable = lines.some(
    (l) => l.description.trim() && toCents(l.unitPrice) >= 0,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="font-semibold text-lg">
          {documentId
            ? asQuote
              ? "Edit quote"
              : "Edit invoice"
            : asQuote
              ? "New quote"
              : "New invoice"}
        </h2>
        <button
          type="button"
          className="ml-auto text-sm link-muted"
          onClick={() => onDone()}
        >
          Cancel
        </button>
      </div>

      <Card>
        <p className="mb-3 font-medium text-sm">
          {asQuote ? "Quote details" : "Invoice details"}
        </p>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Customer">
            <Select
              value={contactId}
              onChange={(e) => setContactId(e.target.value)}
            >
              <option value="">Choose a customer</option>
              {(contacts.data?.contacts ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          {asQuote ? (
            <Field
              label="Valid until"
              hint="After this the price is no longer promised."
            >
              <Input
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </Field>
          ) : (
            <Field
              label="Due"
              hint="Left blank, it defaults to thirty days — an invoice with no due date is never chased."
            >
              <Input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
              />
            </Field>
          )}
          <Field
            label="Payment terms"
            hint="Choosing one sets the due date to match."
          >
            <Select
              value={
                terms.some((t) => t.label === paymentTerms) ? paymentTerms : ""
              }
              onChange={(e) => chooseTerms(e.target.value)}
            >
              <option value="">Something else…</option>
              {terms.map((term) => (
                <option key={term.label} value={term.label}>
                  {term.label}
                </option>
              ))}
            </Select>
            {/* A business with an arrangement nobody else has still needs to
                write it down. */}
            {terms.some((t) => t.label === paymentTerms) ? null : (
              <Input
                className="mt-1"
                value={paymentTerms}
                placeholder="Half on delivery, half in 30 days"
                aria-label="Payment terms in your own words"
                onChange={(e) => setPaymentTerms(e.target.value)}
              />
            )}
          </Field>
          {/* One business, usually one letterhead — but a trade that bills
              two names out of one company needs to say which. */}
          {(letterheads.data?.templates ?? []).length > 1 ? (
            <Field label="Letterhead">
              <Select
                value={templateId}
                onChange={(e) => setTemplateId(e.target.value)}
              >
                <option value="">The usual one</option>
                {(letterheads.data?.templates ?? []).map((letterhead) => (
                  <option key={letterhead.id} value={letterhead.id}>
                    {letterhead.name}
                    {letterhead.isDefault ? " (default)" : ""}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      </Card>

      <Card>
        <p className="mb-3 font-medium text-sm">Line items</p>
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div
              key={line.key}
              className="grid gap-2 sm:grid-cols-[1fr_5rem_6rem_7rem_8rem_2rem]"
            >
              <span className="space-y-1">
                <Input
                  value={line.description}
                  placeholder="What was done"
                  aria-label={`Line ${i + 1} description`}
                  onChange={(e) => setLine(i, { description: e.target.value })}
                />
                {catalogue.length > 0 ? (
                  <Select
                    value={line.billableItemId ?? ""}
                    aria-label={`Line ${i + 1} from the catalogue`}
                    className="w-full text-xs"
                    onChange={(e) => pickItem(i, e.target.value)}
                  >
                    <option value="">Or pick from your list…</option>
                    {catalogue.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} — {formatMoney(item.unitPriceCents)}
                      </option>
                    ))}
                  </Select>
                ) : null}
              </span>
              <Input
                value={line.quantity}
                inputMode="decimal"
                aria-label={`Line ${i + 1} quantity`}
                onChange={(e) => setLine(i, { quantity: e.target.value })}
              />
              {/* The line keeps whatever unit it arrived with, even if the
                  business has since dropped it from the list — an invoice
                  that silently changes "cubic yard" to "piece" is worse than
                  a stale option. */}
              <Select
                value={line.unit}
                aria-label={`Line ${i + 1} unit`}
                onChange={(e) => setLine(i, { unit: e.target.value })}
              >
                {(units.includes(line.unit)
                  ? units
                  : [line.unit, ...units].filter(Boolean)
                ).map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </Select>
              <Input
                value={line.unitPrice}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={`Line ${i + 1} unit price`}
                onChange={(e) => setLine(i, { unitPrice: e.target.value })}
              />
              <Select
                value={line.taxDefinitionId}
                aria-label={`Line ${i + 1} tax`}
                onChange={(e) =>
                  setLine(i, { taxDefinitionId: e.target.value })
                }
              >
                <option value="">No tax</option>
                {rates.map((rate) => (
                  <option key={rate.id} value={rate.id}>
                    {rate.name}
                  </option>
                ))}
              </Select>
              <button
                type="button"
                className="link-muted"
                aria-label={`Remove line ${i + 1}`}
                disabled={lines.length === 1}
                onClick={() =>
                  setLines((current) => current.filter((_, at) => at !== i))
                }
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-3">
          <Button
            variant="secondary"
            onClick={() =>
              setLines((current) => [...current, blankLine(units[0])])
            }
          >
            Add a line
          </Button>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <p className="mb-3 font-medium text-sm">Notes</p>
          <textarea
            value={notes}
            rows={5}
            placeholder="Anything the customer should read on the invoice"
            aria-label="Notes"
            onChange={(e) => setNotes(e.target.value)}
            className="w-full rounded-md border px-2 py-1.5 text-sm"
            style={{ ...border, background: "var(--surface-raised)" }}
          />
        </Card>

        <Card>
          <p className="mb-3 font-medium text-sm">Total</p>

          <div className="mb-3 flex items-end gap-2">
            <Field label="Discount">
              <Select
                value={discountType}
                onChange={(e) => setDiscountType(e.target.value)}
              >
                <option value="">None</option>
                <option value="percent">A percentage</option>
                <option value="amount">A fixed amount</option>
              </Select>
            </Field>
            {discountType ? (
              <Field label={discountType === "percent" ? "%" : "Amount"}>
                <Input
                  value={discountValue}
                  inputMode="decimal"
                  onChange={(e) => setDiscountValue(e.target.value)}
                />
              </Field>
            ) : null}
          </div>

          {/*
            Pay early, pay less. Not offered on a quote: nothing is owed yet,
            so there is nothing to settle sooner.
          */}
          {!asQuote ? (
            <div className="mb-3 flex items-end gap-2">
              <Field label="Pay early, pay less">
                <Select
                  value={earlyType}
                  onChange={(e) => setEarlyType(e.target.value)}
                >
                  <option value="">Not offered</option>
                  <option value="percent">A percentage off</option>
                  <option value="amount">A fixed amount off</option>
                </Select>
              </Field>
              {earlyType ? (
                <>
                  <Field label={earlyType === "percent" ? "%" : "Amount"}>
                    <Input
                      value={earlyValue}
                      inputMode="decimal"
                      className="w-24"
                      onChange={(e) => setEarlyValue(e.target.value)}
                    />
                  </Field>
                  <Field label="Within (days)">
                    <Input
                      value={earlyDays}
                      inputMode="numeric"
                      className="w-24"
                      onChange={(e) => setEarlyDays(e.target.value)}
                    />
                  </Field>
                </>
              ) : null}
            </div>
          ) : null}

          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td style={muted}>Subtotal</td>
                <td className="money">{formatMoney(preview.subtotal)}</td>
              </tr>
              {preview.discount > 0 ? (
                <tr>
                  <td style={muted}>Discount</td>
                  <td className="money">−{formatMoney(preview.discount)}</td>
                </tr>
              ) : null}
              <tr>
                <td style={muted}>Tax</td>
                <td className="money">{formatMoney(preview.tax)}</td>
              </tr>
              <tr className="border-t font-semibold" style={border}>
                <td className="pt-1">Total</td>
                <td className="money pt-1">{formatMoney(preview.total)}</td>
              </tr>
            </tbody>
          </table>

          {/*
            Tax on what is left after the discount, not before it — the order
            every tax authority expects, and the one the server uses.
          */}
          <p className="mt-2 text-xs" style={muted}>
            Worked out with the same code the invoice is saved with.
          </p>
        </Card>
      </div>

      <div className="flex items-center gap-2">
        {/* One button when editing, two when raising.
            Editing does not change a document's status — a PATCH that quietly
            issued a draft because somebody pressed the wrong one of two
            buttons would be a surprise with a journal entry behind it — so
            offering "Save as a draft" beside "Raise it" here would be two
            labels for the same thing. */}
        {documentId ? (
          <Button
            onClick={() => save.mutate("draft")}
            disabled={save.isPending || !usable}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        ) : (
          <>
            <Button
              onClick={() => save.mutate("draft")}
              disabled={save.isPending || !usable}
              variant="secondary"
            >
              {save.isPending ? "Saving…" : "Save as a draft"}
            </Button>
            <Button
              onClick={() => save.mutate("open")}
              disabled={save.isPending || !usable}
            >
              {asQuote ? "Save the quote" : "Raise it"}
            </Button>
          </>
        )}
        {!usable ? (
          <span className="text-sm" style={muted}>
            At least one line with a description.
          </span>
        ) : null}
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}
    </div>
  );
}
