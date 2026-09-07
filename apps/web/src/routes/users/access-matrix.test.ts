import { expect, test } from "bun:test";
import { accessRows } from "./access-matrix";
import { RESOURCES } from "./policy-ui";

/**
 * `accessRows` is the rule the Access tab lives or dies by: every resource
 * the platform knows about gets a row, whether or not anything was granted on
 * it, and a resource that was granted keeps every source of every grant. This
 * imports the real function rather than a copy — Ruling 39, and the same
 * reason `tabs.test.ts` imports `activeTab` instead of restating it.
 */

test("every known resource gets a row, even with no grants at all", () => {
  const rows = accessRows([]);
  expect(rows.length).toBe(RESOURCES.length);
  for (const row of rows) {
    expect(row.granted).toEqual([]);
  }
});

test("a granted action lands on its own resource's row, not every row", () => {
  const [first, second] = RESOURCES;
  if (!first || !second) throw new Error("test needs at least two resources");
  const grants = [
    {
      resource: first.name,
      action: first.actions[0] ?? "read",
      sources: [{ kind: "policy" as const, name: "manager" }],
    },
  ];
  const rows = accessRows(grants);
  const grantedResource = rows.find((r) => r.resource === first.name);
  const otherResource = rows.find((r) => r.resource === second.name);
  expect(grantedResource?.granted).toEqual([
    {
      action: first.actions[0] ?? "read",
      sources: [{ kind: "policy", name: "manager" }],
    },
  ]);
  expect(otherResource?.granted).toEqual([]);
});

test("a grant reachable two ways keeps both sources", () => {
  const [first] = RESOURCES;
  if (!first) throw new Error("test needs at least one resource");
  const action = first.actions[0] ?? "read";
  const grants = [
    {
      resource: first.name,
      action,
      sources: [
        { kind: "policy" as const, name: "manager" },
        { kind: "group" as const, name: "Accounting" },
      ],
    },
  ];
  const row = accessRows(grants).find((r) => r.resource === first.name);
  expect(row?.granted).toEqual([
    {
      action,
      sources: [
        { kind: "policy", name: "manager" },
        { kind: "group", name: "Accounting" },
      ],
    },
  ]);
});
