import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../lib/api";
import { useCrmSettings } from "../lib/crm-settings";
import { CustomFields, CustomValues } from "../lib/custom-fields";
import { RelatedLink, useNavigation, useRecordTitle } from "../lib/navigation";
import { RecordPicker } from "../lib/record-picker";
import {
  Button,
  Card,
  ConfirmButton,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  MenuItem,
  SectionHeading,
  Select,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";

/**
 * One deal: what it is worth, who is on it, and what was said.
 *
 * The board links here. Without this screen every card was a dead end — the
 * same failure a contact's company link had before companies got one.
 */

const STAGES = [
  { id: "opportunity", label: "Opportunity" },
  { id: "proposal", label: "Proposal" },
  { id: "negotiation", label: "Negotiation" },
  { id: "won", label: "Won" },
  { id: "lost", label: "Lost" },
];

interface Related {
  deal: {
    id: string;
    name: string;
    stage: string;
    amountCents: number;
    category: string | null;
    description: string | null;
    expectedCloseOn: string | null;
    archivedAt: string | null;
    customValues?: Record<string, string | number | boolean | null> | null;
  };
  company: { id: string; name: string } | null;
  contacts: { id: string; name: string; title: string | null }[];
  notes: { id: string; text: string; createdAt: string }[];
}

/**
 * Correcting a deal, and saying who it is with.
 *
 * The company and the people on a deal could only be set when it was created,
 * through the API — so a deal that turned out to be with somebody else could
 * not be fixed, only deleted. Which is the same gap the contact screen had.
 */
function EditDeal({
  deal,
  company,
  people,
  onDone,
  onDeleted,
}: {
  deal: Related["deal"];
  company: { id: string; name: string } | null;
  /** Who is already on it, with their names, so nothing has to be looked up. */
  people: { id: string; name: string }[];
  onDone: () => void;
  /** Deleting leaves nothing to come back to, so the screen navigates away. */
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const settings = useCrmSettings();
  const [form, setForm] = useState({
    name: deal.name,
    amount: (deal.amountCents / 100).toString(),
    category: deal.category ?? "",
    description: deal.description ?? "",
    expectedCloseOn: deal.expectedCloseOn ?? "",
  });
  const [onCompany, setCompany] = useState(company);
  const [customValues, setCustomValues] = useState<
    Record<string, string | number | boolean | null>
  >(deal.customValues ?? {});
  /**
   * Who is on the deal, by name as well as by id.
   *
   * It was a checkbox per contact, drawn from the whole contacts table —
   * which the server caps at a thousand rows, so a business with more than
   * that could not tick some of its own customers and nothing said so. The
   * ones already on the deal are shown; anybody else is found by searching.
   */
  const [on, setOn] = useState(people);
  const set = (patch: Partial<typeof form>) =>
    setForm((f) => ({ ...f, ...patch }));

  const remove = useMutation({
    mutationFn: () => api(`/api/deals/${deal.id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["contact-related"] });
      qc.invalidateQueries({ queryKey: ["company-related"] });
      // Not `onDone`: that closes the form and leaves somebody looking at a
      // record that is no longer there, which is what the first run of this
      // did — the row was gone from the database and still on the screen.
      onDeleted();
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/deals/${deal.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          amountCents: Math.round(Number(form.amount || 0) * 100),
          category: form.category || null,
          description: form.description || null,
          expectedCloseOn: form.expectedCloseOn || null,
          companyId: onCompany?.id || null,
          contactIds: on.map((p) => p.id),
          customValues,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deal-related", deal.id] });
      qc.invalidateQueries({ queryKey: ["deals"] });
      // A contact's screen lists the deals it is on, and this may have just
      // added or removed one.
      qc.invalidateQueries({ queryKey: ["contact-related"] });
      qc.invalidateQueries({ queryKey: ["company-related"] });
      onDone();
    },
  });

  return (
    <Card>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
        </Field>
        <Field label="Amount" hint="What the job is worth.">
          <Input
            value={form.amount}
            inputMode="decimal"
            onChange={(e) => set({ amount: e.target.value })}
          />
        </Field>
        <Field label="Category">
          <Input
            value={form.category}
            onChange={(e) => set({ category: e.target.value })}
          />
        </Field>
        <Field label="Expected close">
          <Input
            type="date"
            value={form.expectedCloseOn}
            onChange={(e) => set({ expectedCloseOn: e.target.value })}
          />
        </Field>
        <Field label="Company">
          <RecordPicker
            path="/api/companies"
            resource="companies"
            value={onCompany}
            onChange={setCompany}
            placeholder="Search companies"
            clearLabel="No company"
            noun="company"
          />
        </Field>
      </div>

      <Field label="Description">
        <textarea
          rows={2}
          value={form.description}
          onChange={(e) => set({ description: e.target.value })}
          className="w-full rounded border px-2 py-1.5 text-sm"
          style={{
            background: "var(--surface-raised)",
            borderColor: "var(--border)",
            color: "var(--text)",
          }}
        />
      </Field>

      <Field
        label="People on this deal"
        hint="A deal usually involves several."
      >
        <div className="flex flex-col gap-(--gap-tight)">
          {on.map((p) => (
            <div key={p.id} className="flex items-center gap-2 text-sm">
              <span>{p.name}</span>
              <button
                type="button"
                aria-label={`Take ${p.name} off this deal`}
                onClick={() =>
                  setOn((prev) => prev.filter((q) => q.id !== p.id))
                }
                className="text-xs underline"
                style={muted}
              >
                Remove
              </button>
            </div>
          ))}
          <RecordPicker
            path="/api/contacts"
            resource="contacts"
            value={null}
            onChange={(picked) =>
              setOn((prev) =>
                !picked || prev.some((q) => q.id === picked.id)
                  ? prev
                  : [...prev, { id: picked.id, name: picked.name }],
              )
            }
            placeholder="Add somebody"
            clearLabel={null}
            noun="contact"
          />
        </div>
      </Field>

      {/* This business's own fields for a deal, from its settings. */}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <CustomFields
          fields={settings.customFields.filter((f) => f.appliesTo === "deal")}
          values={customValues}
          onChange={setCustomValues}
        />
      </div>

      <div className="mt-3 flex gap-2">
        <Button
          needs={{ crm: ["update"] }}
          onClick={() => save.mutate()}
          disabled={!form.name.trim() || save.isPending}
        >
          {save.isPending ? "Saving…" : "Save"}
        </Button>
        {/*
          A deal could be made, moved through every stage and marked won, and
          never removed — so one opened by mistake or entered twice sat in the
          pipeline and in its figures for good. The route was there and nothing
          called it.
        */}
        <ConfirmButton
          title="Delete this deal?"
          message="Its notes, its logged calls and meetings, its follow-ups and its tags all go with it, and out of the pipeline figures. There is no bin to fish it back out of."
          confirmLabel="Delete it"
          danger
          variant="danger"
          needs={{ crm: ["delete"] }}
          disabled={remove.isPending}
          onConfirm={() => remove.mutate()}
        >
          Delete
        </ConfirmButton>
        <button type="button" className="text-sm link-muted" onClick={onDone}>
          Cancel
        </button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </Card>
  );
}

export function DealDetail() {
  const { current, open } = useNavigation();
  const qc = useQueryClient();
  const settings = useCrmSettings();
  const id = current.recordId;
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["deal-related", id],
    queryFn: () => api<Related>(`/api/deals/${id}/related`),
    enabled: Boolean(id),
  });

  useRecordTitle(data?.deal.name);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["deal-related", id] });
    // The board reads the same rows, so a stage changed here has to be stale
    // there too — otherwise going back shows the card where it used to be.
    qc.invalidateQueries({ queryKey: ["deals"] });
  };

  const move = useMutation({
    mutationFn: (stage: string) =>
      api(`/api/deals/${id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
      }),
    onSuccess: refresh,
  });

  /**
   * The step after somebody agrees the work is worth having.
   *
   * Opens **the quotes list**, not the quote. There is no screen for one — a
   * quote is sent, linked, converted or split from the list's own menu, and
   * `RECORD_SCREENS` has no entry for `quotes`, so asking for a record here
   * rendered the list underneath a breadcrumb and heading naming a quote the
   * page was not showing. The new draft sorts to the top, which is the honest
   * version of the same intent.
   *
   * Worth revisiting the day a quote gets a screen of its own; today it would
   * be a link to nowhere.
   */
  const quote = useMutation({
    mutationFn: () =>
      api<{ quote: { id: string; number: string } }>(`/api/deals/${id}/quote`, {
        method: "POST",
      }),
    onSuccess: (result) => {
      refresh();
      // "Quotes", not the number: titling a *list* page with one record's name
      // is a smaller version of the same lie. The breadcrumb then reads
      // "Annual service / Quotes", which is both true and useful — it says
      // where you came from.
      open({ moduleId: "quotes", title: "Quotes" });
    },
  });

  const addNote = useMutation({
    mutationFn: () =>
      api("/api/notes", {
        method: "POST",
        body: JSON.stringify({ entityType: "deal", entityId: id, text }),
      }),
    onSuccess: () => {
      setText("");
      refresh();
    },
  });

  if (!id) return <Empty title="No deal selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { deal, company, contacts, notes } = data;
  const closed = deal.stage === "won" || deal.stage === "lost";

  if (editing) {
    return (
      <EditDeal
        deal={deal}
        company={company ?? null}
        people={contacts.map((p) => ({ id: p.id, name: p.name }))}
        onDone={() => setEditing(false)}
        onDeleted={() => open({ moduleId: "deals", title: "Deals" })}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-(--gap-stack)">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <p className="text-lg font-semibold">{deal.name}</p>
              <p className="text-sm" style={muted}>
                {[
                  deal.category,
                  deal.expectedCloseOn
                    ? `closes ${formatDate(deal.expectedCloseOn)}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ") || "No category or close date"}
              </p>
            </div>
            <div className="flex items-baseline gap-3">
              <p className="money text-lg font-semibold">
                {formatMoney(deal.amountCents)}
              </p>
              {/* Not hidden until the deal is won. Quoting is often how a
                  deal gets won, and a button that appears only afterwards is
                  one nobody finds when they need it. */}
              <MenuItem
                needs={{ invoicing: ["create"] }}
                className="text-sm link-muted"
                onClick={() => quote.mutate()}
                disabled={quote.isPending}
              >
                {quote.isPending ? "Quoting…" : "Create quote"}
              </MenuItem>
              <button
                type="button"
                className="text-sm link-muted"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          </div>

          {quote.error ? <ErrorNote error={quote.error} /> : null}

          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm" style={muted}>
              Stage
            </span>
            <Select
              needs={{ crm: ["update"] }}
              value={deal.stage}
              aria-label="Stage"
              onChange={(e) => move.mutate(e.target.value)}
            >
              {STAGES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
            {closed ? (
              <span className="text-xs" style={muted}>
                Closed deals stay on the board as history.
              </span>
            ) : null}
          </div>
          {move.error ? <ErrorNote error={move.error} /> : null}

          {deal.description ? (
            <p className="mt-3 whitespace-pre-wrap text-sm">
              {deal.description}
            </p>
          ) : null}

          <CustomValues
            fields={settings.customFields.filter((f) => f.appliesTo === "deal")}
            values={deal.customValues}
          />
        </Card>

        <Card>
          <SectionHeading>Notes</SectionHeading>
          <textarea
            rows={2}
            value={text}
            placeholder="What happened on this deal?"
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{
              background: "var(--surface-raised)",
              borderColor: "var(--border)",
              color: "var(--text)",
            }}
          />
          <div className="mt-2">
            <Button
              needs={{ crm: ["create"] }}
              onClick={() => addNote.mutate()}
              disabled={!text.trim() || addNote.isPending}
            >
              {addNote.isPending ? "Saving…" : "Add note"}
            </Button>
          </div>
          {addNote.error ? <ErrorNote error={addNote.error} /> : null}

          <div className="mt-3 flex flex-col gap-(--gap-toolbar)">
            {notes.length === 0 ? (
              <p className="text-sm" style={muted}>
                Nothing written down yet.
              </p>
            ) : (
              notes.map((n) => (
                <div key={n.id} className="border-t pt-2 text-sm border-line">
                  <p className="whitespace-pre-wrap">{n.text}</p>
                  <p className="mt-0.5 text-xs" style={muted}>
                    {formatDate(n.createdAt)}
                  </p>
                </div>
              ))
            )}
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-(--gap-stack)">
        <Card>
          <SectionHeading>Who is involved</SectionHeading>
          {company ? (
            <p className="mb-2 text-sm">
              <span style={muted}>Company: </span>
              <RelatedLink
                to={{
                  moduleId: "companies",
                  recordId: company.id,
                  title: company.name,
                }}
              >
                {company.name}
              </RelatedLink>
            </p>
          ) : null}

          {contacts.length === 0 ? (
            <p className="text-sm" style={muted}>
              Nobody attached to this deal.
            </p>
          ) : (
            <ul className="flex flex-col gap-(--gap-tight) text-sm">
              {contacts.map((p) => (
                <li key={p.id}>
                  <RelatedLink
                    to={{ moduleId: "contacts", recordId: p.id, title: p.name }}
                  >
                    {p.name}
                  </RelatedLink>
                  {p.title ? (
                    <span className="ml-1 text-xs" style={muted}>
                      {p.title}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
