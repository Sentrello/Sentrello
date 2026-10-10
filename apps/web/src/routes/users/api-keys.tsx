import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, may } from "../../lib/api";
import {
  Button,
  Card,
  ConfirmButton,
  Empty,
  ErrorNote,
  Field,
  Input,
  Loading,
  Page,
  Row,
  SectionHeading,
  Table,
  formatDate,
  muted,
} from "../../lib/ui";
import { Matrix } from "./policy-ui";

/**
 * Keys for scripts: make one, see which exist, take one back.
 *
 * The permission grid is the one the policy screens use, so a key is described
 * in the same words as a person's access. It offers everything; the server
 * refuses what the person making the key does not hold themselves, and says
 * which permission it was, because a key wider than its maker is the one
 * thing this screen must never produce.
 */

interface KeyRow {
  id: string;
  name: string;
  prefix: string;
  permissions: Record<string, string[]>;
  createdByName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresOn: string | null;
  expired: boolean;
}

const describe = (permissions: Record<string, string[]>) =>
  Object.entries(permissions)
    .map(([resource, actions]) => `${resource}: ${actions.join(", ")}`)
    .join("; ");

export function ApiKeys() {
  const qc = useQueryClient();
  const queryKey = ["user-api-keys"];
  const [name, setName] = useState("");
  const [expiresOn, setExpiresOn] = useState("");
  const [permissions, setPermissions] = useState<Record<string, string[]>>({});
  const [made, setMade] = useState<{ name: string; key: string } | null>(null);

  const { data, isLoading, error } = useQuery({
    queryKey,
    queryFn: () => api<{ keys: KeyRow[] }>("/api/users/api-keys"),
  });
  const refresh = () => qc.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: () =>
      api<{ key: string }>("/api/users/api-keys", {
        method: "POST",
        body: JSON.stringify({
          name,
          permissions,
          expiresOn: expiresOn || null,
        }),
      }),
    onSuccess: (result) => {
      setMade({ name, key: result.key });
      setName("");
      setExpiresOn("");
      setPermissions({});
      refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api(`/api/users/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: refresh,
  });

  if (isLoading) return <Loading />;
  if (error) return <ErrorNote error={error} />;
  const keys = data?.keys ?? [];
  const nothingTicked = Object.keys(permissions).length === 0;

  return (
    <Page>
      {made ? (
        <Card>
          <SectionHeading>Copy the key for {made.name} now</SectionHeading>
          <p className="mb-(--gap-toolbar) text-sm" style={muted}>
            This is the only time it is shown. We keep a fingerprint of it, not
            the key, so if it is lost the answer is a new one.
          </p>
          <code className="block break-all text-sm">{made.key}</code>
          <p className="mt-(--gap-toolbar) text-sm" style={muted}>
            Send it as <code>Authorization: Bearer</code> followed by the key.
          </p>
          <Button
            variant="secondary"
            className="mt-(--gap-toolbar)"
            onClick={() => setMade(null)}
          >
            Done
          </Button>
        </Card>
      ) : null}

      <Card>
        <SectionHeading>New key</SectionHeading>
        <p className="mb-(--gap-toolbar) text-sm" style={muted}>
          For a script that calls the API on its own, like a meter posting usage
          overnight. Tick only what it needs: a key can never do more than you
          can, and it stops working when you lose the access it was made with.
        </p>
        <div className="flex flex-col gap-(--gap-toolbar)">
          <Field label="Name">
            <Input
              value={name}
              placeholder="Nightly meter"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>
          <Field
            label="Works until"
            hint="Leave empty for a key that works until you revoke it."
          >
            <Input
              type="date"
              className="w-auto"
              value={expiresOn}
              onChange={(e) => setExpiresOn(e.target.value)}
            />
          </Field>
          <Matrix value={permissions} onChange={setPermissions} within={may} />
          <div>
            <Button
              needs={{ settings: ["update"] }}
              onClick={() => create.mutate()}
              disabled={create.isPending || !name.trim() || nothingTicked}
            >
              Make the key
            </Button>
          </div>
        </div>
        {create.error ? <ErrorNote error={create.error} /> : null}
      </Card>

      {keys.length === 0 ? (
        <Empty title="No API keys yet">
          Nothing calls the API except the people signed in to it.
        </Empty>
      ) : (
        <Table
          headers={[
            "Name",
            "Key",
            "Can",
            "Made by",
            "Last used",
            "Works until",
            "",
          ]}
        >
          {keys.map((k) => (
            <Row key={k.id}>
              <td className="py-2 font-medium">{k.name}</td>
              <td style={muted}>
                <code>{k.prefix}…</code>
              </td>
              <td style={muted}>{describe(k.permissions)}</td>
              <td style={muted}>{k.createdByName || "—"}</td>
              <td style={muted}>
                {k.lastUsedAt ? formatDate(k.lastUsedAt) : "never"}
              </td>
              <td style={muted}>
                {k.expiresOn ? formatDate(k.expiresOn) : "until revoked"}
                {k.expired ? " (expired)" : ""}
              </td>
              <td className="text-right">
                <ConfirmButton
                  label={`Revoke the ${k.name} key`}
                  title="Revoke this key?"
                  message={`Anything still using ${k.name} is refused from now on. This cannot be undone; make a new key if it is still needed.`}
                  confirmLabel="Revoke it"
                  danger
                  className="text-xs"
                  needs={{ settings: ["update"] }}
                  disabled={revoke.isPending}
                  onConfirm={() => revoke.mutate(k.id)}
                >
                  Revoke
                </ConfirmButton>
              </td>
            </Row>
          ))}
        </Table>
      )}
      {revoke.error ? <ErrorNote error={revoke.error} /> : null}
    </Page>
  );
}
