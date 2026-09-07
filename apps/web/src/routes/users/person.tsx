import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { useNavigation, useRecordTitle } from "../../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Row,
  Table,
  Tabs,
  activeTab,
  formatDate,
  muted,
} from "../../lib/ui";
import { AccessMatrix, type Grant } from "./access-matrix";

/**
 * One person: the six tabs the design gives them
 * (`docs/plan/Users-IAM-Console-Design.md:130-140`) — Details, Credentials,
 * Access, Groups, Sessions, Activity.
 *
 * Access is the point of the whole console: what somebody may actually do,
 * and where each grant came from. The other five are what an administrator
 * needs to act on that — issue a password, put them in the group that grants
 * it, or see the device they are signed in from.
 */

/** One person, as `GET`/`PATCH /api/users/:userId` return them. */
interface Person {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  role: string;
  baseRole: string;
  groups: string[];
  twoFactorEnabled: boolean;
  locked: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
  twoFactorRequired: boolean;
  lastSeenAt: string | null;
  you: boolean;
  disabledAt: string | null;
  emailVerified: boolean;
  joinedAt: string;
}

interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  roles: string[];
  members: { userId: string; name: string; email: string }[];
}

interface SessionRow {
  id: string;
  device: string;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  current: boolean;
}

interface Event {
  id: string;
  at: string;
  actor: string | null;
  subject: string | null;
  says: string;
}

const TABS = [
  { id: "details", label: "Details" },
  { id: "credentials", label: "Credentials" },
  { id: "access", label: "Access" },
  { id: "groups", label: "Groups" },
  { id: "sessions", label: "Sessions" },
  { id: "activity", label: "Activity" },
];

/**
 * The tab named in the URL, or `""` when none is.
 *
 * `pathOf`/`viewFromPath` (`../../lib/navigation.tsx`) parse exactly
 * `/module` or `/module/:recordId` and stop there; teaching them about a tab
 * id would be a change every other record screen inherits for a rule only
 * this screen needs. So this owns `?tab=` itself — read here on the first
 * render, written back with `history.replaceState` (not `pushState`: a tab is
 * not a place worth pressing back through). `activeTab`
 * (`../../lib/ui.tsx`) supplies the fallback when the id names no tab, so
 * this only has to read it.
 *
 * Exported and tested on its own (`person.test.ts`) rather than only
 * exercised through the rendered component, per Ruling 39.
 */
export function tabFromSearch(search: string): string {
  return new URLSearchParams(search).get("tab") ?? "";
}

export function PersonDetail() {
  const { current } = useNavigation();
  const id = current.recordId;
  const [tabId, setTabId] = useState(() =>
    tabFromSearch(window.location.search),
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["person", id],
    queryFn: () => api<{ person: Person }>(`/api/users/${id}`),
    enabled: Boolean(id),
  });

  // So a link somebody was sent shows the person's name, not "People".
  useRecordTitle(data?.person.name);

  if (!id) return <Empty title="No person selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

  const person = data.person;
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
      {shown?.id === "details" ? (
        <Details person={person} onChanged={refetch} />
      ) : null}
      {shown?.id === "credentials" ? (
        <Credentials person={person} onChanged={refetch} />
      ) : null}
      {shown?.id === "access" ? <Access userId={person.userId} /> : null}
      {shown?.id === "groups" ? (
        <PersonGroups person={person} onChanged={refetch} />
      ) : null}
      {shown?.id === "sessions" ? <Sessions userId={person.userId} /> : null}
      {shown?.id === "activity" ? <Activity userId={person.userId} /> : null}
    </div>
  );
}

function Details({
  person,
  onChanged,
}: {
  person: Person;
  onChanged: () => void;
}) {
  const toggle = useMutation({
    mutationFn: (disabled: boolean) =>
      api(`/api/users/${person.userId}`, {
        method: "PATCH",
        body: JSON.stringify({ disabled }),
      }),
    onSuccess: onChanged,
  });

  return (
    <Card>
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium">Name</dt>
          <dd style={muted}>{person.name || "—"}</dd>
        </div>
        <div>
          <dt className="font-medium">Email</dt>
          <dd style={muted}>
            {person.email}
            {person.emailVerified ? "" : " — not verified"}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Joined</dt>
          <dd style={muted}>{formatDate(person.joinedAt)}</dd>
        </div>
        <div>
          <dt className="font-medium">Last seen</dt>
          <dd style={muted}>
            {person.lastSeenAt ? formatDate(person.lastSeenAt) : "never"}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Status</dt>
          <dd style={muted}>
            {person.disabledAt
              ? `Disabled ${formatDate(person.disabledAt)}`
              : "Enabled"}
          </dd>
        </div>
      </dl>

      {person.you ? (
        <p className="mt-3 text-xs" style={muted}>
          You cannot disable your own account — ask another administrator.
        </p>
      ) : (
        <div className="mt-3">
          <Button
            variant={person.disabledAt ? "primary" : "danger"}
            disabled={toggle.isPending}
            onClick={() =>
              confirm(
                person.disabledAt
                  ? `Let ${person.email} sign in again?`
                  : `Disable ${person.email}? They lose access immediately and are signed out everywhere.`,
              ) && toggle.mutate(!person.disabledAt)
            }
          >
            {toggle.isPending
              ? "Saving…"
              : person.disabledAt
                ? "Enable"
                : "Disable"}
          </Button>
        </div>
      )}
      {toggle.error ? <ErrorNote error={toggle.error} /> : null}
    </Card>
  );
}

