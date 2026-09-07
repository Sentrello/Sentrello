import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { useNavigation, useRecordTitle } from "../../lib/navigation";
import {
  Card,
  Empty,
  ErrorNote,
  Loading,
  Tabs,
  activeTab,
  formatDate,
  muted,
} from "../../lib/ui";
import { AccessMatrix, type Grant } from "./access-matrix";
import type { GroupRow } from "./groups";
import { tabFromSearch } from "./person";
import { policyLabel } from "./policy-ui";

/**
 * One group: who is in it, what it carries, and what has happened to it.
 *
 * The design gives it three tabs (`docs/plan/Users-IAM-Console-Design.md:142`)
 * — Members, Access, Activity — where the old `Groups` component
 * (`user-groups.tsx`) drew all of it in one row that expanded in place. No
 * Details tab: renaming and deleting stayed on `groups.tsx`'s list, the same
 * place `policies.tsx` keeps deleting a policy.
 *
 * There is no `GET /api/users/groups/:id` — the list route is the only one,
 * so this reads the same `["user-groups"]` list `groups.tsx` already caches
 * and finds its own row in it, the way the old expanding row did too.
 */

const TABS = [
  { id: "members", label: "Members" },
  { id: "access", label: "Access" },
  { id: "activity", label: "Activity" },
];

interface PolicyRow {
  role: string;
  builtIn: boolean;
  kind: "user" | "group" | "custom";
  allows: Record<string, string[]>;
}

interface PersonRow {
  userId: string;
  name: string;
  email: string;
}

interface Event {
  id: string;
  at: string;
  actor: string | null;
  subject: string | null;
  says: string;
}

export function GroupDetail() {
  const { current } = useNavigation();
  const id = current.recordId;
  const [tabId, setTabId] = useState(() =>
    tabFromSearch(window.location.search),
  );

  const { data, isLoading, error } = useQuery({
    queryKey: ["user-groups"],
    queryFn: () => api<{ groups: GroupRow[] }>("/api/users/groups"),
  });
  const group = data?.groups.find((g) => g.id === id);

  useRecordTitle(group?.name);

  if (!id) return <Empty title="No group selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!group) return <Empty title="Group not found" />;

  const shown = activeTab(TABS, tabId) ?? TABS[0];

  const changeTab = (next: string) => {
    setTabId(next);
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState({}, "", url);
  };

  return (
    <div className="space-y-4">
      <Tabs tabs={TABS} active={tabId} onChange={changeTab} />
      {shown?.id === "members" ? <Members group={group} /> : null}
      {shown?.id === "access" ? <Access group={group} /> : null}
      {shown?.id === "activity" ? <Activity groupId={group.id} /> : null}
    </div>
  );
}

