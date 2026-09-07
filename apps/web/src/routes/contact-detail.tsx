import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type Company, type Contact, type Meta, api } from "../lib/api";
import { useCrmSettings } from "../lib/crm-settings";
import { CustomValues } from "../lib/custom-fields";
import { Icon } from "../lib/icons";
import { ImageUpload } from "../lib/image-upload";
import {
  LabelledList,
  type Labelled as ListRow,
  tidy,
  withBlank,
} from "../lib/labelled-list";
import { RelatedLink, useNavigation, useRecordTitle } from "../lib/navigation";
import { TagChips } from "../lib/tags";
import { TaskList } from "../lib/tasks";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  border,
  formatDate,
  formatMoney,
  muted,
} from "../lib/ui";
import { ContactForm } from "./contact-form";
import { StatusLabel } from "./contacts";

/**
 * One contact, and everything attached to it.
 *
 * This screen is the answer to "you cannot tell what connects to what". A
 * contact is not a row in a table — it is a company, a pile of deals, the
 * notes somebody wrote after a phone call, and the task nobody has done
 * yet. Showing those together is the difference between a database with a form
 * on it and a CRM.
 */

interface Labelled {
  label: string;
  value: string;
}

interface Related {
  /**
   * The shared type, not a second copy of it.
   *
   * This screen kept its own idea of what a contact is, and it fell behind
   * the moment the record grew a status and a background — the fields existed
   * on the server and were invisible here.
   */
  contact: Contact;
  company: { id: string; name: string } | null;
  deals: {
    id: string;
    name: string;
    stage: string;
    amountCents: number;
    expectedCloseOn: string | null;
  }[];
  notes: {
    id: string;
    text: string;
    createdAt: string;
    attachments: { name: string; path: string; size: number }[] | null;
  }[];
  tasks: {
    id: string;
    title: string;
    description: string | null;
    type: string | null;
    dueAt: string | null;
    done: boolean;
  }[];
  tags: { id: string; name: string; color: string }[];
}

/** Every way to reach somebody, first-class column and labelled list together. */
function ways(primary: string | null, rest: Labelled[] | null): Labelled[] {
  const out: Labelled[] = primary ? [{ label: "main", value: primary }] : [];
  for (const item of rest ?? []) {
    // The primary is often repeated in the list; showing it twice looks like
    // a data problem to the person reading it.
    if (item.value && item.value !== primary) out.push(item);
  }
  return out;
}

/**
 * The contact's tags, from the editor every tagged thing uses.
 *
 * It lived here first and was then wanted on invoices and quotes. One editor
 * with the document's path passed in beats three copies of it.
 */
function Tags({
  contactId,
  attached,
}: {
  contactId: string;
  attached: Related["tags"];
}) {
  const qc = useQueryClient();
  return (
    <TagChips
      path={`/api/contacts/${contactId}`}
      attached={attached}
      onChanged={() =>
        qc.invalidateQueries({ queryKey: ["contact-related", contactId] })
      }
    />
  );
}

/**
 * What still has to be done about this person.
 *
 * The list, the four actions and the form are all the shared task component
 * now — the same one the CRM dashboard and the company page draw. It used to
 * be its own copy here, which is how this page came to have edit and delete
 * but no way to postpone anything, while the dashboard had the reverse.
 */
function Tasks({
  contactId,
  tasks,
  taskTypes,
}: {
  contactId: string;
  tasks: Related["tasks"];
  taskTypes: string[];
}) {
  return (
    <Card>
      <TaskList
        tasks={tasks}
        taskTypes={taskTypes}
        subject={{ contactId }}
        invalidate={[["contact-related", contactId], ["crm-dashboard"]]}
      />
    </Card>
  );
}

