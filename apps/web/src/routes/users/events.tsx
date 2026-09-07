import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import {
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Select,
  Table,
  formatDate,
  muted,
} from "../../lib/ui";

/**
 * The whole audit log, searchable and filterable rather than only
 * skimmable — the screen the audit trail was built for.
 *
 * `GET /api/users/events` filters by actor, subject, action and a
 * `from`/`to` window, and pages with the same `list-query.ts` helpers the
 * CRM's lists use. Actor and subject are people or group ids, not free
 * text — an id nobody can type from memory — so both are pickers built from
 * the people and groups already on this instance rather than an input box
 * asking for something unreadable. `person.tsx` and `group.tsx`'s own
 * Activity tabs already link here with `subject=<id>` pre-filled; this is
 * the screen behind that link with every filter exposed.
 */

interface Event {
  id: string;
  at: string;
  actorId: string | null;
  actor: string | null;
  subjectId: string | null;
  subject: string | null;
  action: string;
  says: string;
}

interface PersonRow {
  userId: string;
  name: string;
  email: string;
}

interface GroupRow {
  id: string;
  name: string;
}

/**
 * Every action the platform records, in the words `security-events.ts`
 * (`packages/db/src/security-events.ts`) already gives each one — copied
 * rather than fetched, since this app has no dependency on `@sentrello/db`
 * to import the list from. There is nowhere else this pairing is written
 * down for a browser to read.
 */
const ACTIONS: { value: string; label: string }[] = [
  { value: "sign-in.succeeded", label: "Signed in" },
  { value: "sign-in.failed", label: "Failed to sign in" },
  { value: "account.unlocked", label: "Unlocked an account" },
  { value: "account.disabled", label: "Suspended someone" },
  { value: "account.enabled", label: "Restored someone" },
  { value: "password.reset", label: "Issued a new password" },
  { value: "two-factor.revoked", label: "Turned off two-factor" },
  { value: "session.revoked", label: "Signed out a device" },
  { value: "sessions.revoked", label: "Signed out every device" },
  { value: "role.changed", label: "Changed a role" },
  { value: "member.invited", label: "Invited somebody" },
  { value: "member.removed", label: "Removed somebody" },
  { value: "invitation.cancelled", label: "Withdrew an invitation" },
  { value: "group.created", label: "Created a group" },
  { value: "group.changed", label: "Changed what a group carries" },
  { value: "group.deleted", label: "Deleted a group" },
  { value: "group.joined", label: "Added somebody to a group" },
  { value: "group.left", label: "Took somebody out of a group" },
  { value: "policy.changed", label: "Changed the sign-in rules" },
  { value: "sso.connected", label: "Connected sign-in" },
  { value: "sso.disconnected", label: "Disconnected sign-in" },
  { value: "events.pruned", label: "Removed old history" },
];

export interface EventsFilter {
  actor: string;
  subject: string;
  action: string;
  from: string;
  to: string;
  page: number;
}

/**
 * The filter state as `GET /api/users/events` reads it — a blank field
 * means "don't ask for this", not the literal empty string.
 *
 * Exported and tested on its own (`events.test.ts`), per Ruling 39: the
 * shape a query-string builder gets wrong is silent, since a filter left
 * out just returns every row instead of failing loudly.
 */
export function eventsQuery(filter: EventsFilter): string {
  const params = new URLSearchParams({ page: String(filter.page) });
  if (filter.actor) params.set("actor", filter.actor);
  if (filter.subject) params.set("subject", filter.subject);
  if (filter.action) params.set("action", filter.action);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  return params.toString();
}

const EMPTY_FILTER: EventsFilter = {
  actor: "",
  subject: "",
  action: "",
  from: "",
  to: "",
  page: 1,
};

export function Events() {
  const [filter, setFilter] = useState<EventsFilter>(EMPTY_FILTER);
  const setField = (field: keyof EventsFilter, value: string) =>
    setFilter((f) => ({ ...f, [field]: value, page: 1 }));

  const people = useQuery({
    queryKey: ["users", "for-events"],
    queryFn: () => api<{ people: PersonRow[] }>("/api/users?perPage=200"),
  });
  const groups = useQuery({
    queryKey: ["user-groups"],
    queryFn: () => api<{ groups: GroupRow[] }>("/api/users/groups"),
  });

  const events = useQuery({
    queryKey: ["users-events", filter],
    queryFn: () =>
      api<{ events: Event[]; total: number; perPage: number }>(
        `/api/users/events?${eventsQuery(filter)}`,
      ),
    placeholderData: (previous) => previous,
  });

  if (people.isLoading || groups.isLoading) return <Loading />;
  if (people.error) return <ErrorNote error={people.error} />;
  if (groups.error) return <ErrorNote error={groups.error} />;

  const everybody = people.data?.people ?? [];
  const everyGroup = groups.data?.groups ?? [];
  const rows = events.data?.events ?? [];
  const total = events.data?.total ?? 0;
  const perPage = events.data?.perPage ?? 25;
  const pages = Math.max(1, Math.ceil(total / perPage));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Actor">
          <Select
            value={filter.actor}
            onChange={(e) => setField("actor", e.target.value)}
          >
            <option value="">Anybody</option>
            {everybody.map((p) => (
              <option key={p.userId} value={p.userId}>
                {p.name || p.email}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Subject">
          <Select
            value={filter.subject}
            onChange={(e) => setField("subject", e.target.value)}
          >
            <option value="">Anything</option>
            {everybody.length > 0 ? (
              <optgroup label="People">
                {everybody.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.name || p.email}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {everyGroup.length > 0 ? (
              <optgroup label="Groups">
                {everyGroup.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </Select>
        </Field>
        <Field label="Action">
          <Select
            value={filter.action}
            onChange={(e) => setField("action", e.target.value)}
          >
            <option value="">Anything</option>
            {ACTIONS.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="From">
          <Input
            type="date"
            value={filter.from}
            onChange={(e) => setField("from", e.target.value)}
          />
        </Field>
        <Field label="To">
          <Input
            type="date"
            value={filter.to}
            onChange={(e) => setField("to", e.target.value)}
          />
        </Field>
      </div>

      {events.isLoading ? (
        <Loading />
      ) : events.error ? (
        <ErrorNote error={events.error} />
      ) : rows.length === 0 ? (
        <Empty title="Nothing recorded">
          Nothing in the audit log matches this filter.
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span style={muted}>
              {total} {total === 1 ? "event" : "events"}
            </span>
            {pages > 1 ? (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  className="link-muted"
                  disabled={filter.page <= 1}
                  onClick={() =>
                    setFilter((f) => ({ ...f, page: Math.max(1, f.page - 1) }))
                  }
                >
                  Previous
                </button>
                <span style={muted}>
                  {filter.page} of {pages}
                </span>
                <button
                  type="button"
                  className="link-muted"
                  disabled={filter.page >= pages}
                  onClick={() =>
                    setFilter((f) => ({
                      ...f,
                      page: Math.min(pages, f.page + 1),
                    }))
                  }
                >
                  Next
                </button>
              </span>
            ) : null}
          </div>
          <Table headers={["When", "Who", "What", "Whom"]}>
            {rows.map((e) => (
              <Row key={e.id}>
                <td style={muted}>{formatDate(e.at)}</td>
                <td className="font-medium">{e.actor ?? "someone"}</td>
                <td>{e.says}</td>
                <td style={muted}>{e.subject ?? "—"}</td>
              </Row>
            ))}
          </Table>
        </>
      )}
    </div>
  );
}
