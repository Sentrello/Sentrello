import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import { useNavigation } from "../../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Row,
  Table,
  muted,
} from "../../lib/ui";
import { policyLabel } from "./policy-ui";

/**
 * The groups a business has set up — departments and teams — each one
 * opening onto its own record.
 *
 * Lifted from `Groups` in `user-groups.tsx`, which drew every group's
 * members and carried policies in a row that expanded in place on this same
 * page. That UI moves to `group.tsx`'s Members and Access tabs — the same
 * split Task 11 made between `people.tsx` and `person.tsx`. What stays here
 * is the list, creating a new one, and deleting one: `group.tsx` has no
 * Details tab to put deletion on, so it stays where `policies.tsx` keeps it
 * for a policy — on the row.
 */

export interface GroupRow {
  id: string;
  name: string;
  description: string | null;
  roles: string[];
  members: { userId: string; name: string; email: string }[];
}

export function Groups() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [name, setName] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["user-groups"],
    queryFn: () => api<{ groups: GroupRow[] }>("/api/users/groups"),
  });

  const refresh = () => qc.invalidateQueries({ queryKey: ["user-groups"] });

  const create = useMutation({
    mutationFn: () =>
      api("/api/users/groups", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setName("");
      refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/groups/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const groups = data?.groups ?? [];

  return (
    <div className="space-y-4">
      <Card>
        <p className="mb-1 font-medium">New group</p>
        <p className="mb-2 text-sm" style={muted}>
          A group is a set of people who share a job. It carries policies, and
          everybody in it holds those as well as their own.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Name">
            <Input
              value={name}
              placeholder="The office"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) create.mutate();
              }}
            />
          </Field>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim()}
          >
            Create
          </Button>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {groups.length === 0 ? (
        <Empty title="No groups yet">
          Until there are groups, everybody's permissions come from their own
          policy alone — which is fine for three people and tiring for twelve.
        </Empty>
      ) : (
        <Table headers={["Name", "Description", "Members", "Carries", ""]}>
          {groups.map((g) => (
            <Row key={g.id}>
              <td className="py-2 font-medium">
                <button
                  type="button"
                  className="link"
                  onClick={() =>
                    open({
                      moduleId: "user-groups",
                      recordId: g.id,
                      title: g.name,
                    })
                  }
                >
                  {g.name}
                </button>
              </td>
              <td style={muted}>{g.description || "—"}</td>
              <td style={muted}>
                {g.members.length}{" "}
                {g.members.length === 1 ? "person" : "people"}
              </td>
              <td style={muted}>
                {g.roles.map(policyLabel).join(", ") || "nothing"}
              </td>
              <td className="text-right">
                <button
                  type="button"
                  className="text-xs"
                  style={{ color: "var(--color-danger)" }}
                  disabled={remove.isPending}
                  onClick={() =>
                    confirm(
                      `Delete ${g.name}? Everybody in it keeps their own policy and loses this group's.`,
                    ) && remove.mutate(g.id)
                  }
                >
                  Delete
                </button>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </div>
  );
}