/**
 * Issuing a password and clearing two-factor.
 *
 * "Require a change at next sign-in" is in the design's table for this tab
 * but has no route behind it yet — nothing in this branch's server routes
 * stores that flag, so it is left off rather than wired to nothing. Reset
 * password and two-factor revoke both exist server-side (`people.ts`) and are
 * wired here the same way the old `People` screen used them.
 */
function Credentials({
  person,
  onChanged,
}: {
  person: Person;
  onChanged: () => void;
}) {
  const [issued, setIssued] = useState<string | null>(null);

  const resetPassword = useMutation({
    mutationFn: () =>
      api<{ password: string }>(`/api/users/${person.userId}/password`, {
        method: "POST",
      }),
    onSuccess: (r) => {
      setIssued(r.password);
      onChanged();
    },
  });

  const unlock = useMutation({
    mutationFn: () =>
      api(`/api/users/${person.userId}/unlock`, { method: "POST" }),
    onSuccess: onChanged,
  });

  const revokeTwoFactor = useMutation({
    mutationFn: () =>
      api(`/api/users/${person.userId}/two-factor/revoke`, {
        method: "POST",
      }),
    onSuccess: onChanged,
  });

  return (
    <div className="space-y-4">
      <Card>
        <p className="font-medium">Password</p>
        <p className="mt-1 text-sm" style={muted}>
          Issuing a new one signs {person.email} out everywhere. Read it to them
          and have them change it — it is shown once and stored nowhere.
        </p>
        <div className="mt-2">
          <Button
            disabled={resetPassword.isPending}
            onClick={() =>
              confirm(
                `Give ${person.email} a new password? Theirs stops working immediately.`,
              ) && resetPassword.mutate()
            }
          >
            {resetPassword.isPending ? "Issuing…" : "Issue a new password"}
          </Button>
        </div>
        {issued ? (
          <p className="money mt-2 text-lg tracking-wide">{issued}</p>
        ) : null}
        {resetPassword.error ? <ErrorNote error={resetPassword.error} /> : null}
      </Card>

      <Card>
        <p className="font-medium">Two-factor</p>
        <p className="mt-1 text-sm" style={muted}>
          {person.twoFactorEnabled
            ? "Set up on this account."
            : person.twoFactorRequired
              ? "Not set up — the rules say their role must have it."
              : "Not set up."}
        </p>
        {person.twoFactorEnabled ? (
          <div className="mt-2">
            <Button
              variant="danger"
              disabled={revokeTwoFactor.isPending}
              onClick={() =>
                confirm(
                  `Turn off two-factor for ${person.email}? They will be signed out everywhere and can set it up again.`,
                ) && revokeTwoFactor.mutate()
              }
            >
              Turn off
            </Button>
          </div>
        ) : null}
        {revokeTwoFactor.error ? (
          <ErrorNote error={revokeTwoFactor.error} />
        ) : null}
      </Card>

      {/*
        Only when there is something to say. An account nobody has failed to
        sign into does not need a card telling them so, and the lock is the
        one state on this screen that clears itself while somebody is looking
        at it.
      */}
      {person.locked ? (
        <Card>
          <p className="font-medium">Locked</p>
          <p className="mt-1 text-sm" style={muted}>
            {person.failedAttempts} failed attempts in a row.{" "}
            {person.lockedUntil
              ? `This lifts by itself at ${new Date(person.lockedUntil).toLocaleTimeString()}.`
              : "This lifts by itself shortly."}{" "}
            Unlocking now lets them try again immediately; it does not change
            their password.
          </p>
          <div className="mt-2">
            <Button disabled={unlock.isPending} onClick={() => unlock.mutate()}>
              {unlock.isPending ? "Unlocking…" : "Unlock"}
            </Button>
          </div>
          {unlock.error ? <ErrorNote error={unlock.error} /> : null}
        </Card>
      ) : null}
    </div>
  );
}

