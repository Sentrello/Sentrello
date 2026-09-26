import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { roleApi } from "../../lib/auth";
import { useNavigation } from "../../lib/navigation";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  Page,
  SectionHeading,
  muted,
} from "../../lib/ui";
import { Matrix, Policies as PolicyTable, policyLabel } from "./policy-ui";

/**
 * The policies a business has written — who is senior, and which department
 * something belongs to.
 *
 * Lifted from `Users()` in `users.tsx`: the three tables (`PolicyTable`,
 * exported from there) are unchanged, and so is creating one. What moves is
 * editing an existing policy's permissions — the checkbox grid that used to
 * open inline on this same page now opens the policy's own record
 * (`policy.tsx`), where "who does this affect" (Members, Groups) sits beside
 * the editor instead of nowhere. `onOpen`, passed to every table below,
 * reaches every row including the two built-in ones — `PolicyTable`'s own
 * `onEdit` never fires for those, and until now there was no other way to
 * see who holds Admin.
 */
export function Policies() {
  const qc = useQueryClient();
  const { open } = useNavigation();
  const [name, setName] = useState("");
  const [permission, setPermission] = useState<Record<string, string[]>>({
    // Every policy needs the landing page, or its holder signs in to nothing.
    dashboard: ["read"],
  });
  const [creating, setCreating] = useState(false);

  const reset = () => {
    setName("");
    setPermission({ dashboard: ["read"] });
    setCreating(false);
  };

  const create = useMutation({
    mutationFn: async () => {
      const res = await roleApi.createRole({ role: name.trim(), permission });
      if (res.error) throw new Error(res.error.message ?? "Could not create");
    },
    onSuccess: () => {
      reset();
      qc.invalidateQueries({ queryKey: ["users-policies"] });
    },
  });

  const remove = useMutation({
    mutationFn: async (roleName: string) => {
      const res = await roleApi.deleteRole({ roleName });
      if (res.error) throw new Error(res.error.message ?? "Could not delete");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users-policies"] }),
  });

  const openPolicy = (role: string) =>
    open({
      moduleId: "user-policies",
      recordId: role,
      title: policyLabel(role),
    });

  const startCopy = (role: string, allows: Record<string, string[]>) => {
    setName(`${role} (copy)`);
    setPermission(allows);
    setCreating(true);
  };

  return (
    <Page>
      <PolicyTable
        title="User policies"
        blurb="How senior somebody is. Given to a person directly."
        kind="user"
        onOpen={openPolicy}
        onCopy={startCopy}
        onEdit={openPolicy}
        onDelete={(role) => remove.mutate(role)}
      />

      <PolicyTable
        title="Group policies"
        blurb="What department somebody is in. Carried by a group."
        kind="group"
        onOpen={openPolicy}
        onCopy={startCopy}
        onEdit={openPolicy}
        onDelete={(role) => remove.mutate(role)}
      />

      <SectionHeading
        trailing={
          <Button onClick={() => (creating ? reset() : setCreating(true))}>
            {creating ? "Cancel" : "New policy"}
          </Button>
        }
      >
        Policies you wrote
      </SectionHeading>

      {creating ? (
        <Card className="flex flex-col gap-(--gap-toolbar)">
          <Field label="Name" hint="What this job is called in your business.">
            <Input
              value={name}
              placeholder="Workshop manager"
              onChange={(e) => setName(e.target.value)}
            />
          </Field>

          <div>
            <SectionHeading level={3}>What they may do</SectionHeading>
            <p className="text-xs" style={muted}>
              {/* Better Auth enforces this; saying it up front beats a refusal
                  somebody has to interpret. */}
              You can only grant what you hold yourself.
            </p>
          </div>
          <Matrix value={permission} onChange={setPermission} />

          <div>
            {/*
              Better Auth's own role API rather than a Hono route, so no
              `requirePermission` stands behind it for the resolver to read —
              it is enforced there instead. The screen still has to say so:
              the rest of this console asks `settings: ["update"]`, and
              creating a policy is the most consequential write on it.
            */}
            <Button
              needs={{ settings: ["update"] }}
              onClick={() => create.mutate()}
              disabled={!name.trim() || create.isPending}
            >
              {create.isPending ? "Creating…" : "Create policy"}
            </Button>
          </div>
          {create.error ? <ErrorNote error={create.error} /> : null}
        </Card>
      ) : null}

      <PolicyTable
        title=""
        blurb="Anything you have written yourself."
        kind="custom"
        onOpen={openPolicy}
        onCopy={startCopy}
        onEdit={openPolicy}
        onDelete={(role) => remove.mutate(role)}
      />

      {remove.error ? <ErrorNote error={remove.error} /> : null}
    </Page>
  );
}
