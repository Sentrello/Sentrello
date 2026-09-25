import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type FormDefinition, api } from "../lib/api";
import { Icon } from "../lib/icons";
import {
  Button,
  ConfirmButton,
  Dialog,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  PageActions,
  Row,
  RowMenu,
  SectionHeading,
  Select,
  Table,
  Toolbar,
  muted,
} from "../lib/ui";
import { FormBuilder } from "./form-builder";

type FormRow = FormDefinition & {
  allowedOrigins: string[];
  /** How many have come in. The only question anybody has about an embed. */
  submissionCount: number;
};

/**
 * Which panel is open, and the form it is open on.
 *
 * One piece of state, not four booleans. The four were independent, so two
 * could be open at once — and because each panel was appended *below* the
 * table rather than drawn over it, opening one from a row thirty down put it
 * off the bottom of the screen with nothing to say it had happened.
 */
type Panel = {
  kind: "sites" | "submissions" | "embed" | "build";
  form: FormRow;
};

export function Forms() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [kind, setKind] = useState("contact");
  const [creating, setCreating] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);

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
      setCreating(false);
      qc.invalidateQueries({ queryKey: ["forms"] });
    },
  });

  if (forms.isLoading) return <Loading />;
  if (forms.error) return <ErrorNote error={forms.error} />;
  const rows = forms.data?.forms ?? [];

  return (
    <Page>
      {/*
       * The primary action goes in the page's own title line, where every
       * screen's does. It used to be a create form permanently mounted at the
       * top of the page: the first thing anybody saw, on every visit, was a
       * blank box for a form they had probably already made.
       */}
      <PageActions>
        <Button onClick={() => setCreating(true)}>New form</Button>
      </PageActions>

      <Dialog
        title="New form"
        open={creating}
        onClose={() => setCreating(false)}
      >
        <div className="flex flex-col gap-[--gap-stack]">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Contact form"
            />
          </Field>
          <Field
            label="Type"
            hint="What the form is for. It sets the questions it starts with."
          >
            <Select value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="contact">Contact</option>
              <option value="quote">Quote request</option>
            </Select>
          </Field>
          {create.error ? <ErrorNote error={create.error} /> : null}
          <Toolbar>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              {create.isPending ? "Creating…" : "Create form"}
            </Button>
          </Toolbar>
        </div>
      </Dialog>

      {rows.length === 0 ? (
        <Empty title="No forms yet">
          <p className="mb-[--gap-stack] text-sm" style={muted}>
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
        </Empty>
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
                {KINDS[f.kind] ?? f.kind}
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
                  onClick={() => setPanel({ kind: "sites", form: f })}
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
                <div className="flex items-center justify-end gap-[--gap-toolbar]">
                  <Button
                    variant="secondary"
                    onClick={() => setPanel({ kind: "submissions", form: f })}
                  >
                    Submissions
                  </Button>
                  <FormActions
                    form={f}
                    onEdit={() => setPanel({ kind: "build", form: f })}
                    onSites={() => setPanel({ kind: "sites", form: f })}
                    onEmbed={() => setPanel({ kind: "embed", form: f })}
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

      {/*
       * Every panel is a dialog over the page, not a card appended under it.
       * `Dialog` brings the title, the close and the focus trap the four
       * hand-built panels each did without — and being modal is what makes
       * "two open at once" impossible rather than merely unlikely.
       */}
      {panel ? (
        <Dialog
          title={panelTitle(panel)}
          size={
            panel.kind === "build"
              ? "xl"
              : panel.kind === "submissions"
                ? "lg"
                : "md"
          }
          open
          onClose={() => setPanel(null)}
        >
          {panel.kind === "sites" ? (
            <AllowedSites
              form={rows.find((r) => r.id === panel.form.id) ?? panel.form}
            />
          ) : panel.kind === "submissions" ? (
            <Submissions form={panel.form} />
          ) : panel.kind === "embed" ? (
            <EmbedCode form={panel.form} />
          ) : (
            <FormBuilder
              formId={panel.form.id}
              fields={panel.form.fields ?? []}
              tag={panel.form.tag ?? null}
              style={panel.form.style ?? null}
              redirectUrl={panel.form.redirectUrl ?? null}
              notifyEmail={panel.form.notifyEmail ?? null}
              onDone={() => setPanel(null)}
            />
          )}
        </Dialog>
      ) : null}
    </Page>
  );
}

/** The dialog's title, which is the sentence the old panels put in a `<p>`. */
function panelTitle(panel: Panel): string {
  const name = panel.form.name;
  if (panel.kind === "sites") return `${name} — allowed sites`;
  if (panel.kind === "submissions") return `${name} — submissions`;
  if (panel.kind === "embed") return `${name} — embed code`;
  return `${name} — questions`;
}

/** What a form's `kind` is called, rather than the word the database stores. */
const KINDS: Record<string, string> = {
  contact: "Contact",
  quote: "Quote request",
};

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
  /** Asked twice: the submissions go with it. */
  const [confirming, setConfirming] = useState(false);

  const remove = useMutation({
    mutationFn: () => api(`/api/forms/${form.id}`, { method: "DELETE" }),
    onSuccess: () => onDeleted(),
  });

  return (
    <>
      <RowMenu label={form.name}>
        {(close) => (
          <>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                onEdit();
              }}
            >
              Edit questions
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                onSites();
              }}
            >
              Allowed sites
            </button>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                close();
                onEmbed();
              }}
            >
              Embed code
            </button>
            <button
              type="button"
              className="menu-item"
              style={{ color: "var(--text-danger)" }}
              onClick={() => {
                if (confirming) remove.mutate();
                else setConfirming(true);
              }}
            >
              {confirming ? "Really delete it?" : "Delete"}
            </button>
          </>
        )}
      </RowMenu>
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </>
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
function AllowedSites({ form }: { form: FormRow }) {
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
    <div className="flex flex-col gap-[--gap-stack]">
      <p className="text-sm" style={muted}>
        The websites this form may be embedded on. A form with no sites listed
        works only on this instance, so an embed pasted anywhere else shows
        nothing.
      </p>

      {sites.length ? (
        <ul className="flex flex-col">
          {sites.map((site) => (
            <li
              key={site}
              className="flex items-center justify-between border-line border-t py-1.5 text-sm"
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
        <p className="text-sm" style={muted}>
          No sites yet.
        </p>
      )}

      <Field
        label="Add a site"
        hint="example.com, https://example.com or *.example.com for every subdomain. The site the form is on, not the page."
      >
        <Toolbar>
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
        </Toolbar>
      </Field>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </div>
  );
}

/**
 * The snippet a customer pastes into their own site.
 *
 * The origin allow-list is the security boundary, not the snippet: a form only
 * accepts posts from the sites listed on it, so a copied snippet on someone
 * else's page is refused.
 */
function EmbedCode({ form }: { form: FormRow }) {
  // Plain HTML: the endpoint accepts a normal form post, so the snippet needs
  // no JavaScript and works on any site, including ones that block scripts.
  // The honeypot is hidden from people and irresistible to bots.
  const base = window.location.origin;
  // One tag. The previous snippet was a whole <form>, which meant every change
  // to a field was a change to their website — and every site drifted out of
  // step with the form it was showing.
  const snippet = `<script src="${base}/embed.js" data-sentrello-form="${form.key}"></script>`;

  return (
    <div className="flex flex-col gap-[--gap-stack]">
      {/*
        Said here as well as on the row, because this is the panel somebody
        has open at the moment they paste the snippet into their own site.
      */}
      {form.allowedOrigins?.length ? null : (
        <p className="text-sm">
          This form has no allowed sites yet, so this snippet will show nothing
          anywhere but here. Add the site under <em>Allowed sites</em> first.
        </p>
      )}

      <SectionHeading level={3}>Paste this into your page</SectionHeading>
      <pre className="overflow-x-auto rounded-md border border-line p-[--pad-panel] text-xs">
        <code>{snippet}</code>
      </pre>
      <Toolbar>
        <Button
          variant="secondary"
          onClick={() => navigator.clipboard?.writeText(snippet)}
        >
          Copy
        </Button>
      </Toolbar>
    </div>
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
function Submissions({ form }: { form: FormRow }) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["submissions", form.id],
    queryFn: () =>
      api<{
        submissions: {
          id: string;
          payload: Record<string, string>;
          attachments?: { field: string; name: string; size: number }[];
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
    <div className="flex flex-col gap-[--gap-stack]">
      {/* A plain link rather than a fetch: the browser saves the file itself,
          with the name the server chose, and a large export never has to be
          held in memory here first. */}
      {data?.submissions.length ? (
        <Toolbar>
          <a
            className="link text-sm"
            href={`/api/forms/${form.id}/submissions.csv`}
          >
            Export CSV
          </a>
        </Toolbar>
      ) : null}

      {isLoading ? (
        <Loading />
      ) : data?.submissions.length ? (
        <ul className="flex flex-col gap-[--gap-toolbar]">
          {data.submissions.map((sub) => (
            <li
              key={sub.id}
              className="border-line border-t pt-[--gap-toolbar] text-sm"
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
                  {/* A plain link, like the export above it: the browser
                      saves the file itself and a large one is never held in
                      memory here. The file is handed back as a download with
                      a neutral content type, whatever it claims to be. */}
                  {sub.attachments?.length ? (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {sub.attachments.map((file, at) => (
                        <a
                          key={`${file.field}-${file.name}`}
                          className="link text-sm"
                          href={`/api/forms/submissions/${sub.id}/files/${at}`}
                        >
                          {file.name} ({Math.ceil(file.size / 1024)}KB)
                        </a>
                      ))}
                    </div>
                  ) : null}
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
    </div>
  );
}
