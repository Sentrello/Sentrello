import { expect, test } from "bun:test";
import { hoistOrphans } from "./nav-orphans";

test("a page whose heading is hidden stands on its own, and nothing else moves", () => {
  const out = hoistOrphans([
    { id: "pos", parent: "shop", moduleId: "pos" },
    { id: "pos-room", parent: "shop", moduleId: "pos" },
    { id: "crm", moduleId: "crm" },
    { id: "contacts", parent: "crm", moduleId: "crm" },
  ]);
  expect(out.map((n) => [n.id, n.parent ?? null])).toEqual([
    ["pos", null],
    ["pos-room", null],
    ["crm", null],
    ["contacts", "crm"],
  ]);
});
