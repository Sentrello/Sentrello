import { statement } from "@sentrello/auth/permissions";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "../../lib/api";
import {
  Button,
  Card,
  ErrorNote,
  Field,
  Input,
  MenuItem,
  Row,
  RowMenu,
  SectionHeading,
  Table,
  muted,
} from "../../lib/ui";

/** One policy, as `GET /api/users/roles` describes it. */
export interface Policy {
  role: string;
  builtIn: boolean;
  kind: "user" | "group" | "custom";
  allows: Record<string, string[]>;
}

/**
 * The pieces every policy screen draws with.
 *
 * These lived in `routes/users.tsx` — the single screen this console replaced
 * — and outlived it: the policy list, the permission grid, the resource list
 * both of those and the resolved Access view agree on, and the one function
 * that turns a stored role key into a heading. Deleting that screen moved
 * these here rather than copying them into each of the three screens
 * that want them, which is what the comments below were already warning
 * against when they lived one directory up.
 */

/**
 * Better Auth's own resources. A business manages people, not invitations.
 *
 * Exported for `users/access-matrix.tsx`, which needs the same list to show a
 * resource nobody has been granted rather than silently leaving it out — a
 * second copy of this filter is a second place it could disagree with this
 * one about which resources a business actually manages.
 */
export const HIDDEN = new Set([
  "organization",
  "member",
  "invitation",
  "ac",
  "team",
]);

