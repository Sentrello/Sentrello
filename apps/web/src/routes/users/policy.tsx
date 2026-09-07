import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { roleApi } from "../../lib/auth";
import { useNavigation, useRecordTitle } from "../../lib/navigation";
import {
  Button,
  Card,
  Empty,
  ErrorNote,
  Loading,
  Tabs,
  activeTab,
  muted,
} from "../../lib/ui";
import { tabFromSearch } from "./person";
import { Matrix, policyLabel } from "./policy-ui";

/**
 * One policy: what it grants, who holds it directly, and which groups carry
 * it.
 *
 * The design's three tabs (`docs/plan/Users-IAM-Console-Design.md:147`) —
 * Permissions, Members, Groups — answer the question the old screen never
 * could: "if I change this policy, who does it affect?" `Matrix`, lifted
 * from `users.tsx`, is the same editor that used to open inline on the list;
 * it stays read-only here for the two policies Better Auth compiles in,
 * mirroring the guard that already hides the list's own Edit button for
 * them (`users.tsx`'s `Policies`).
 */

const TABS = [
  { id: "permissions", label: "Permissions" },
  { id: "members", label: "Members" },
  { id: "groups", label: "Groups" },
];

interface RoleDetail {
  role: string;
  permission: Record<string, string[]>;
  members: { userId: string; name: string; email: string }[];
  groups: { id: string; name: string }[];
}

interface PolicyRow {
  role: string;
  builtIn: boolean;
  kind: "user" | "group" | "custom";
  allows: Record<string, string[]>;
}

export function PolicyDetail() {
  const { current } = useNavigation();
  const role = current.recordId;
  const [tabId, setTabId] = useState(() =>
    tabFromSearch(window.location.search),
  );

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["user-policy", role],
    queryFn: () => api<RoleDetail>(`/api/users/roles/${role}`),
    enabled: Boolean(role),
  });

  // The same list `policies.tsx` already caches, read again here rather than
  // adding a `builtIn` field to `GET /api/users/roles/:role` just for one
  // flag the list already carries.
  const list = useQuery({
    queryKey: ["users-policies"],
    queryFn: () => api<{ roles: PolicyRow[] }>("/api/users/roles"),
  });
  const builtIn =
    list.data?.roles.find((r) => r.role === role)?.builtIn ?? false;

  useRecordTitle(role ? policyLabel(role) : undefined);

  if (!role) return <Empty title="No policy selected" />;
  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;

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
      {shown?.id === "permissions" ? (
        <Permissions
          role={role}
          permission={data.permission}
          builtIn={builtIn}
          onSaved={refetch}
        />
      ) : null}
      {shown?.id === "members" ? <Members members={data.members} /> : null}
      {shown?.id === "groups" ? <CarriedBy groups={data.groups} /> : null}
    </div>
  );
}

/** The permission matrix, editable unless Better Auth compiled this one in. */
function Permissions({
  role,
  permission,
  builtIn,
  onSaved,
}: {
  role: string;
  permission: Record<string, string[]>;
  builtIn: boolean;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState(permission);
  // `refetch` hands back a new object without remounting this component, so
  // a save that changes what the server actually stored — or opening a
  // different policy, since the query key includes `role` but this
  // component does not unmount between them — needs this to pick it up.
  useEffect(() => setValue(permission), [permission]);

  const save = useMutation({
    mutationFn: async () => {
      const res = await roleApi.updateRole({
        roleName: role,
        data: { permission: value },
      });
      if (res.error) throw new Error(res.error.message ?? "Could not save");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["users-policies"] });
      onSaved();
    },
  });

  if (builtIn) {
    return (
      <Card>
        <p className="text-sm" style={muted}>
          {policyLabel(role)} comes with Sentrello and cannot be changed here.
          Copy it from the policies list and edit the copy instead.
        </p>
        {/* No `onChange` reaches state, so a click reverts on React's own
            next render — a read-only controlled grid without teaching the
            shared editor a `disabled` prop one caller needs. */}
        <div className="mt-3">
          <Matrix value={permission} onChange={() => {}} />
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <p className="mb-1 font-medium text-sm">
        What {policyLabel(role)} may do
      </p>
      <p className="mb-2 text-xs" style={muted}>
        You can only grant what you hold yourself. Everybody who holds this,
        directly or through a group, is affected as soon as you save.
      </p>
      <Matrix value={value} onChange={setValue} />
      <div className="mt-3">
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save changes"}
        </Button>
      </div>
      {save.error ? <ErrorNote error={save.error} /> : null}
    </Card>
  );
}

/**
 * Everybody who holds this policy directly — not through a group.
 *
 * Exported and render-tested (`policy.render.test.tsx`) on its own: a policy
 * nobody holds directly is the ordinary state for most of a business's own
 * policies, and it is a real state to get wrong — an empty panel reads as a
 * broken screen where "nobody yet, but a group might still carry it" is the
 * true, useful answer.
 */
export function Members({
  members,
}: {
  members: { userId: string; name: string; email: string }[];
}) {
  if (members.length === 0) {
    return (
      <Empty title="Nobody holds this directly">
        Somebody can still hold it through a group — see the Groups tab.
      </Empty>
    );
  }
  return (
    <Card>
      <ul className="space-y-1 text-sm">
        {members.map((m) => (
          <li key={m.userId}>{m.name || m.email}</li>
        ))}
      </ul>
    </Card>
  );
}

/** Every group that carries this policy to its members. Also render-tested. */
export function CarriedBy({
  groups,
}: {
  groups: { id: string; name: string }[];
}) {
  if (groups.length === 0) {
    return <Empty title="No group carries this" />;
  }
  return (
    <Card>
      <ul className="space-y-1 text-sm">
        {groups.map((g) => (
          <li key={g.id}>{g.name}</li>
        ))}
      </ul>
    </Card>
  );
}
