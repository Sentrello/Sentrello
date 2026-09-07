import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type FormDefinition, api } from "../lib/api";
import { Icon } from "../lib/icons";
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
  muted,
} from "../lib/ui";
import { FormBuilder } from "./form-builder";

type FormRow = FormDefinition & {
  allowedOrigins: string[];
  /** How many have come in. The only question anybody has about an embed. */
  submissionCount: number;
};

export function Forms() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("contact");
  const [showing, setShowing] = useState<FormRow | null>(null);
  const [building, setBuilding] = useState<FormRow | null>(null);
  const [viewing, setViewing] = useState<FormRow | null>(null);
  const [siting, setSiting] = useState<FormRow | null>(null);

  // Offered rather than created at first run: a business that deliberately
  // deleted its forms should not find them back tomorrow.
  const makeDefaults = useMutation({
    mutationFn: () => api("/api/forms/defaults", { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forms"] }),
  });

  const forms = useQuery({
    queryKey: ["forms"],
    queryFn: () => api<{ forms: FormRow[] }>("/api/forms"),
  });

  const create = useMutation({
    mutationFn: () =>
      api("/api/forms", {
        method: "POST",
        body: JSON.stringify({ name: name || undefined, kind }),
      }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
  });

  if (forms.isLoading) return <Loading />;
  if (forms.error) return <ErrorNote error={forms.error} />;
  const rows = forms.data?.forms ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 sm:grid-cols-[1fr_9rem_auto]">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact form"
            />
          </Field>
          <Field label="Type">
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="contact">Contact</option>
              <option value="quote">Quote request</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              New form
            </Button>
          </div>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {rows.length === 0 ? (
        <Card>
          <p className="font-medium">No forms yet</p>
          <p className="mt-1 mb-3 text-sm" style={muted}>
            A form gives you one line to paste into any website. Submissions
            arrive as contacts, and the ones worth chasing become deals.
          </p>
          <Button
            onClick={() => makeDefaults.mutate()}
            disabled={makeDefaults.isPending}
          >
            {makeDefaults.isPending
              ? "Creating…"
              : "Create a contact form and a quote form"}
          </Button>
          {makeDefaults.error ? <ErrorNote error={makeDefaults.error} /> : null}
        </Card>
      ) : (
        <Table
          headers={[
            "Name",
            "Type",
            "Questions",
            "Received",
            "Allowed sites",
            "",
          ]}
        >
          {rows.map((f) => (
            <Row key={f.id}>
              <td className="py-2 font-medium">{f.name}</td>
              <td style={muted}>
                {f.kind}
                {f.tag ? <span className="ml-1 text-xs">· {f.tag}</span> : null}
              </td>
              <td style={muted}>{f.fields?.length ?? 0}</td>
              {/* A form on somebody else's website either works or it does
                  not, and this is the only thing on the screen that says
                  which. */}
              <td style={f.submissionCount > 0 ? undefined : muted}>
                {f.submissionCount > 0 ? f.submissionCount : "nothing yet"}
              </td>
              {/*
                A form with no sites listed works nowhere but here, and every
                embed is for somebody else's website — so the empty case is
                shown as something to fix rather than as a setting.
              */}
              <td style={f.allowedOrigins?.length ? muted : undefined}>
                <button
                  type="button"
                  className="text-left link"
                  onClick={() => setSiting(f)}
                >
                  {f.allowedOrigins?.length
                    ? f.allowedOrigins.join(", ")
                    : "No sites yet — add one"}
                </button>
              </td>
              {/* One press for the thing people come here for, and the rest
                  behind a menu — four buttons on every row was a table nobody
                  could read across. */}
              <td className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Button variant="secondary" onClick={() => setViewing(f)}>
                    Submissions
                  </Button>
                  <FormActions
                    form={f}
                    onEdit={() => setBuilding(f)}
                    onSites={() => setSiting(f)}
                    onEmbed={() => setShowing(f)}
                    onDeleted={() =>
                      qc.invalidateQueries({ queryKey: ["forms"] })
                    }
                  />
                </div>
              </td>
            </Row>
          ))}
        </Table>
      )}

      {siting ? (
        <AllowedSites
          form={rows.find((r) => r.id === siting.id) ?? siting}
          onClose={() => setSiting(null)}
        />
      ) : null}

      {viewing ? (
        <Submissions form={viewing} onClose={() => setViewing(null)} />
      ) : null}

      {building ? (
        <FormBuilder
          formId={building.id}
          fields={building.fields ?? []}
          tag={building.tag ?? null}
          style={building.style ?? null}
          redirectUrl={building.redirectUrl ?? null}
          notifyEmail={building.notifyEmail ?? null}
          onDone={() => setBuilding(null)}
        />
      ) : null}

      {showing ? (
        <EmbedCode form={showing} onClose={() => setShowing(null)} />
      ) : null}
    </div>
  );
}

/**
 * What else can be done with a form.
 *
 * The same menu the invoice and quote lists use, for the same reason: the
 * common action is a button and everything else is one press away, rather than
 * four buttons on every row of a table somebody is trying to read across.
 */
function FormActions({
  form,
  onEdit,
  onSites,
  onEmbed,
  onDeleted,
}: {
  form: FormRow;
  onEdit: () => void;
  onSites: () => void;
  onEmbed: () => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false);
  /** Asked twice: the submissions go with it. */
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: () => api(`/api/forms/${form.id}`, { method: "DELETE" }),
    onSuccess: () => {
      setOpen(false);
      onDeleted();
    },
  });

  return (
    <span className="relative inline-block">
      <button
        type="button"
        className="link-muted px-1"
        aria-label={`More for ${form.name}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="more-horizontal" size={16} />
      </button>
      {open ? (
        <span className="menu-panel z-10" onMouseLeave={() => setOpen(false)}>
          <button type="button" className="menu-item" onClick={onEdit}>
            Edit questions
          </button>
          <button type="button" className="menu-item" onClick={onSites}>
            Allowed sites
          </button>
          <button type="button" className="menu-item" onClick={onEmbed}>
            Embed code
          </button>
          <button
            type="button"
            className="menu-item"
            style={{ color: "var(--color-danger)" }}
            onClick={() => {
              if (confirming) remove.mutate();
              else setConfirming(true);
            }}
          >
            {confirming ? "Really delete it?" : "Delete"}
          </button>
        </span>
      ) : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </span>
  );
}

/**
 * The sites a form is allowed to appear on.
 *
 * Its own panel, and a list rather than a line of comma-separated text. This
 * is the setting that decides whether an embed works at all, and while it sat
 * inside the embed-code panel as one long string, the honest reading of the
 * product was that a form only worked on the instance itself.
 *
 * Each site is added and removed on its own, because that is what people do
 * with them: a business puts a form on its main site, then on a landing page,
 * then takes the landing page down.
 */
function AllowedSites({
  form,
  onClose,
}: {
  form: FormRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [entry, setEntry] = useState("");
  const sites = form.allowedOrigins ?? [];

  const save = useMutation({
    mutationFn: (next: string[]) =>
      api(`/api/forms/${form.id}`, {
        method: "PATCH",
        body: JSON.stringify({ allowedOrigins: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["forms"] }),
  });

  const add = () => {
    const site = entry.trim();
    if (!site) return;
    // Cleared after the server has taken it, not before: a rejected entry
    // stays in the box to be corrected rather than vanishing with the error.
    save.mutate([...sites, site], { onSuccess: () => setEntry("") });
  };

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">{form.name} — allowed sites</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      <p className="mb-3 text-sm" style={muted}>
        The websites this form may be embedded on. A form with no sites listed
        works only on this instance, so an embed pasted anywhere else shows
        nothing.
      </p>

      {sites.length ? (
        <ul className="mb-3 space-y-1">
          {sites.map((site) => (
            <li
              key={site}
              className="flex items-center justify-between border-t py-1.5 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <span>{site}</span>
              <button
                type="button"
                className="text-sm link-muted"
                disabled={save.isPending}
                onClick={() => save.mutate(sites.filter((s) => s !== site))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-sm" style={muted}>
          No sites yet.
        </p>
      )}

      <Field
        label="Add a site"
        hint="example.com, https://example.com or *.example.com for every subdomain. The site the form is on, not the page."
      >
        <div className="flex gap-2">
          <Input
            value={entry}
            placeholder="example.com"
            onChange={(e) => setEntry(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <Button onClick={add} disabled={save.isPending || !entry.trim()}>
            {save.isPending ? "Saving…" : "Add"}
          </Button>
        </div>
      </Field>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * The snippet a customer pastes into their own site.
 *
 * The origin allow-list is the security boundary, not the snippet: a form only
 * accepts posts from the sites listed on it, so a copied snippet on someone
 * else's page is refused.
 */
function EmbedCode({ form, onClose }: { form: FormRow; onClose: () => void }) {
  // Plain HTML: the endpoint accepts a normal form post, so the snippet needs
  // no JavaScript and works on any site, including ones that block scripts.
  // The honeypot is hidden from people and irresistible to bots.
  const base = window.location.origin;
  // One tag. The previous snippet was a whole <form>, which meant every change
  // to a field was a change to their website — and every site drifted out of
  // step with the form it was showing.
  const snippet = `<script src="${base}/embed.js" data-sentrello-form="${form.key}"></script>`;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">{form.name}</p>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {/*
        Said here as well as on the row, because this is the panel somebody
        has open at the moment they paste the snippet into their own site.
      */}
      {form.allowedOrigins?.length ? null : (
        <p className="mb-3 text-sm">
          This form has no allowed sites yet, so this snippet will show nothing
          anywhere but here. Add the site under <em>Allowed sites</em> first.
        </p>
      )}

      <p className="mt-1 mb-1 text-sm font-medium">Paste this into your page</p>
      <pre
        className="overflow-x-auto rounded border p-3 text-xs"
        style={{ borderColor: "var(--border)" }}
      >
        <code>{snippet}</code>
      </pre>
      <Button
        variant="secondary"
        className="mt-2"
        onClick={() => navigator.clipboard?.writeText(snippet)}
      >
        Copy
      </Button>
    </Card>
  );
}

/**
 * What people sent, and what to do about it.
 *
 * A submission already made a contact on the way in. Deciding it is worth
 * pursuing is a judgement, so promoting it into the pipeline is a button — a
 * pipeline that fills itself with every newsletter sign-up stops being looked
 * at.
 */
function Submissions({
  form,
  onClose,
}: {
  form: FormRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["submissions", form.id],
    queryFn: () =>
      api<{
        submissions: {
          id: string;
          payload: Record<string, string>;
          createdAt: string;
          contactId: string | null;
        }[];
      }>(`/api/forms/${form.id}/submissions`),
  });

  const promote = useMutation({
    mutationFn: (id: string) =>
      api<{ already?: boolean }>(`/api/forms/submissions/${id}/promote`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["deals"] });
      qc.invalidateQueries({ queryKey: ["submissions", form.id] });
    },
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <p className="font-medium">{form.name} — submissions</p>
        <div className="flex items-center gap-2">
          {/* A plain link rather than a fetch: the browser saves the file
              itself, with the name the server chose, and a large export never
              has to be held in memory here first. */}
          {data?.submissions.length ? (
            <a
              className="link text-sm"
              href={`/api/forms/${form.id}/submissions.csv`}
            >
              Export CSV
            </a>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {isLoading ? (
        <Loading />
      ) : data?.submissions.length ? (
        <ul className="space-y-2">
          {data.submissions.map((sub) => (
            <li
              key={sub.id}
              className="border-t pt-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  {Object.entries(sub.payload).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-xs" style={muted}>
                        {k}:{" "}
                      </span>
                      {v}
                    </div>
                  ))}
                  <div className="mt-0.5 text-xs" style={muted}>
                    {new Date(sub.createdAt).toLocaleString()}
                  </div>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => promote.mutate(sub.id)}
                  disabled={promote.isPending}
                >
                  Add to pipeline
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm" style={muted}>
          Nothing sent through this form yet.
        </p>
      )}
      {promote.error ? <ErrorNote error={promote.error} /> : null}
    </Card>
  );
}
