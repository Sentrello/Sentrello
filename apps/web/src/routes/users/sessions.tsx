import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import {
  Empty,
  ErrorNote,
  Loading,
  Row,
  Table,
  formatDate,
  muted,
} from "../../lib/ui";

/**
 * Every live session across the organization, with who each belongs to.
 *
 * `person.tsx`'s own Sessions tab already does this for one person at a
 * time; this is the aggregate an administrator wants when a foreman has
 * been dismissed and every device of theirs has to go, or when checking who
 * is signed in at all — `GET /api/users/sessions`, which already carries
 * whose session each row is.
 */

interface SessionRow {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  device: string;
  ipAddress: string | null;
  createdAt: string;
  expiresAt: string;
  updatedAt: string;
  current: boolean;
}

export function Sessions() {
  const qc = useQueryClient();
  const key = ["users-sessions"];

  const { data, isLoading, error } = useQuery({
    queryKey: key,
    queryFn: () => api<{ sessions: SessionRow[] }>("/api/users/sessions"),
  });

  const settle = () => qc.invalidateQueries({ queryKey: key });

  const revokeOne = useMutation({
    mutationFn: (s: SessionRow) =>
      api(`/api/users/${s.userId}/sessions/${s.id}`, { method: "DELETE" }),
    onSuccess: settle,
  });

  // No bulk route exists for this — `POST /api/users/:userId/sessions/revoke`
  // is per person. Ending every live session is that route's DELETE sibling
  // called once per row rather than a new server endpoint for a button this
  // screen alone needs.
  const revokeAll = useMutation({
    mutationFn: async () => {
      const rows = data?.sessions ?? [];
      await Promise.all(
        rows.map((s) =>
          api(`/api/users/${s.userId}/sessions/${s.id}`, { method: "DELETE" }),
        ),
      );
    },
    onSuccess: settle,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm" style={muted}>
          {sessions.length} live{" "}
          {sessions.length === 1 ? "session" : "sessions"}
        </span>
        {sessions.length > 0 ? (
          <button
            type="button"
            className="text-xs"
            style={{ color: "var(--color-danger)" }}
            disabled={revokeAll.isPending}
            onClick={() =>
              confirm(
                `Sign everybody out? ${sessions.length} ${
                  sessions.length === 1 ? "session ends" : "sessions end"
                } immediately, including yours if you are signed in on this list.`,
              ) && revokeAll.mutate()
            }
          >
            Sign everybody out
          </button>
        ) : null}
      </div>

      {sessions.length === 0 ? (
        <Empty title="Nobody is signed in" />
      ) : (
        <Table headers={["Person", "Device", "IP", "Last active", ""]}>
          {sessions.map((s) => (
            <Row key={s.id}>
              <td className="py-2 font-medium">
                {s.name || s.email || "—"}
                {s.current ? (
                  <span className="ml-2 text-xs" style={muted}>
                    this device
                  </span>
                ) : null}
              </td>
              <td style={muted}>{s.device}</td>
              {/* `||`, not `??` — Better Auth writes an empty string, not
                  null, when nothing set the trusted header, and `??` never
                  catches that: it drew a blank cell instead of "—". */}
              <td style={muted}>{s.ipAddress || "—"}</td>
              <td style={muted}>{formatDate(s.updatedAt)}</td>
              <td className="text-right">
                <button
                  type="button"
                  className="text-xs link-muted"
                  disabled={revokeOne.isPending}
                  onClick={() => revokeOne.mutate(s)}
                >
                  Sign out
                </button>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {revokeOne.error ? <ErrorNote error={revokeOne.error} /> : null}
      {revokeAll.error ? <ErrorNote error={revokeAll.error} /> : null}
    </div>
  );
}
