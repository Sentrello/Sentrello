import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { memberApi } from "../../lib/auth";
import { useNavigation } from "../../lib/navigation";
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
  formatDate,
  muted,
} from "../../lib/ui";

/**
 * Who is on this instance.
 *
 * Lifted out of the old do-everything `users.tsx` screen, unchanged apart from
 * one thing: a row used to go nowhere, and now opens the person — everything
 * this screen could already do to somebody (reset their password, sign them
 * out, remove them) plus everything a person is now that they have their own
 * six-tab screen (`person.tsx`) lives one click away instead of only here.
 *
 * People are searched and paged on the server. Most instances have twenty-five
 * of them and some have five hundred, and this screen used to load every one
 * with their sessions and their groups to draw a list nobody could read.
 */

interface Person {
  userId: string;
  memberId: string;
  name: string;
  email: string;
  /** Everything they hold: their own role and the roles of their groups. */
  role: string;
  /** The role given to them directly, which is the one a screen may change. */
  baseRole: string;
  groups: string[];
  twoFactorEnabled: boolean;
  twoFactorRequired: boolean;
  lastSeenAt: string | null;
  you: boolean;
}

interface Invitation {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
}

interface Change {
  at: string;
  actor: string;
  subject: string | null;
  says: string;
  detail: Record<string, unknown> | null;
}

/** The subset of a policy this screen needs, to fill the invite-role picker. */
interface Policy {
  role: string;
  kind: "user" | "group" | "custom";
}

/**
 * The people, and everything an administrator has to be able to do to them.
 *
 * Each destructive action asks first, and says what it will do rather than
 * "are you sure" — somebody removing a person at half past four should not
 * have to guess whether their invoices go with them.
 */
