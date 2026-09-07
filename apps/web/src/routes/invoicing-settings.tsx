import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  Table,
  border,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * The two lists a business fills in once and then picks from.
 *
 * **Tax rates**, named. A rate typed into a line is a rate somebody will
 * mistype, and a tax summary built from mistyped rates is not a summary of
 * anything. Naming them is also what gives the EN 16931 category somewhere to
 * live, which is what an e-invoice will need to state.
 *
 * **What you sell**, so a line is picked rather than retyped. Not the Shop's
 * products: that is a paid module for selling to the public, with variants and
 * stock. This is a list of things to put on an invoice.
 *
 * Neither is ever deleted, only retired — documents copy the rate they were
 * issued at, so removing a row would not change any document but would break
 * the tax summary that groups by it.
 */

interface TaxDefinition {
  id: string;
  name: string;
  rateBp: number;
  categoryCode: string;
  description: string | null;
  isDefault: boolean;
  active: boolean;
}

interface BillableItem {
  id: string;
  name: string;
  description: string | null;
  sku: string | null;
  unitPriceCents: number;
  unit: string;
  kind: string;
  taxDefinitionId: string | null;
  active: boolean;
}

interface Category {
  code: string;
  label: string;
}

/** 875 → "8.75%". Rates are stored in basis points everywhere. */
function asPercent(rateBp: number): string {
  return `${(rateBp / 100).toFixed(2).replace(/\.00$/, "")}%`;
}

export function InvoicingSettings() {
  const qc = useQueryClient();
  const taxes = useQuery({
    queryKey: ["invoicing-taxes"],
    queryFn: () =>
      api<{ taxes: TaxDefinition[]; categories: Category[] }>(
        "/api/invoicing/taxes",
      ),
  });
  const items = useQuery({
    queryKey: ["invoicing-items"],
    queryFn: () => api<{ items: BillableItem[] }>("/api/invoicing/items"),
  });

  const [showRetired, setShowRetired] = useState(false);

  if (taxes.isLoading || items.isLoading) return <Loading />;
  if (taxes.error) return <ErrorNote error={taxes.error} />;

  const visible = <T extends { active: boolean }>(rows: T[]) =>
    showRetired ? rows : rows.filter((r) => r.active);

  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2 text-sm" style={muted}>
        <input
          type="checkbox"
          checked={showRetired}
          onChange={(e) => setShowRetired(e.target.checked)}
        />
        Show retired ones
      </label>

      <TaxRates
        taxes={visible(taxes.data?.taxes ?? [])}
        categories={taxes.data?.categories ?? []}
        onDone={() => qc.invalidateQueries({ queryKey: ["invoicing-taxes"] })}
      />

      <Catalogue
        items={visible(items.data?.items ?? [])}
        taxes={(taxes.data?.taxes ?? []).filter((t) => t.active)}
        onDone={() => qc.invalidateQueries({ queryKey: ["invoicing-items"] })}
      />

      <Letterhead />

      <BillingRules />
    </div>
  );
}

