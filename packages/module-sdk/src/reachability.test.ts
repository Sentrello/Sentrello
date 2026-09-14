import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unreachableRoutes } from "./reachability";

const dir = mkdtempSync(join(tmpdir(), "reachability-"));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

const route = write(
  "route.ts",
  `app.get("/api/shop/orders", (c) => c.json({ orders: [], total: 0 }));`,
);

/**
 * A screen that only ever reaches a list route through `useListQuery` names
 * the resource, not the path — `useListQuery("shop/orders", state)` rather
 * than a literal `/api/shop/orders` anywhere in the file. Without reading
 * this call by name, a screen that gets its rows this way and touches the
 * endpoint no other way looks exactly like a route nobody can reach.
 */
test("useListQuery's resource counts as reaching that resource's GET route", () => {
  const screen = write(
    "orders.tsx",
    `function Orders() {
       const { rows } = listUi.useListQuery<Order>("shop/orders", state);
       return rows.length;
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [route], screenFiles: [screen] }),
  ).toEqual([]);
});

test("a route no screen names, by literal or by useListQuery, is still caught", () => {
  const screen = write(
    "unrelated.tsx",
    `function Other() {
       return api("/api/shop/products");
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [route], screenFiles: [screen] }),
  ).toEqual(["GET /api/shop/orders"]);
});
