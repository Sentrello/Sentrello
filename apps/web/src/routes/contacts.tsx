import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { type Company, type Contact, type Tag, api } from "../lib/api";
import { useSession } from "../lib/auth";
import { Avatar } from "../lib/avatar";
import {
  type CrmSettings,
  StatusDot,
  managerName,
  useCrmManagers,
  useCrmSettings,
} from "../lib/crm-settings";
import { Icon } from "../lib/icons";
import {
  FilterGroup,
  FilterPanel,
  FilterToggle,
  Pagination,
  SortMenu,
  useLastSeenRanges,
  useListQuery,
  useListState,
} from "../lib/list-ui";
import { useNavigation } from "../lib/navigation";
import {
  Button,
  Empty,
  ErrorNote,
  Loading,
  Select,
  border,
  muted,
} from "../lib/ui";
import { ContactForm } from "./contact-form";
import { ContactsImport } from "./contacts-import";

/**
 * Everybody the business deals with.
 *
 * Laid out the way the reference lays it out, because that layout is right: a
 * rail of filters on the left that narrows without leaving the screen, and a
 * table on the right that says who somebody is at a glance. The filters run
 * on the server — a business with two thousand contacts cannot filter a list
 * the browser has not finished downloading.
 */
export function Contacts() {
  const qc = useQueryClient();
  const { open, takeIntent } = useNavigation();
  // Opened with the form already up when somebody hit "+" on the CRM
  // dashboard, which is where the reference sends that button too.
  const [adding, setAdding] = useState(() => takeIntent() === "new");
  const [importing, setImporting] = useState(false);

  /**
   * Which rows are ticked, for the actions that work on several at once.
   *
   * Tagging forty contacts one at a time is the job a CRM is supposed to
   * remove, so Atomic puts tag, export and delete behind a selection and this
   * does the same.
   */
  const [selected, setSelected] = useState<string[]>([]);
  const toggleSelected = (id: string, on: boolean) =>
    setSelected((current) =>
      on ? [...current, id] : current.filter((x) => x !== id),
    );

  const state = useListState({ sort: "lastSeenAt", order: "desc" });
  const settings = useCrmSettings();
  const managers = useCrmManagers();
  const ranges = useLastSeenRanges();
  const { rows, total, paginated, isLoading, error } = useListQuery<Contact>(
    "contacts",
    state,
  );

  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: () =>
      api<{ tags: { id: string; name: string; color: string }[] }>("/api/tags"),
  });

  // Who is signed in, for the "contacts I manage" filter. Better Auth's own
  // hook, not /api/_meta — that endpoint describes the instance and its
  // modules, and has never carried a user.
  const session = useSession();
  const myId = session.data?.user?.id;

  const companies = useQuery({
    queryKey: ["companies", "all"],
    queryFn: () => api<{ companies: Company[] }>("/api/companies"),
  });

  const companyName = (id: string | null) =>
    id ? companies.data?.companies.find((c) => c.id === id)?.name : undefined;

  /**
   * A selection only means anything against the rows it was made on.
   *
   * Filtering or paging with rows still ticked would leave a "delete 12
   * contacts" button aimed at records nobody can see — so the query the list
   * is showing is part of what the selection belongs to.
   */
  const listKey = `${state.q}|${JSON.stringify(state.filters)}|${state.page}`;
  const shownKey = useRef(listKey);
  if (shownKey.current !== listKey) {
    shownKey.current = listKey;
    if (selected.length) setSelected([]);
  }

  if (error) return <ErrorNote error={error} />;

  return (
    <div className="flex gap-6">
      <FilterPanel state={state} placeholder="Search contacts">
        <FilterGroup label="Last seen" icon="clock">
          {ranges.map((range) => (
            <FilterToggle
              key={range.label}
              label={range.label}
              active={state.isFilterActive(range.values)}
              onClick={() => {
                // The five ranges are alternatives, not a set: picking "today"
                // while "before last month" is on asks for contacts seen in
                // both, which is nothing at all.
                state.setFilter({
                  lastSeenAfter: undefined,
                  lastSeenBefore: undefined,
                });
                if (!state.isFilterActive(range.values)) {
                  state.setFilter(range.values);
                }
              }}
            />
          ))}
        </FilterGroup>

        <FilterGroup label="Status" icon="trending-up">
          {settings.contactStatuses.map((status) => (
            <FilterToggle
              key={status.id}
              label={
                <span className="flex items-center gap-1.5">
                  <StatusDot color={status.color} />
                  {status.label}
                </span>
              }
              active={state.isFilterActive({ status: status.id })}
              onClick={() => state.toggleFilter({ status: status.id })}
            />
          ))}
        </FilterGroup>

        {tags.data?.tags.length ? (
          <FilterGroup label="Tags" icon="tag">
            {tags.data.tags.map((tag) => (
              <FilterToggle
                key={tag.id}
                label={
                  <span
                    className="rounded px-1.5 py-0.5 text-xs"
                    style={{ background: tag.color, color: "#1a1a1a" }}
                  >
                    {tag.name}
                  </span>
                }
                active={state.isFilterActive({ tagId: tag.id })}
                onClick={() => state.toggleFilter({ tagId: tag.id })}
              />
            ))}
          </FilterGroup>
        ) : null}

        <FilterGroup label="Tasks" icon="check-square">
          <FilterToggle
            label="With pending tasks"
            active={state.isFilterActive({ withPendingTasks: "1" })}
            onClick={() => state.toggleFilter({ withPendingTasks: "1" })}
          />
        </FilterGroup>

        <FilterGroup label="Account manager" icon="users">
          {/*
            Everybody who can own a contact, not only "me".
            
            The list comes from the platform's roles rather than a table this
            module keeps, so it is right the moment somebody is given the
            Sales role in Users — and right again when they leave.
          */}
          <FilterToggle
            label="Contacts I manage"
            active={!!myId && state.isFilterActive({ ownerId: myId })}
            onClick={() => myId && state.toggleFilter({ ownerId: myId })}
          />
          {managers
            .filter((manager) => manager.userId !== myId)
            .map((manager) => (
              <FilterToggle
                key={manager.userId}
                label={managerName(manager)}
                active={state.isFilterActive({ ownerId: manager.userId })}
                onClick={() => state.toggleFilter({ ownerId: manager.userId })}
              />
            ))}
        </FilterGroup>

        <FilterGroup label="Newsletter" icon="clipboard">
          <FilterToggle
            label="Subscribed"
            active={state.isFilterActive({ hasNewsletter: "1" })}
            onClick={() => state.toggleFilter({ hasNewsletter: "1" })}
          />
        </FilterGroup>
      </FilterPanel>

      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <SortMenu
            state={state}
            fields={[
              { field: "lastSeenAt", label: "Last seen", order: "desc" },
              { field: "firstSeenAt", label: "First seen", order: "desc" },
              { field: "firstName", label: "First name", order: "asc" },
              { field: "lastName", label: "Last name", order: "asc" },
              { field: "createdAt", label: "Date added", order: "desc" },
            ]}
          />

          <div className="ml-auto flex items-center gap-2">
            <Button variant="secondary" onClick={() => setImporting((v) => !v)}>
              <span className="flex items-center gap-1.5">
                <Icon name="clipboard" size={15} />
                Import
              </span>
            </Button>
            {/* A plain link, not a fetch: the browser downloads it with the
                filename the server sends, and the session cookie goes along. */}
            <a
              href={`/api/contacts/export.csv?${new URLSearchParams(state.filters).toString()}`}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm"
              style={border}
            >
              <Icon name="file-text" size={15} />
              Export
            </a>
            <Button onClick={() => setAdding(true)}>
              <span className="flex items-center gap-1.5">
                <Icon name="plus" size={15} />
                New contact
              </span>
            </Button>
          </div>
        </div>

        {importing ? (
          <ContactsImport onDone={() => setImporting(false)} />
        ) : null}

        {adding ? (
          <ContactForm
            settings={settings}
            companies={companies.data?.companies ?? []}
            onDone={(created) => {
              setAdding(false);
              qc.invalidateQueries({ queryKey: ["contacts"] });
              if (created) {
                open({
                  moduleId: "contacts",
                  recordId: created.id,
                  title: created.name,
                });
              }
            }}
          />
        ) : null}

        {selected.length ? (
          <BulkActions
            selected={selected}
            tags={tags.data?.tags ?? []}
            onDone={() => {
              setSelected([]);
              qc.invalidateQueries({ queryKey: ["contacts"] });
            }}
            onClear={() => setSelected([])}
          />
        ) : null}

        {isLoading ? (
          <Loading />
        ) : rows.length === 0 ? (
          <Empty
            title={
              state.q || state.hasFilters ? "No matches" : "No contacts yet"
            }
          >
            {state.q || state.hasFilters
              ? "Try a different search, or clear the filters."
              : "People who fill in your forms or book with you land here automatically."}
          </Empty>
        ) : (
          <>
            {/*
              A list of rows, not a table of columns.
              
              Atomic lays a contact out as one line — who they are, then what
              little there is worth knowing at a glance — rather than as six
              columns of which four are usually "—". A table of email, phone,
              company and status spends most of its width on dashes; this
              spends it on the name and the tags.
            */}
            <div
              className="overflow-hidden rounded border"
              style={{ ...border, background: "var(--surface-raised)" }}
            >
              {rows.map((c, i) => (
                <div
                  key={c.id}
                  className="flex items-center gap-3 px-3 py-2"
                  style={
                    i > 0 ? { borderTop: "1px solid var(--border)" } : undefined
                  }
                >
                  <input
                    type="checkbox"
                    aria-label={`Select ${c.name}`}
                    checked={selected.includes(c.id)}
                    onChange={(e) => toggleSelected(c.id, e.target.checked)}
                  />
                  <Avatar
                    // Only ask for a picture when the record says it has one:
                    // a page of 25 contacts otherwise fires 25 requests that
                    // all come back 404.
                    src={
                      c.avatarPath ? `/api/crm/contacts/${c.id}/image` : null
                    }
                    name={c.name}
                    size={36}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() =>
                      open({
                        moduleId: "contacts",
                        recordId: c.id,
                        title: c.name,
                      })
                    }
                  >
                    <span className="link block font-medium">{c.name}</span>
                    <span
                      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs"
                      style={muted}
                    >
                      {describe(c, companyName(c.companyId))}
                      {c.tags?.map((tag) => (
                        <span
                          key={tag.id}
                          className="rounded px-1.5 py-0.5"
                          style={{ background: tag.color, color: "#1a1a1a" }}
                        >
                          {tag.name}
                        </span>
                      ))}
                    </span>
                  </button>
                  <span
                    className="flex shrink-0 items-center gap-2 text-xs"
                    style={muted}
                  >
                    Last activity {sinceLabel(c.lastSeenAt)}
                    <StatusLabel status={c.status} settings={settings} />
                  </span>
                </div>
              ))}
            </div>

            {/* Pages appear once there are more contacts than fit comfortably,
                which is what "after 25+" means in practice. */}
            {paginated ? <Pagination state={state} total={total} /> : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The line under a contact's name: what they do, where, and what is owed.
 *
 * "Operations at Kestrel Media · 2 tasks". Assembled rather than laid out in
 * columns because most contacts have only some of it, and a column per part
 * means a row of dashes for everybody who is missing two.
 */
function describe(contact: Contact, company: string | undefined): string {
  const role = [contact.title, company].filter(Boolean).join(" at ");
  const tasks = contact.openTasks
    ? `${contact.openTasks} task${contact.openTasks === 1 ? "" : "s"}`
    : "";
  return [role, tasks].filter(Boolean).join(" · ");
}

/** The status as its colour and its label, not as a raw id. */
export function StatusLabel({
  status,
  settings,
}: {
  status: string;
  settings: CrmSettings;
}) {
  const found = settings.contactStatuses.find((s) => s.id === status);
  if (!found) return <span style={muted}>—</span>;
  return (
    <span className="flex items-center gap-1.5 text-sm">
      <StatusDot color={found.color} />
      {found.label}
    </span>
  );
}

/** "3 days ago" — an exact timestamp is not what anybody is asking. */
export function sinceLabel(value: string | null): string {
  if (!value) return "—";
  const days = Math.floor(
    (Date.now() - new Date(value).getTime()) / 86_400_000,
  );
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? "a month ago" : `${months} months ago`;
}

/**
 * What you can do to several contacts at once.
 *
 * Tag, export and delete, which is Atomic's set. Deleting is behind a second
 * click because it is the only one of the three that cannot be undone, and a
 * selection of forty is exactly when a misclick is expensive.
 */
function BulkActions({
  selected,
  tags,
  onDone,
  onClear,
}: {
  selected: string[];
  tags: Tag[];
  onDone: () => void;
  onClear: () => void;
}) {
  const [confirming, setConfirming] = useState(false);

  const applyTag = useMutation({
    mutationFn: async (tagId: string) => {
      // One call per contact, deliberately: the tag endpoint is per-record,
      // and a bulk write path would be a second way to do the same thing with
      // its own scoping rules to get wrong.
      for (const id of selected) {
        await api(`/api/contacts/${id}/tags`, {
          method: "POST",
          body: JSON.stringify({ tagId }),
        });
      }
    },
    onSuccess: onDone,
  });

  const remove = useMutation({
    mutationFn: async () => {
      const refused: string[] = [];
      for (const id of selected) {
        try {
          await api(`/api/contacts/${id}`, { method: "DELETE" });
        } catch (err) {
          // A customer with invoices cannot be deleted, and the server says
          // so per contact. Carrying on and reporting at the end beats
          // stopping halfway through a selection of forty.
          refused.push((err as Error).message);
        }
      }
      if (refused.length) throw new Error(refused[0]);
    },
    onSuccess: onDone,
  });

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded border px-3 py-2"
      style={{ ...border, background: "var(--surface-raised)" }}
    >
      <span className="text-sm font-medium">{selected.length} selected</span>

      {tags.length ? (
        <span className="flex items-center gap-1.5 text-sm" style={muted}>
          Add tag
          <Select
            value=""
            aria-label="Add a tag to the selected contacts"
            className="w-auto"
            disabled={applyTag.isPending}
            onChange={(e) => e.target.value && applyTag.mutate(e.target.value)}
          >
            <option value="">Choose…</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </Select>
        </span>
      ) : null}

      <div className="ml-auto flex items-center gap-2">
        <Button variant="secondary" onClick={onClear}>
          Clear
        </Button>
        {confirming ? (
          <Button
            variant="danger"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
          >
            {remove.isPending
              ? "Deleting…"
              : `Really delete ${selected.length}`}
          </Button>
        ) : (
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Delete
          </Button>
        )}
      </div>

      {applyTag.error ? <ErrorNote error={applyTag.error} /> : null}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </div>
  );
}