/** What they may actually do, and where each grant came from. */
function Access({ userId }: { userId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["person-access", userId],
    queryFn: () => api<{ grants: Grant[] }>(`/api/users/${userId}/access`),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  return <AccessMatrix grants={data?.grants ?? []} />;
}

/** Which groups they are in, and joining or leaving one. */
function PersonGroups({
  person,
  onChanged,
}: {
  person: Person;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const groupsKey = ["users-groups"];

  const { data, isLoading, error } = useQuery({
    queryKey: groupsKey,
    queryFn: () => api<{ groups: GroupRow[] }>("/api/users/groups"),
  });

  const settle = () => {
    qc.invalidateQueries({ queryKey: groupsKey });
    onChanged();
  };

  const join = useMutation({
    mutationFn: (groupId: string) =>
      api(`/api/users/groups/${groupId}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: person.userId }),
      }),
    onSuccess: settle,
  });

  const leave = useMutation({
    mutationFn: (groupId: string) =>
      api(`/api/users/groups/${groupId}/members/${person.userId}`, {
        method: "DELETE",
      }),
    onSuccess: settle,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const groups = data?.groups ?? [];
  const belongs = (g: GroupRow) =>
    g.members.some((m) => m.userId === person.userId);
  const mine = groups.filter(belongs);
  const others = groups.filter((g) => !belongs(g));

  return (
    <div className="space-y-4">
      <Card>
        <p className="font-medium">In</p>
        {mine.length === 0 ? (
          <p className="mt-1 text-sm" style={muted}>
            Not in any group.
          </p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {mine.map((g) => (
              <li key={g.id} className="flex items-center justify-between">
                <span>{g.name}</span>
                <button
                  type="button"
                  className="text-xs link-muted"
                  disabled={leave.isPending}
                  onClick={() => leave.mutate(g.id)}
                >
                  Leave
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {others.length > 0 ? (
        <Card>
          <p className="font-medium">Join a group</p>
          <ul className="mt-2 space-y-1 text-sm">
            {others.map((g) => (
              <li key={g.id} className="flex items-center justify-between">
                <span>{g.name}</span>
                <button
                  type="button"
                  className="text-xs link-muted"
                  disabled={join.isPending}
                  onClick={() => join.mutate(g.id)}
                >
                  Join
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

/** Their devices, and revoking one or all of them. */
function Sessions({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const key = ["person-sessions", userId];

  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ sessions: SessionRow[] }>(`/api/users/${userId}/sessions`),
  });

  const revokeOne = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/${userId}/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  const revokeAll = useMutation({
    mutationFn: () =>
      api(`/api/users/${userId}/sessions/revoke`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const sessions = data?.sessions ?? [];
  if (sessions.length === 0) return <Empty title="No devices signed in" />;

  return (
    <Card>
      <div className="mb-2 flex items-center justify-between">
        <p className="font-medium">Devices</p>
        <button
          type="button"
          className="text-xs link-muted"
          disabled={revokeAll.isPending}
          onClick={() =>
            confirm("Sign this person out everywhere?") && revokeAll.mutate()
          }
        >
          Sign out everywhere
        </button>
      </div>
      <Table headers={["Device", "IP", "Last active", ""]}>
        {sessions.map((s) => (
          <Row key={s.id}>
            <td className="py-2">
              {s.device}
              {s.current ? (
                <span className="ml-2 text-xs" style={muted}>
                  this device
                </span>
              ) : null}
            </td>
            {/* `||`, not `??` — Better Auth writes an empty string, not
                null, when nothing set the trusted header (see
                `sessions.tsx`), and `??` never catches that. */}
            <td style={muted}>{s.ipAddress || "—"}</td>
            <td style={muted}>{formatDate(s.updatedAt)}</td>
            <td className="text-right">
              <button
                type="button"
                className="text-xs link-muted"
                disabled={revokeOne.isPending}
                onClick={() => revokeOne.mutate(s.id)}
              >
                Sign out
              </button>
            </td>
          </Row>
        ))}
      </Table>
      {revokeOne.error ? <ErrorNote error={revokeOne.error} /> : null}
      {revokeAll.error ? <ErrorNote error={revokeAll.error} /> : null}
    </Card>
  );
}

/**
 * Every event where they are the actor or the subject.
 *
 * `GET /api/users/events` filters by one or the other, not both — two
 * requests, merged and sorted here, rather than a new server parameter for a
 * question only this one screen asks.
 */
function Activity({ userId }: { userId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["person-activity", userId],
    queryFn: async () => {
      const [asActor, asSubject] = await Promise.all([
        api<{ events: Event[] }>(
          `/api/users/events?actor=${encodeURIComponent(userId)}`,
        ),
        api<{ events: Event[] }>(
          `/api/users/events?subject=${encodeURIComponent(userId)}`,
        ),
      ]);
      const byId = new Map<string, Event>();
      for (const e of [...asActor.events, ...asSubject.events]) {
        byId.set(e.id, e);
      }
      return [...byId.values()].sort((a, b) => (a.at < b.at ? 1 : -1));
    },
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const events = data ?? [];
  if (events.length === 0) return <Empty title="Nothing recorded yet" />;

  return (
    <Card>
      <ul className="space-y-1 text-sm">
        {events.map((e) => (
          <li key={e.id}>
            <span style={muted}>{formatDate(e.at)}</span>{" "}
            <strong>{e.actor ?? "someone"}</strong> {e.says}
            {e.subject ? (
              <>
                {" "}
                <strong>{e.subject}</strong>
              </>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}