function TaxRates({
  taxes,
  categories,
  onDone,
}: {
  taxes: TaxDefinition[];
  categories: Category[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [percent, setPercent] = useState("");
  const [categoryCode, setCategoryCode] = useState("S");

  const add = useMutation({
    mutationFn: () =>
      api("/api/invoicing/taxes", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          // Typed as a percentage, stored as basis points: 8.75 → 875.
          rateBp: Math.round(
            Number.parseFloat(percent.replace(/,/g, "") || "0") * 100,
          ),
          categoryCode,
        }),
      }),
    onSuccess: () => {
      setName("");
      setPercent("");
      onDone();
    },
  });

  const change = useMutation({
    mutationFn: ({
      id,
      patch,
    }: { id: string; patch: Record<string, unknown> }) =>
      api(`/api/invoicing/taxes/${id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: onDone,
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/taxes/${id}`, { method: "DELETE" }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <p className="mb-1 font-medium">Tax rates</p>
      <p className="mb-3 text-sm" style={muted}>
        What you actually charge, named. Lines pick from these rather than
        carrying a number somebody typed.
      </p>

      {taxes.length > 0 ? (
        <Table headers={["Name", "Rate", "Category", "Default", ""]}>
          {taxes.map((tax) => (
            <Row key={tax.id}>
              <td className="py-2">
                {tax.name}
                {!tax.active ? (
                  <span className="ml-2 text-xs" style={muted}>
                    retired
                  </span>
                ) : null}
              </td>
              <td className="whitespace-nowrap">{asPercent(tax.rateBp)}</td>
              <td style={muted}>
                {categories.find((c) => c.code === tax.categoryCode)?.label ??
                  tax.categoryCode}
              </td>
              <td>
                {tax.isDefault ? (
                  <span style={{ color: "var(--color-success)" }}>
                    <Icon name="check-square" size={15} />
                  </span>
                ) : tax.active ? (
                  <button
                    type="button"
                    className="text-xs link-muted"
                    onClick={() =>
                      change.mutate({ id: tax.id, patch: { isDefault: true } })
                    }
                  >
                    Make it the default
                  </button>
                ) : null}
              </td>
              <td className="text-right">
                {tax.active ? (
                  <button
                    type="button"
                    className="text-sm link-muted"
                    // Retired, not deleted: documents copy the rate they were
                    // issued at, and the tax summary groups by this row.
                    title="Takes it out of the line editor; documents keep it"
                    onClick={() => retire.mutate(tax.id)}
                  >
                    Retire
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-sm link-muted"
                    onClick={() =>
                      change.mutate({ id: tax.id, patch: { active: true } })
                    }
                  >
                    Bring back
                  </button>
                )}
              </td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-sm" style={muted}>
          None yet. Add the ones you charge.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Name">
          <Input
            value={name}
            placeholder="VAT 20%"
            className="w-44"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Rate">
          <Input
            value={percent}
            inputMode="decimal"
            placeholder="20"
            className="w-24"
            onChange={(e) => setPercent(e.target.value)}
          />
        </Field>
        <Field label="Category">
          <Select
            value={categoryCode}
            className="w-56"
            onChange={(e) => setCategoryCode(e.target.value)}
          >
            {categories.map((category) => (
              <option key={category.code} value={category.code}>
                {category.label}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          onClick={() => add.mutate()}
          disabled={add.isPending || !name.trim()}
        >
          Add it
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}
      {change.error ? <ErrorNote error={change.error} /> : null}
    </Card>
  );
}

function Catalogue({
  items,
  taxes,
  onDone,
}: {
  items: BillableItem[];
  taxes: TaxDefinition[];
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sku, setSku] = useState("");
  const [price, setPrice] = useState("");
  const [unit, setUnit] = useState("");
  const [kind, setKind] = useState("service");
  const [taxDefinitionId, setTaxDefinitionId] = useState("");

  /** The units this business sells by. Same query the invoice form uses. */
  const billing = useQuery({
    queryKey: ["invoicing-billing"],
    queryFn: () =>
      api<{ settings: { units: string[] } }>("/api/invoicing/settings"),
  });
  const units = billing.data?.settings.units ?? [];

  const add = useMutation({
    mutationFn: () =>
      api("/api/invoicing/items", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || null,
          sku: sku.trim() || null,
          kind,
          unitPriceCents: Math.round(
            Number.parseFloat(price.replace(/,/g, "") || "0") * 100,
          ),
          unit: unit.trim() || units[0] || "piece",
          taxDefinitionId: taxDefinitionId || null,
        }),
      }),
    onSuccess: () => {
      setName("");
      setDescription("");
      setSku("");
      setPrice("");
      onDone();
    },
  });

  const retire = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/items/${id}`, { method: "DELETE" }),
    onSuccess: onDone,
  });

  const restore = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active: true }),
      }),
    onSuccess: onDone,
  });

  return (
    <Card>
      <p className="mb-1 font-medium">What you sell</p>
      <p className="mb-3 text-sm" style={muted}>
        So a line is picked rather than retyped. Everything stays editable on
        the invoice itself.
      </p>

      {items.length > 0 ? (
        <Table
          headers={[
            "Name",
            "Code",
            "Unit",
            { label: "Price", money: true },
            "Tax",
            "",
          ]}
        >
          {items.map((item) => (
            <Row key={item.id}>
              <td className="py-2">
                {item.name}
                {!item.active ? (
                  <span className="ml-2 text-xs" style={muted}>
                    retired
                  </span>
                ) : null}
                {/* What it is, said once. A catalogue of thirty is scanned,
                    and a description under the name is how somebody tells two
                    similar surveys apart. */}
                {item.description ? (
                  <span className="block text-xs" style={muted}>
                    {item.description}
                  </span>
                ) : null}
              </td>
              <td style={muted}>{item.sku ?? "—"}</td>
              <td style={muted}>{item.unit}</td>
              <td className="money">{formatMoney(item.unitPriceCents)}</td>
              <td style={muted}>
                {taxes.find((t) => t.id === item.taxDefinitionId)?.name ?? "—"}
              </td>
              <td className="text-right">
                {item.active ? (
                  <button
                    type="button"
                    className="text-sm link-muted"
                    onClick={() => retire.mutate(item.id)}
                  >
                    Retire
                  </button>
                ) : (
                  <button
                    type="button"
                    className="text-sm link-muted"
                    onClick={() => restore.mutate(item.id)}
                  >
                    Bring back
                  </button>
                )}
              </td>
            </Row>
          ))}
        </Table>
      ) : (
        <p className="text-sm" style={muted}>
          Nothing yet. Add what you bill for most often.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-end gap-2">
        <Field label="Name">
          <Input
            value={name}
            placeholder="Site survey"
            className="w-52"
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Price">
          <Input
            value={price}
            inputMode="decimal"
            placeholder="120.00"
            className="w-28"
            onChange={(e) => setPrice(e.target.value)}
          />
        </Field>
        <Field label="Per">
          <Select
            value={unit || units[0] || "piece"}
            className="w-28"
            onChange={(e) => setUnit(e.target.value)}
          >
            {(units.length > 0 ? units : ["piece"]).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Code" hint="Your own reference, if you use one.">
          <Input
            value={sku}
            className="w-28"
            placeholder="SUR-01"
            onChange={(e) => setSku(e.target.value)}
          />
        </Field>
        <Field label="Kind">
          <Select
            value={kind}
            className="w-32"
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="service">Service</option>
            <option value="product">Product</option>
          </Select>
        </Field>
        <Field label="Tax">
          <Select
            value={taxDefinitionId}
            className="w-44"
            onChange={(e) => setTaxDefinitionId(e.target.value)}
          >
            <option value="">No tax</option>
            {taxes.map((tax) => (
              <option key={tax.id} value={tax.id}>
                {tax.name}
              </option>
            ))}
          </Select>
        </Field>
        <Button
          onClick={() => add.mutate()}
          disabled={add.isPending || !name.trim()}
        >
          Add it
        </Button>
      </div>
      <div className="mt-2">
        <Field
          label="Description"
          hint="Filled into the line when it is picked."
        >
          <Input
            value={description}
            placeholder="Measured survey and a written report"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}
    </Card>
  );
}

interface ReminderRule {
  id: string;
  name: string;
  daysOffset: number;
  subject: string;
  body: string;
  active: boolean;
}

interface BillingSettings {
  defaultDueDays: number;
  defaultPaymentTerms: string | null;
  /** What the invoice form offers, and what each one means in days. */
  paymentTermOptions: { label: string; days: number }[];
  /** What a line is sold by. */
  units: string[];
  lateFeeType: string | null;
  lateFeeValue: number;
  lateFeeGraceDays: number;
}

/** "-3" reads as "3 days before it is due", which is what somebody means. */
function whenItFires(daysOffset: number): string {
  if (daysOffset === 0) return "on the due date";
  const days = Math.abs(daysOffset);
  return daysOffset < 0
    ? `${days} day${days === 1 ? "" : "s"} before it is due`
    : `${days} day${days === 1 ? "" : "s"} after it is due`;
}

/**
 * When this business chases, and what being late costs.
 *
 * Both off by default. A reminder nobody wrote and a fee nobody agreed to are
 * the two ways an invoicing product embarrasses the business using it.
 */
function BillingRules() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["invoicing-billing"],
    queryFn: () =>
      api<{ settings: BillingSettings; rules: ReminderRule[] }>(
        "/api/invoicing/settings",
      ),
  });

  /**
   * The fee type, held here until there is a value to go with it.
   *
   * Saving on the select alone sent "charge a percentage, of nothing", which
   * the server refuses outright — correctly, since a fee of zero is not a fee
   * — so choosing a type appeared to do nothing at all and late fees could
   * never be switched on. Now the fields appear at once and nothing is stored
   * until an amount is entered.
   */
  const [pendingType, setPendingType] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [offset, setOffset] = useState("14");
  const [subject, setSubject] = useState("Invoice {{number}} is overdue");
  const [body, setBody] = useState(
    "{{amount}} is still outstanding on invoice {{number}}, which was due on {{due}}.",
  );

  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["invoicing-billing"] });

  const addRule = useMutation({
    mutationFn: () =>
      api("/api/invoicing/reminders", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(),
          daysOffset: Number.parseInt(offset, 10) || 0,
          subject: subject.trim(),
          body: body.trim(),
          active: true,
        }),
      }),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  const toggleRule = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api(`/api/invoicing/reminders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      }),
    onSuccess: refresh,
  });

  const removeRule = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/reminders/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const saveSettings = useMutation({
    mutationFn: (patch: Partial<BillingSettings>) =>
      api("/api/invoicing/settings", {
        method: "PUT",
        body: JSON.stringify({ ...data?.settings, ...patch }),
      }),
    onSuccess: refresh,
  });

  if (isLoading || !data) return null;
  const settings = data.settings;

  return (
    <>
      <Card>
        <p className="mb-1 font-medium">Chasing</p>
        <p className="mb-3 text-sm" style={muted}>
          When to write, and what to say. Nothing is sent until you switch a
          reminder on. With none of these, an overdue invoice is chased once a
          week in the product&rsquo;s own words.
        </p>

        {data.rules.length > 0 ? (
          <Table headers={["Name", "When", "Subject", "On", ""]}>
            {data.rules.map((rule) => (
              <Row key={rule.id}>
                <td className="py-2">{rule.name}</td>
                <td className="whitespace-nowrap" style={muted}>
                  {whenItFires(rule.daysOffset)}
                </td>
                <td className="max-w-64 truncate" style={muted}>
                  {rule.subject}
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={rule.active}
                    aria-label={`Send ${rule.name}`}
                    onChange={(e) =>
                      toggleRule.mutate({
                        id: rule.id,
                        active: e.target.checked,
                      })
                    }
                  />
                </td>
                <td className="text-right">
                  <button
                    type="button"
                    className="text-sm link-muted"
                    onClick={() => removeRule.mutate(rule.id)}
                  >
                    Remove
                  </button>
                </td>
              </Row>
            ))}
          </Table>
        ) : (
          <p className="text-sm" style={muted}>
            None yet.
          </p>
        )}

        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Name">
              <Input
                value={name}
                placeholder="Fourteen days late"
                className="w-52"
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field
              label="Days from the due date"
              hint="Negative sends it before."
            >
              <Input
                value={offset}
                inputMode="numeric"
                className="w-32"
                onChange={(e) => setOffset(e.target.value)}
              />
            </Field>
            <Field label="Subject">
              <Input
                value={subject}
                className="w-72"
                onChange={(e) => setSubject(e.target.value)}
              />
            </Field>
          </div>
          <textarea
            value={body}
            rows={3}
            aria-label="What the reminder says"
            onChange={(e) => setBody(e.target.value)}
            className="w-full rounded-md border px-2 py-1.5 text-sm"
            style={{ background: "var(--surface-raised)" }}
          />
          <p className="text-xs" style={muted}>
            {
              "{{number}}, {{amount}}, {{due}}, {{days}} and {{business}} are filled in."
            }
          </p>
          <Button
            onClick={() => addRule.mutate()}
            disabled={addRule.isPending || !name.trim()}
          >
            Add a reminder
          </Button>
        </div>
        {addRule.error ? <ErrorNote error={addRule.error} /> : null}
      </Card>

      <Card>
        <p className="mb-1 font-medium">Late fees</p>
        <p className="mb-3 text-sm" style={muted}>
          Off unless you turn it on. Charged once, and only after the grace
          period &mdash; a fee added the morning after is a fee charged for a
          payment already in the post.
        </p>

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Charge">
            <Select
              value={pendingType ?? settings.lateFeeType ?? ""}
              className="w-44"
              onChange={(e) => {
                const chosen = e.target.value || null;
                setPendingType(chosen);
                // Turning it off is unambiguous, so that saves at once.
                if (!chosen) {
                  saveSettings.mutate({ lateFeeType: null, lateFeeValue: 0 });
                }
              }}
            >
              <option value="">Nothing</option>
              <option value="percent">A percentage</option>
              <option value="amount">A fixed amount</option>
            </Select>
          </Field>

          {(pendingType ?? settings.lateFeeType) ? (
            <>
              <Field
                label={
                  (pendingType ?? settings.lateFeeType) === "percent"
                    ? "%"
                    : "Amount"
                }
                hint={
                  pendingType && !settings.lateFeeType
                    ? "Nothing is charged until you set this."
                    : undefined
                }
              >
                <Input
                  defaultValue={
                    settings.lateFeeValue
                      ? (settings.lateFeeValue / 100).toString()
                      : ""
                  }
                  inputMode="decimal"
                  className="w-24"
                  aria-label="Late fee"
                  onBlur={(e) =>
                    saveSettings.mutate({
                      lateFeeType: pendingType ?? settings.lateFeeType,
                      lateFeeValue: Math.round(
                        Number.parseFloat(e.target.value || "0") * 100,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="After how many days">
                <Input
                  defaultValue={String(settings.lateFeeGraceDays)}
                  inputMode="numeric"
                  className="w-28"
                  aria-label="Grace period"
                  onBlur={(e) =>
                    saveSettings.mutate({
                      lateFeeType: pendingType ?? settings.lateFeeType,
                      lateFeeGraceDays:
                        Number.parseInt(e.target.value, 10) || 0,
                    })
                  }
                />
              </Field>
            </>
          ) : null}

          <Field label="Default payment terms">
            <Input
              defaultValue={settings.defaultPaymentTerms ?? ""}
              placeholder="30 days net"
              className="w-52"
              aria-label="Default payment terms"
              onBlur={(e) =>
                saveSettings.mutate({ defaultPaymentTerms: e.target.value })
              }
            />
          </Field>
        </div>

        {/* The terms the form offers, and what each one means. Picking one on
            an invoice fills the due date in, which is the whole reason these
            are a list and not a sentence somebody types. */}
        <p className="mt-5 mb-1 font-medium text-sm">Terms you offer</p>
        <p className="mb-2 text-sm" style={muted}>
          Each one names a number of days. Choosing it on an invoice sets the
          due date.
        </p>
        <div className="space-y-2">
          {settings.paymentTermOptions.map((term, i) => (
            <div key={term.label} className="flex items-center gap-2">
              <Input
                defaultValue={term.label}
                className="w-52"
                aria-label={`Term ${i + 1} name`}
                onBlur={(e) => {
                  const next = [...settings.paymentTermOptions];
                  next[i] = { ...term, label: e.target.value.trim() };
                  if (next[i]?.label) {
                    saveSettings.mutate({ paymentTermOptions: next });
                  }
                }}
              />
              <Input
                defaultValue={String(term.days)}
                inputMode="numeric"
                className="w-20"
                aria-label={`Term ${i + 1} days`}
                onBlur={(e) => {
                  const next = [...settings.paymentTermOptions];
                  next[i] = {
                    ...term,
                    days: Number.parseInt(e.target.value, 10) || 0,
                  };
                  saveSettings.mutate({ paymentTermOptions: next });
                }}
              />
              <span className="text-sm" style={muted}>
                days
              </span>
              <button
                type="button"
                className="text-sm underline"
                style={muted}
                onClick={() =>
                  saveSettings.mutate({
                    paymentTermOptions: settings.paymentTermOptions.filter(
                      (_, at) => at !== i,
                    ),
                  })
                }
              >
                Remove
              </button>
            </div>
          ))}
          <Button
            variant="secondary"
            onClick={() =>
              saveSettings.mutate({
                paymentTermOptions: [
                  ...settings.paymentTermOptions,
                  { label: "New terms", days: 30 },
                ],
              })
            }
          >
            Add terms
          </Button>
        </div>

        {/* And what a line is sold by. Typed free-hand these become "hour",
            "hours", "hr" and "Hrs" on four invoices from one business. */}
        <p className="mt-5 mb-1 font-medium text-sm">Units</p>
        <p className="mb-2 text-sm" style={muted}>
          What a line is sold by. Comma separated.
        </p>
        <Input
          defaultValue={settings.units.join(", ")}
          aria-label="Units"
          onBlur={(e) =>
            saveSettings.mutate({
              units: e.target.value
                .split(",")
                .map((unit) => unit.trim())
                .filter(Boolean),
            })
          }
        />
        {saveSettings.error ? <ErrorNote error={saveSettings.error} /> : null}
      </Card>
    </>
  );
}

/**
 * The business's own letterhead.
 *
 * A logo, a colour and its own wording — not an HTML editor. The document a
 * customer opens is served from this application's own origin, so markup typed
 * here would run with whatever session opened it; see templates.ts on the
 * server. What is actually wanted from a template is branding, and branding
 * fits in fields.
 */
interface DocumentTemplate {
  id: string;
  name: string;
  accentColor: string | null;
  headerNote: string | null;
  footerNote: string | null;
  paperSize: string;
  /** classic | modern | compact — one of the three we ship. */
  layout: string;
  logoPath: string | null;
  isDefault: boolean;
}

/**
 * The three to start from.
 *
 * A business that has never thought about a letterhead should be able to have
 * one in a press, and see the difference before it presses. The reference ships
 * templates as HTML files; ours are a layout name and a colour, because the
 * page a customer opens is same-origin with this application and markup typed
 * into a settings box would run in it.
 */
const SAMPLES: {
  id: string;
  name: string;
  layout: string;
  accentColor: string;
  headerNote: string;
  footerNote: string;
  says: string;
}[] = [
  {
    id: "classic",
    name: "Classic",
    layout: "classic",
    accentColor: "#1f3a5f",
    headerNote: "",
    footerNote: "Thank you for your business.",
    says: "Rules, a plain head, totals to the right. What most invoices look like, and nobody has ever queried one for looking like this.",
  },
  {
    id: "modern",
    name: "Modern",
    layout: "modern",
    accentColor: "#0f766e",
    headerNote: "",
    footerNote: "Thank you — please quote the invoice number when you pay.",
    says: "A band of colour across the top, the number large, no rules. For a business whose work is what it looks like.",
  },
  {
    id: "compact",
    name: "Compact",
    layout: "compact",
    accentColor: "#334155",
    headerNote: "",
    footerNote: "",
    says: "Set tighter, so a month of visits is one page rather than three. Nothing is left off — it is just smaller.",
  },
];

function Letterhead() {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["invoicing-templates"],
    queryFn: () =>
      api<{ templates: DocumentTemplate[] }>("/api/invoicing/templates"),
  });
  const refresh = () =>
    qc.invalidateQueries({ queryKey: ["invoicing-templates"] });

  const makeDefault = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/templates/${id}/default`, { method: "POST" }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/invoicing/templates/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  /**
   * One press, and it is theirs to edit.
   *
   * The first one made is used by default, because a business that set up a
   * letterhead and then found documents still going out plain would have no
   * way of knowing there was a second step.
   */
  const addSample = useMutation({
    mutationFn: async (sample: (typeof SAMPLES)[number]) => {
      const made = await api<{ template: DocumentTemplate }>(
        "/api/invoicing/templates",
        {
          method: "POST",
          body: JSON.stringify({
            name: sample.name,
            layout: sample.layout,
            accentColor: sample.accentColor,
            headerNote: sample.headerNote || undefined,
            footerNote: sample.footerNote || undefined,
          }),
        },
      );
      if ((data?.templates ?? []).length === 0) {
        await api(`/api/invoicing/templates/${made.template.id}/default`, {
          method: "POST",
        });
      }
    },
    onSuccess: refresh,
  });

  const templates = data?.templates ?? [];

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="font-semibold">Letterhead</p>
          <p className="text-sm" style={muted}>
            What your invoices and quotes look like when a customer opens one.
          </p>
        </div>
        <button
          type="button"
          className="link text-sm"
          onClick={() => {
            setAdding((v) => !v);
            setEditing(null);
          }}
        >
          {adding ? "Cancel" : "New letterhead"}
        </button>
      </div>

      {adding ? (
        <TemplateForm
          onDone={() => {
            setAdding(false);
            refresh();
          }}
        />
      ) : null}

      {/* Three to start from, with what each one is for. A business that has
          never thought about a letterhead gets one in a press, and can see
          the difference before it presses. */}
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        {SAMPLES.map((sample) => (
          <div key={sample.id} className="rounded-lg border p-3" style={border}>
            <SamplePreview sample={sample} />
            <p className="mt-2 font-medium text-sm">{sample.name}</p>
            <p className="mt-0.5 text-xs" style={muted}>
              {sample.says}
            </p>
            <button
              type="button"
              className="link mt-2 text-xs"
              onClick={() => addSample.mutate(sample)}
              disabled={addSample.isPending}
            >
              Start from this
            </button>
          </div>
        ))}
      </div>
      {addSample.error ? <ErrorNote error={addSample.error} /> : null}

      {isLoading ? (
        <Loading />
      ) : templates.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing set up, so documents go out plain. That works — this is for
          when you want your own logo on them.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((template) => (
            <li key={template.id}>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="inline-block h-4 w-4 rounded"
                  style={{
                    background: template.accentColor ?? "var(--border)",
                    border: "1px solid var(--border)",
                  }}
                />
                <span className="font-medium">{template.name}</span>
                <span style={muted}>
                  {template.paperSize === "a4" ? "A4" : "Letter"}
                </span>
                {template.isDefault ? (
                  <span
                    className="rounded px-1.5 py-0.5 text-xs"
                    style={{
                      background: "var(--color-brand-500)",
                      color: "var(--color-neutral-50)",
                    }}
                  >
                    Used by default
                  </span>
                ) : (
                  <button
                    type="button"
                    className="link-muted text-xs"
                    onClick={() => makeDefault.mutate(template.id)}
                  >
                    Use this one
                  </button>
                )}
                <span className="ml-auto flex gap-3">
                  <button
                    type="button"
                    className="link-muted text-xs"
                    onClick={() =>
                      setEditing(editing === template.id ? null : template.id)
                    }
                  >
                    {editing === template.id ? "Close" : "Edit"}
                  </button>
                  <button
                    type="button"
                    className="text-xs"
                    style={{ color: "var(--color-danger)" }}
                    onClick={() => remove.mutate(template.id)}
                  >
                    Delete
                  </button>
                </span>
              </div>
              {editing === template.id ? (
                <TemplateForm
                  template={template}
                  onDone={() => {
                    setEditing(null);
                    refresh();
                  }}
                />
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {makeDefault.error ? <ErrorNote error={makeDefault.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </Card>
  );
}

/**
 * What the sample looks like, at a glance.
 *
 * Not the real document — a sketch of it. Somebody choosing between three
 * letterheads is choosing between shapes, and three identical grey boxes with
 * words under them is not a choice anybody can make.
 */
function SamplePreview({ sample }: { sample: (typeof SAMPLES)[number] }) {
  const bar = (width: string, dim = false) => (
    <span
      className="block rounded-full"
      style={{
        width,
        height: sample.layout === "compact" ? 3 : 4,
        marginTop: sample.layout === "compact" ? 3 : 5,
        background: dim ? "var(--border)" : sample.accentColor,
        opacity: dim ? 1 : 0.65,
      }}
    />
  );

  return (
    <div
      aria-hidden
      className="rounded border p-2"
      style={{
        ...border,
        background: "var(--surface-raised)",
        height: "5.5rem",
      }}
    >
      {sample.layout === "modern" ? (
        <span
          className="block rounded-sm"
          style={{ height: 12, background: sample.accentColor }}
        />
      ) : (
        bar("38%")
      )}
      {bar("62%", true)}
      {bar("100%", true)}
      {bar("100%", true)}
      {sample.layout === "compact" ? bar("100%", true) : null}
      {sample.layout === "compact" ? bar("100%", true) : null}
      <span
        className="mt-1 ml-auto block rounded-full"
        style={{ width: "34%", height: 4, background: sample.accentColor }}
      />
    </div>
  );
}

function TemplateForm({
  template,
  onDone,
}: {
  template?: DocumentTemplate;
  onDone: () => void;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [accentColor, setAccent] = useState(template?.accentColor ?? "#1d4ed8");
  const [paperSize, setPaper] = useState(template?.paperSize ?? "letter");
  const [layout, setLayout] = useState(template?.layout ?? "classic");
  const [headerNote, setHeader] = useState(template?.headerNote ?? "");
  const [footerNote, setFooter] = useState(template?.footerNote ?? "");

  const save = useMutation({
    mutationFn: () =>
      api(
        template
          ? `/api/invoicing/templates/${template.id}`
          : "/api/invoicing/templates",
        {
          method: template ? "PATCH" : "POST",
          body: JSON.stringify({
            name,
            accentColor,
            paperSize,
            layout,
            headerNote,
            footerNote,
          }),
        },
      ),
    onSuccess: onDone,
  });

  const uploadLogo = useMutation({
    mutationFn: async (file: File) => {
      if (!template) return;
      const form = new FormData();
      form.append("image", file);
      // No content-type: FormData sets its own with the boundary.
      const res = await fetch(`/api/invoicing/templates/${template.id}/logo`, {
        method: "POST",
        body: form,
        credentials: "include",
      });
      if (!res.ok) throw new Error("that image could not be used");
    },
    onSuccess: onDone,
  });

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Field label="Name" hint="Only you see this.">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>

      <Field label="Colour" hint="Headings and rules on the document.">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccent(e.target.value)}
            aria-label="Accent colour"
            className="h-8 w-12 rounded border"
          />
          <Input
            value={accentColor}
            onChange={(e) => setAccent(e.target.value)}
            className="w-28"
          />
        </div>
      </Field>

      <Field label="Shape" hint="The same document, set three ways.">
        <Select value={layout} onChange={(e) => setLayout(e.target.value)}>
          <option value="classic">Classic</option>
          <option value="modern">Modern</option>
          <option value="compact">Compact</option>
        </Select>
      </Field>

      <Field label="Paper" hint="Letter in North America, A4 elsewhere.">
        <Select value={paperSize} onChange={(e) => setPaper(e.target.value)}>
          <option value="letter">Letter</option>
          <option value="a4">A4</option>
        </Select>
      </Field>

      <Field
        label="Above the lines"
        hint="A greeting, a reference, a job number."
      >
        <Input value={headerNote} onChange={(e) => setHeader(e.target.value)} />
      </Field>

      <Field label="Below the totals" hint="Bank details, terms, a thank you.">
        <Input value={footerNote} onChange={(e) => setFooter(e.target.value)} />
      </Field>

      {template ? (
        <Field
          label="Logo"
          hint="Drawn at the top. It is re-encoded before it is stored."
        >
          <div className="flex items-center gap-2">
            {template.logoPath ? (
              <img
                src={`/share/template/${template.id}/logo`}
                alt=""
                className="h-8 rounded border"
              />
            ) : null}
            <input
              type="file"
              accept="image/*"
              className="text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadLogo.mutate(file);
              }}
            />
          </div>
        </Field>
      ) : null}

      <div className="flex items-end gap-2">
        <Button
          onClick={() => save.mutate()}
          disabled={!name || save.isPending}
        >
          Save
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>

      {save.error ? <ErrorNote error={save.error} /> : null}
      {uploadLogo.error ? <ErrorNote error={uploadLogo.error} /> : null}
    </div>
  );
}