export function People() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [invitee, setInvitee] = useState("");
  const [inviteRole, setInviteRole] = useState("staff");
  /**
   * Searched and paged on the server.
   *
   * Most instances have twenty-five people and some have five hundred. The
   * screen used to load every one of them, with their sessions and their
   * groups, to draw a list nobody could read.
   */
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [issued, setIssued] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const data = useQuery({
    queryKey: ["users", q, page],
    queryFn: () =>
      api<{
        people: Person[];
        total: number;
        perPage: number;
        invitations: Invitation[];
        history: Change[];
      }>(
        `/api/users?page=${page}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`,
      ),
    // The list stays on screen while the next page loads, so a keystroke in
    // the search box does not blank the table to a spinner.
    placeholderData: (previous) => previous,
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["users"] });
  /**
   * What somebody can be invited as.
   *
   * The user policies plus anything the business wrote for itself. It used to
   * be three names typed here, so the five defaults and every custom policy
   * were invisible at the one moment they matter — the moment somebody is
   * given access.
   */
  const policies = useQuery({
    queryKey: ["users-policies"],
    queryFn: () => api<{ roles: Policy[] }>("/api/users/roles"),
  });
  const roleNames = (policies.data?.roles ?? [])
    .filter((r) => r.kind === "user" || r.kind === "custom")
    .map((r) => r.role);

  const setRole = useMutation({
    mutationFn: (input: { userId: string; role: string }) =>
      api(`/api/users/${input.userId}/role`, {
        method: "POST",
        body: JSON.stringify({ role: input.role }),
      }),
    onSuccess: refresh,
  });

  const invite = useMutation({
    mutationFn: async () => {
      const res = await memberApi.inviteMember({
        email: invitee.trim(),
        role: inviteRole,
      });
      if (res.error) throw new Error(res.error.message ?? "Could not invite");
    },
    onSuccess: () => {
      setInvitee("");
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const cancelInvite = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/invitations/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  const resetPassword = useMutation({
    mutationFn: (person: Person) =>
      api<{ password: string }>(`/api/users/${person.userId}/password`, {
        method: "POST",
      }).then((r) => ({ email: person.email, password: r.password })),
    onSuccess: (result) => {
      // Shown once, here, because it is never stored anywhere it could be
      // read again — and because the administrator is usually standing next
      // to the person who is locked out.
      setIssued(result);
      refresh();
    },
  });

  const revokeTwoFactor = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}/two-factor/revoke`, { method: "POST" }),
    onSuccess: refresh,
  });

  const signOut = useMutation({
    mutationFn: (userId: string) =>
      api(`/api/users/${userId}/sessions/revoke`, { method: "POST" }),
    onSuccess: refresh,
  });

  if (data.isLoading) return <Loading />;
  if (data.error) return <ErrorNote error={data.error} />;

  const people = data.data?.people ?? [];
  const invitations = data.data?.invitations ?? [];
  const total = data.data?.total ?? people.length;
  const pages = Math.max(1, Math.ceil(total / (data.data?.perPage ?? 50)));

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-2 font-medium">Invite somebody</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Email">
            <Input
              type="email"
              value={invitee}
              placeholder="sam@yourbusiness.com"
              onChange={(e) => setInvitee(e.target.value)}
            />
          </Field>
          <Field label="Role">
            <Select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value)}
            >
              {roleNames.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          </Field>
          <Button
            onClick={() => invite.mutate()}
            disabled={invite.isPending || !invitee.trim()}
          >
            {invite.isPending ? "Inviting…" : "Send invitation"}
          </Button>
        </div>
        {invite.error ? <ErrorNote error={invite.error} /> : null}
        {invitations.length > 0 ? (
          <div className="mt-3">
            <p className="text-sm font-medium">Waiting to be accepted</p>
            <p className="text-xs" style={muted}>
              Only the person invited can accept — the link goes to their email.
              Until they do, you can withdraw it.
            </p>
            <ul className="mt-1 space-y-1 text-sm">
              {invitations.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-baseline justify-between gap-2 border-t pt-1"
                  style={{ borderColor: "var(--border)" }}
                >
                  <span>
                    {i.email}{" "}
                    <span className="text-xs" style={muted}>
                      as {i.role} · expires {formatDate(i.expiresAt)}
                    </span>
                  </span>
                  <button
                    type="button"
                    className="text-xs"
                    style={{ color: "var(--color-danger)" }}
                    disabled={cancelInvite.isPending}
                    onClick={() =>
                      confirm(
                        `Withdraw the invitation to ${i.email}? Their link stops working.`,
                      ) && cancelInvite.mutate(i.id)
                    }
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
            {cancelInvite.error ? (
              <ErrorNote error={cancelInvite.error} />
            ) : null}
          </div>
        ) : null}
      </Card>

      {issued ? (
        <Card>
          <p className="font-medium">New password for {issued.email}</p>
          <p className="money mt-1 text-lg tracking-wide">{issued.password}</p>
          <p className="mt-1 text-sm" style={muted}>
            Shown once and stored nowhere. Read it to them, and have them change
            it. They have been signed out everywhere.
          </p>
          <div className="mt-2">
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </Card>
      ) : null}

      {/* A name or an email. At five hundred people the list is not something
          anybody reads down. */}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={q}
          className="w-64"
          placeholder="Search people"
          aria-label="Search people"
          onChange={(e) => {
            setQ(e.target.value);
            setPage(1);
          }}
        />
        <span className="text-sm" style={muted}>
          {total} {total === 1 ? "person" : "people"}
        </span>
        {pages > 1 ? (
          <span className="ml-auto flex items-center gap-2 text-sm">
            <button
              type="button"
              className="link-muted"
              disabled={page <= 1}
              onClick={() => setPage((n) => Math.max(1, n - 1))}
            >
              Previous
            </button>
            <span style={muted}>
              {page} of {pages}
            </span>
            <button
              type="button"
              className="link-muted"
              disabled={page >= pages}
              onClick={() => setPage((n) => Math.min(pages, n + 1))}
            >
              Next
            </button>
          </span>
        ) : null}
      </div>

      <Table headers={["Name", "Email", "Role", "Two-factor", "Last seen", ""]}>
        {people.map((p) => (
          <Row key={p.userId}>
            <td className="py-2 font-medium">
              <button
                type="button"
                className="link"
                onClick={() =>
                  open({
                    moduleId: "users",
                    recordId: p.userId,
                    title: p.name || p.email,
                  })
                }
              >
                {p.name || "—"}
              </button>
              {p.you ? (
                <span className="ml-2 text-xs" style={muted}>
                  you
                </span>
              ) : null}
            </td>
            <td style={muted}>{p.email}</td>
            <td>
              {p.you ? (
                // Changing your own role is how an owner locks the business
                // out of its own instance, and nobody else can undo it.
                <span style={muted}>{p.baseRole}</span>
              ) : (
                <Select
                  value={p.baseRole}
                  onChange={(e) =>
                    setRole.mutate({ userId: p.userId, role: e.target.value })
                  }
                >
                  {[...new Set([p.baseRole, ...roleNames])].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </Select>
              )}
              {p.groups.length > 0 ? (
                // What a group grants is not editable here on purpose: it is
                // changed for the group, not for one person inside it.
                <div className="text-xs" style={muted}>
                  and, through {p.groups.join(", ")}:{" "}
                  {p.role
                    .split(",")
                    .filter((r) => r && r !== p.baseRole)
                    .join(", ") || "nothing extra"}
                </div>
              ) : null}
            </td>
            <td>
              {p.twoFactorEnabled ? (
                <button
                  type="button"
                  className="text-xs link-muted"
                  onClick={() =>
                    confirm(
                      `Turn off two-factor for ${p.email}? They will be signed out everywhere and can set it up again.`,
                    ) && revokeTwoFactor.mutate(p.userId)
                  }
                >
                  on — turn off
                </button>
              ) : p.twoFactorRequired ? (
                // The rules say somebody with their roles must have one. Said
                // here so an administrator can see who is still without it.
                <span style={{ color: "var(--color-warning)" }}>
                  off — required
                </span>
              ) : (
                <span style={muted}>off</span>
              )}
            </td>
            <td style={muted}>
              {p.lastSeenAt ? formatDate(p.lastSeenAt) : "never"}
            </td>
            <td className="space-x-3 text-right">
              <button
                type="button"
                className="text-xs link-muted"
                onClick={() =>
                  confirm(
                    `Give ${p.email} a new password? Theirs stops working immediately and they are signed out everywhere.`,
                  ) && resetPassword.mutate(p)
                }
              >
                Reset password
              </button>
              {p.you ? null : (
                <>
                  <button
                    type="button"
                    className="text-xs link-muted"
                    onClick={() => signOut.mutate(p.userId)}
                  >
                    Sign out
                  </button>
                  <button
                    type="button"
                    className="text-xs"
                    style={{ color: "var(--color-danger)" }}
                    onClick={() =>
                      confirm(
                        `Remove ${p.email}? They lose access immediately. Their invoices, notes and history stay.`,
                      ) && remove.mutate(p.userId)
                    }
                  >
                    Remove
                  </button>
                </>
              )}
            </td>
          </Row>
        ))}
      </Table>

      {(data.data?.history ?? []).length > 0 ? (
        <Card>
          <p className="font-medium">Recent changes</p>
          <p className="mt-1 text-xs" style={muted}>
            Everything on this screen hands access around, so it is written
            down. Nothing here can be edited or deleted.
          </p>
          <ul className="mt-2 space-y-1 text-sm">
            {(data.data?.history ?? []).map((change) => (
              <li key={`${change.at}-${change.says}-${change.subject ?? ""}`}>
                <span style={muted}>{formatDate(change.at)}</span>{" "}
                <strong>{change.actor}</strong> {change.says}{" "}
                <strong>{change.subject ?? "—"}</strong>
                {change.detail && "from" in change.detail ? (
                  <span style={muted}>
                    {" "}
                    ({String(change.detail.from)} → {String(change.detail.to)})
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {[setRole, remove, resetPassword, revokeTwoFactor, signOut].map((m, i) =>
        m.error ? <ErrorNote key={String(i)} error={m.error} /> : null,
      )}
    </div>
  );
}
