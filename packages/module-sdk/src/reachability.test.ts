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

/**
 * `useListQuery(\`${resource}\`, state)` is a template literal, not a
 * resource name — its shape reduces to `["api", "*"]`, the same shape the
 * literal-path reading turns away rather than let it stand for every
 * two-segment GET route in the codebase (one segment after `/api`, such as
 * `/api/products` here). Nothing writes it this way today; the guard is what
 * keeps it that way.
 */
test("a template-literal resource does not excuse an unrelated two-segment route", () => {
  const shortRoute = write(
    "short-route.ts",
    `app.get("/api/products", (c) => c.json({ products: [] }));`,
  );
  const screen = write(
    "generic-list.tsx",
    `function GenericList({ resource, state }) {
       const { rows } = listUi.useListQuery(\`\${resource}\`, state);
       return rows.length;
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [shortRoute], screenFiles: [screen] }),
  ).toEqual(["GET /api/products"]);
});