/** Attaching a file to a note that already exists. */
function Attach({ noteId, onDone }: { noteId: string; onDone: () => void }) {
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      // No content-type header: FormData sets its own with the boundary, and
      // overriding it makes the body unparseable at the other end.
      const res = await fetch(`/api/notes/${noteId}/attachments`, {
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

  return (
    <>
      <label className="cursor-pointer text-xs link-muted">
        {upload.isPending ? "Attaching…" : "Attach a file"}
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
    </>
  );
}

function Notes({
  contactId,
  notes,
}: { contactId: string; notes: Related["notes"] }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");

  const add = useMutation({
    mutationFn: () =>
      api("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          entityType: "contact",
          entityId: contactId,
          text,
        }),
      }),
    onSuccess: () => {
      setText("");
      qc.invalidateQueries({ queryKey: ["contact-related", contactId] });
    },
  });

  return (
    <Card>
      <p className="mb-2 font-medium">Notes</p>
      <textarea
        rows={2}
        value={text}
        placeholder="What was said?"
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
          onClick={() => add.mutate()}
          disabled={!text.trim() || add.isPending}
        >
          {add.isPending ? "Saving…" : "Add note"}
        </Button>
      </div>
      {add.error ? <ErrorNote error={add.error} /> : null}

      <div className="mt-3 space-y-2">
        {notes.length === 0 ? (
          <p className="text-sm" style={muted}>
            Nothing written down yet.
          </p>
        ) : (
          notes.map((n) => (
            <div
              key={n.id}
              className="border-t pt-2 text-sm"
              style={{ borderColor: "var(--border)" }}
            >
              <p className="whitespace-pre-wrap">{n.text}</p>

              {n.attachments?.length ? (
                <ul className="mt-1 space-y-0.5">
                  {n.attachments.map((a, i) => (
                    <li key={a.path} className="text-xs">
                      <a
                        href={`/api/notes/${n.id}/attachments/${i}`}
                        className="link"
                      >
                        {a.name}
                      </a>
                      <span className="ml-1" style={muted}>
                        {Math.max(1, Math.round(a.size / 1024))} KB
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              <p
                className="mt-0.5 flex items-center gap-2 text-xs"
                style={muted}
              >
                {formatDate(n.createdAt)}
                <Attach
                  noteId={n.id}
                  onDone={() =>
                    qc.invalidateQueries({
                      queryKey: ["contact-related", contactId],
                    })
                  }
                />
              </p>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

export function ContactDetail() {
  const qc = useQueryClient();
  const { current } = useNavigation();
  const settings = useCrmSettings();
  const id = current.recordId;
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["contact-related", id],
    queryFn: () => api<Related>(`/api/contacts/${id}/related`),
    enabled: Boolean(id),
  });

  const companies = useQuery({
    queryKey: ["companies", "all"],
    queryFn: () => api<{ companies: Company[] }>("/api/companies"),
  });

  // So a link somebody was sent shows the person's name, not "Contacts".
  useRecordTitle(data?.contact.name);

  if (!id) return <Empty title="No contact selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const { contact, company, deals, notes, tasks, tags } = data;
  const emails = ways(contact.email, contact.emails);
  const phones = ways(contact.phone, contact.phones);
  const open = deals.filter((d) => d.stage !== "won" && d.stage !== "lost");

  if (editing) {
    // The same form as creating one, so status, background, the extra emails
    // and the extra phones are editable in both places. Two forms over one
    // record is how a field ends up editable in one and not the other — the
    // reason a second email could only be added after the contact existed.
    return (
      <ContactForm
        contact={contact}
        settings={settings}
        companies={companies.data?.companies ?? []}
        onDone={() => {
          setEditing(false);
          qc.invalidateQueries({ queryKey: ["contact-related", id] });
          qc.invalidateQueries({ queryKey: ["contacts"] });
        }}
      />
    );
  }

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
      <div className="space-y-4">
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <div className="flex items-center gap-3">
              <ImageUpload
                subject="contacts"
                id={contact.id}
                name={contact.name}
                hasImage={Boolean(contact.avatarPath)}
              />
              <div>
                <p className="flex items-center gap-2 text-lg font-semibold">
                  {contact.name}
                  {/* How warm the relationship is, where the name is — it is
                      the first thing somebody wants to know on opening a
                      contact, and it was only visible in the list. */}
                  <StatusLabel status={contact.status} settings={settings} />
                </p>
                <p className="text-sm" style={muted}>
                  {[contact.title, company?.name]
                    .filter(Boolean)
                    .join(" at ") || "No job title"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Tags contactId={contact.id} attached={tags} />
              <button
                type="button"
                className="text-sm link-muted"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            </div>
          </div>

          {/*
            How they were met, who introduced them, what they care about.

            The one thing a CRM holds that a spreadsheet does not, so it sits
            on the record rather than buried in a note somebody has to find.
          */}
          {contact.background ? (
            <p className="mt-3 whitespace-pre-line text-sm">
              <span style={muted}>Background: </span>
              {contact.background}
            </p>
          ) : null}

          {/* The company is a record, not a label — following it is the point. */}
          {company ? (
            <p className="mt-3 text-sm">
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

          <CustomValues
            fields={settings.customFields.filter(
              (f) => f.appliesTo === "contact",
            )}
            values={contact.customValues}
          />

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs" style={muted}>
                Email
              </p>
              {emails.length ? (
                emails.map((e) => (
                  <p key={e.value} className="text-sm">
                    <a href={`mailto:${e.value}`} className="link">
                      {e.value}
                    </a>
                    <span className="ml-1 text-xs" style={muted}>
                      {e.label}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-sm" style={muted}>
                  None
                </p>
              )}
            </div>
            <div>
              <p className="text-xs" style={muted}>
                Phone
              </p>
              {phones.length ? (
                phones.map((p) => (
                  <p key={p.value} className="text-sm">
                    <a href={`tel:${p.value}`} className="link">
                      {p.value}
                    </a>
                    <span className="ml-1 text-xs" style={muted}>
                      {p.label}
                    </span>
                  </p>
                ))
              ) : (
                <p className="text-sm" style={muted}>
                  None
                </p>
              )}
            </div>
          </div>
        </Card>

        <Notes contactId={contact.id} notes={notes} />
      </div>

      <div className="space-y-4">
        <Card>
          <p className="mb-2 font-medium">
            Deals{" "}
            <span className="text-sm font-normal" style={muted}>
              ({open.length} open)
            </span>
          </p>
          {deals.length === 0 ? (
            <p className="text-sm" style={muted}>
              Not on any deals.
            </p>
          ) : (
            <div className="space-y-2">
              {deals.map((d) => (
                <div key={d.id} className="text-sm">
                  <RelatedLink
                    to={{ moduleId: "deals", recordId: d.id, title: d.name }}
                  >
                    {d.name}
                  </RelatedLink>
                  <div className="text-xs" style={muted}>
                    {d.stage} · {formatMoney(d.amountCents)}
                    {d.expectedCloseOn
                      ? ` · closes ${formatDate(d.expectedCloseOn)}`
                      : ""}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Tasks
          contactId={contact.id}
          tasks={tasks}
          taskTypes={settings.taskTypes}
        />

        <HistoryPanel contactId={contact.id} />
      </div>
    </div>
  );
}

/**
 * Everything that happened, in one column.
 *
 * Notes, emails captured off the mail somebody already sent, tasks done, deals
 * opened and filed away. It is the panel that answers "what has gone on with
 * these people", which is the question a CRM exists for and the one the
 * separate panels could not answer between them.
 */
export function HistoryPanel({
  contactId,
  companyId,
}: {
  contactId?: string;
  companyId?: string;
}) {
  const query = contactId
    ? `contactId=${contactId}`
    : companyId
      ? `companyId=${companyId}`
      : "";

  const { data, isLoading } = useQuery({
    queryKey: ["crm-history", query],
    queryFn: () =>
      api<{
        history: {
          at: string;
          kind: string;
          title: string;
          detail: string | null;
        }[];
      }>(`/api/crm/history?${query}`),
    enabled: query !== "",
  });

  // Already in the cache from the shell's own fetch, so this costs no request.
  const tier = useQuery({
    queryKey: ["meta"],
    queryFn: () => api<Meta>("/api/_meta"),
  }).data?.tier;

  /**
   * The money half, which the Free history does not have.
   *
   * `/api/crm/history` reads notes, activities, tasks and deals. What the
   * person was billed and what they paid is the other half of what the plan
   * calls a 360° timeline, and it lives behind a Pro route that nothing has
   * ever called — so the panel has been three-quarters of itself since it was
   * written, on instances paying for the other quarter.
   *
   * Asked for only on Pro, and only for a contact: the route is per contact,
   * and on Free there is nothing behind it but a 404 on every contact opened.
   */
  const money = useQuery({
    queryKey: ["contact-timeline", contactId],
    queryFn: () =>
      api<{
        timeline: {
          kind: string;
          at: string;
          id: string;
          summary: string | null;
          amountCents?: number;
        }[];
      }>(`/api/contacts/${contactId}/timeline`),
    enabled: Boolean(contactId) && tier === "pro",
  });

  /**
   * Merged into one column rather than shown beside it, because "what has gone
   * on with these people" is one question and an invoice raised the day after
   * a call is the answer to it.
   */
  const entries = [
    ...(data?.history ?? []),
    ...(money.data?.timeline ?? [])
      .filter((row) => row.kind === "invoice" || row.kind === "payment")
      .map((row) => ({
        at: row.at,
        kind: row.kind,
        title:
          row.kind === "invoice"
            ? `Invoice ${row.summary ?? ""}`.trim()
            : `Paid${row.summary ? ` by ${row.summary}` : ""}`,
        detail:
          row.amountCents === undefined ? null : formatMoney(row.amountCents),
      })),
  ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

  const icon: Record<string, string> = {
    note: "clipboard",
    email: "mail",
    call: "phone",
    meeting: "calendar",
    task: "check-square",
    deal: "handshake",
    contact: "contact",
    invoice: "file-text",
    payment: "wallet",
  };

  return (
    <Card>
      <p className="mb-2 font-medium">History</p>
      {isLoading ? (
        <Loading />
      ) : entries.length === 0 ? (
        <p className="text-sm" style={muted}>
          Nothing yet. Notes, emails and finished tasks all land here.
        </p>
      ) : (
        <ul className="space-y-2">
          {entries.map((entry) => (
            <li
              key={`${entry.at}-${entry.title}`}
              className="flex gap-2 text-sm"
            >
              <span className="mt-0.5" style={muted}>
                <Icon name={icon[entry.kind] ?? "clipboard"} size={14} />
              </span>
              <span className="min-w-0">
                <span className="block whitespace-pre-line">{entry.title}</span>
                <span className="text-xs" style={muted}>
                  {formatDate(entry.at)}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