/** Who is in it, and adding or removing somebody. */
function Members({ group }: { group: GroupRow }) {
  const qc = useQueryClient();

  // Everybody, for the "add somebody" list. Its own request rather than the
  // paged one the People list uses — a picker that cannot find the
  // two-hundredth person is a picker that cannot put them in a group. Two
  // hundred at a time is the server's own ceiling.
  const people = useQuery({
    queryKey: ["users", "for-groups"],
    queryFn: () => api<{ people: PersonRow[] }>("/api/users?perPage=200"),
  });

  const settle = () => qc.invalidateQueries({ queryKey: ["user-groups"] });

  const join = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/groups/${group.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId }),
      }),
    onSuccess: settle,
  });

  const leave = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/groups/${group.id}/members/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: settle,
  });

  if (people.isLoading) return <Loading />;
  if (people.error) return <ErrorNote error={people.error} />;

  const everybody = people.data?.people ?? [];
  const inGroup = new Set(group.members.map((m) => m.userId));
  const others = everybody.filter((p) => !inGroup.has(p.userId));

  return (
    <div className="space-y-4">
      <Card>
        <p className="font-medium">In {group.name}</p>
        {group.members.length === 0 ? (
          <p className="mt-1 text-sm" style={muted}>
            Nobody yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {group.members.map((m) => (
              <li key={m.userId} className="flex items-center justify-between">
                <span>{m.name || m.email}</span>
                <button
                  type="button"
                  className="text-xs link-muted"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(m.userId)}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {others.length > 0 ? (
        <Card>
          <p className="font-medium">Add somebody</p>
          <ul className="mt-2 space-y-1 text-sm">
            {others.map((p) => (
              <li key={p.userId} className="flex items-center justify-between">
                <span>{p.name || p.email}</span>
                <button
                  type="button"
                  className="text-xs link-muted"
                  disabled={join.isPending}
                  onClick={() => join.mutate(p.userId)}
                >
                  Add
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {join.error ? <ErrorNote error={join.error} /> : null}
      {leave.error ? <ErrorNote error={leave.error} /> : null}
    </div>
  );
}

/** What this group carries, and what that resolves to. */
/**
 * What the group's policies add up to, resolved by the server.
 *
 * This screen used to compute the union in the browser from
 * `GET /api/users/roles`, which made it a second implementation of what
 * `resolveAccess` does for a person. The role-precedence rule inside that
 * union was corrected three separate times on this branch, each time in one
 * place and not the others, so a copy in a language the server cannot check
 * was the last place it should live. `GET /api/users/groups/:id/access` is
 * the same union, asked once.
 */
function GroupAccess({ groupId }: { groupId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["group-access", groupId],
    queryFn: () =>
      api<{ grants: Grant[] }>(
        `/api/users/groups/${encodeURIComponent(groupId)}/access`,
      ),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <AccessMatrix grants={data?.grants ?? []} />;
}

function Access({ group }: { group: GroupRow }) {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["users-policies"],
    queryFn: () => api<{ roles: PolicyRow[] }>("/api/users/roles"),
  });

  const setRoles = useMutation({
    mutationFn: (next: string[]) =>
      api(`/api/users/groups/${group.id}`, {
        method: "PATCH",
        body: JSON.stringify({ roles: next }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-groups"] }),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const known = data?.roles ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <p className="font-medium">What {group.name} carries</p>
        <div className="mt-2 flex flex-wrap gap-3 text-sm">
          {known.map((policy) => (
            <label key={policy.role} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={group.roles.includes(policy.role)}
                disabled={setRoles.isPending}
                onChange={(e) =>
                  setRoles.mutate(
                    e.target.checked
                      ? [...group.roles, policy.role]
                      : group.roles.filter((r) => r !== policy.role),
                  )
                }
              />
              {policyLabel(policy.role)}
            </label>
          ))}
        </div>
        {setRoles.error ? <ErrorNote error={setRoles.error} /> : null}
      </Card>

      <GroupAccess groupId={group.id} />
    </div>
  );
}

/**
 * Everything recorded about this group, which is more than everything whose
 * subject is one.
 *
 * `?group=` rather than `?subject=`: a group's own events name it as their
 * subject, but joining and leaving name the *person*, because a person is who
 * joined. Filtering on subject alone showed half the history while looking
 * complete — an administrator would read this tab and conclude nobody had
 * ever been added to the group.
 */
function Activity({ groupId }: { groupId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["group-activity", groupId],
    queryFn: () =>
      api<{ events: Event[] }>(
        `/api/users/events?group=${encodeURIComponent(groupId)}`,
      ),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const events = data?.events ?? [];
  if (events.length === 0) return <Empty title="Nothing recorded yet" />;

  return (
    <Card>
      <ul className="space-y-1 text-sm">
        {events.map((e) => (
          <li key={e.id}>
            <span style={muted}>{formatDate(e.at)}</span>{" "}
            <strong>{e.actor ?? "someone"}</strong> {e.says}{" "}
            {/*
              The subject, which on this tab is the whole point: the group's
              own events name the group, and a join or leave names the person.
              Without it the row reads "Owner added to a group" and never says
              who, on the one screen where who is the question.
            */}
            {e.subject ? <strong>{e.subject}</strong> : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