export const RESOURCES = Object.entries(statement)
  .filter(([name]) => !HIDDEN.has(name))
  .map(([name, actions]) => ({
    name,
    actions: [...(actions as readonly string[])],
  }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The permission editor: one checkbox grid a form uses to write a policy's
 * permissions.
 *
 * Exported for `users/policy.tsx`, which needs the exact same editor for an
 * existing policy's Permissions tab — a second grid built the same way would
 * be a second place it could drift from what this one lets somebody grant.
 */
export function Matrix({
  value,
  onChange,
}: {
  value: Record<string, string[]>;
  onChange: (next: Record<string, string[]>) => void;
}) {
  const toggle = (resource: string, action: string, on: boolean) => {
    const current = new Set(value[resource] ?? []);
    if (on) current.add(action);
    else current.delete(action);
    const next = { ...value };
    if (current.size) next[resource] = [...current];
    else delete next[resource];
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-(--gap-tight)">
      {RESOURCES.map((r) => (
        <div
          key={r.name}
          className="flex flex-wrap items-center gap-(--gap-toolbar)"
        >
          <span className="w-32 shrink-0 text-sm">{r.name}</span>
          {r.actions.map((a) => (
            <label
              key={a}
              className="flex items-center gap-(--gap-tight) text-xs"
            >
              <input
                type="checkbox"
                checked={(value[r.name] ?? []).includes(a)}
                onChange={(e) => toggle(r.name, a, e.target.checked)}
              />
              {a}
            </label>
          ))}
        </div>
      ))}
    </div>
  );
}

interface Group {
  id: string;
  name: string;
  description: string | null;
  roles: string[];
  members: { userId: string; name: string; email: string }[];
}

interface Device {
  id: string;
  device: string;
  ipAddress: string | null;
  updatedAt: string;
  current: boolean;
}

/**
 * "customer service" is what is stored; "Customer Service" is what is read.
 *
 * Exported for `users/group.tsx` and `users/policy.tsx`, which name a role
 * the same way this screen does and would otherwise carry a second copy of
 * the same one-line rule.
 */
export function policyLabel(name: string): string {
  return name.replace(/\b[a-z]/g, (ch) => ch.toUpperCase());
}

/**
 * One set of policies, and what each of them actually allows.
 *
 * Read from the roles themselves. A second copy written into this screen is a
 * screen that tells an administrator something the permission checks disagree
 * with, and they would believe the screen.
 *
 * The three Sentrello ships cannot be deleted — Better Auth reserves their
 * names — so they offer Copy instead: a business that wants a Staff who may
 * also send invoices takes a copy, changes it, and assigns that.
 *
 * Exported for `users/policies.tsx`, which lists the same three sets of
 * policies and needs the same table rather than a second one that could draw
 * them differently.
 */
export function Policies({
  title,
  blurb,
  kind,
  onCopy,
  onEdit,
  onDelete,
  onOpen,
}: {
  title: string;
  blurb: string;
  kind: "user" | "group" | "custom";
  onCopy: (role: string, permission: Record<string, string[]>) => void;
  onEdit: (role: string, permission: Record<string, string[]>) => void;
  onDelete: (role: string) => void;
  /**
   * Names the policy as a link to its own record instead of plain text.
   *
   * Optional, and off by default, so the inline editor this file still uses
   * is unaffected. `users/policies.tsx` passes it so every row — including
   * the two built-in ones, which `onEdit` never reaches below — opens
   * somewhere: `policy.tsx` is the only place "who holds Admin" can be
   * answered.
   */
  onOpen?: (role: string) => void;
}) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["users-policies"],
    queryFn: () => api<{ roles: Policy[] }>("/api/users/roles"),
  });

  if (isLoading) return null;
  /*
   * A card, rather than the nothing this drew before.
   *
   * Both empty branches below return null, so a failed fetch removed the
   * whole section from the screen — the policies a business runs on, gone,
   * with the page around them looking finished. Somebody would reasonably
   * conclude their custom policies had been deleted.
   */
  if (error) {
    return (
      <Card>
        <ErrorNote error={error} />
      </Card>
    );
  }
  const rows = (data?.roles ?? []).filter((r) => r.kind === kind);
  if (rows.length === 0 && kind === "custom") {
    return (
      <Card>
        <p className="text-sm" style={muted}>
          Nothing of your own yet. The defaults cover most businesses; write one
          when they do not, or copy a default and change it.
        </p>
      </Card>
    );
  }
  if (rows.length === 0) return null;

  return (
    <Card>
      {title ? <SectionHeading>{title}</SectionHeading> : null}
      <p className="mb-(--gap-toolbar) text-sm" style={muted}>
        {blurb}
      </p>
      <Table headers={["Policy", "May do", ""]}>
        {rows.map((policy) => (
          <Row key={policy.role}>
            {/*
              The name does not wrap. This column is sized by what is left
              after the permissions beside it, which is nearly nothing, so
              "Customer Service" came out on two lines while every other row
              was on one. The table already scrolls inside its own box if a
              name is ever long enough to need it.
            */}
            <td className="whitespace-nowrap py-2 font-medium">
              {onOpen ? (
                <button
                  type="button"
                  className="link"
                  onClick={() => onOpen(policy.role)}
                >
                  {policyLabel(policy.role)}
                </button>
              ) : (
                policyLabel(policy.role)
              )}
              {policy.builtIn ? (
                <span className="ml-2 text-xs" style={muted}>
                  comes with Sentrello
                </span>
              ) : null}
            </td>
            <td style={muted}>
              {Object.entries(policy.allows)
                .filter(([, actions]) => actions.length > 0)
                .map(([res, actions]) => `${res} (${actions.join(", ")})`)
                .join(" · ") || "nothing"}
            </td>
            {/*
              Behind one menu, like every other row in the product. Written
              into the row, the three of them put "Delete" in the danger
              colour on every line of the list that decides who may do what —
              and squeezed the policy column hard enough to break "Customer
              Service" in half.
            */}
            <td className="text-right">
              <RowMenu label={policy.role}>
                {(close) => (
                  <>
                    {/*
                      Edit changes what everybody holding this policy may do,
                      so it is offered only where it is real: the two compiled
                      roles cannot be changed, and pretending otherwise would
                      be a button that fails when pressed.
                    */}
                    {policy.builtIn ? null : (
                      <MenuItem
                        needs={{ settings: ["update"] }}
                        onClick={() => {
                          close();
                          onEdit(policy.role, policy.allows);
                        }}
                      >
                        Edit
                      </MenuItem>
                    )}
                    <MenuItem
                      needs={{ settings: ["update"] }}
                      onClick={() => {
                        close();
                        onCopy(policy.role, policy.allows);
                      }}
                    >
                      Copy
                    </MenuItem>
                    {policy.builtIn ? null : (
                      <MenuItem
                        needs={{ settings: ["update"] }}
                        style={{ color: "var(--text-danger)" }}
                        onClick={() => {
                          close();
                          onDelete(policy.role);
                        }}
                      >
                        Delete
                      </MenuItem>
                    )}
                  </>
                )}
              </RowMenu>
            </td>
          </Row>
        ))}
      </Table>
    </Card>
  );
}
