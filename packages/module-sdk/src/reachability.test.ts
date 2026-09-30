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

/**
 * The defect this matching was rewritten for.
 *
 * `\`/api/${holder}/${id}/receipt\`` on one screen reduces to
 * `api/*​/*​/receipt`, and a route whose own tail is parameters — an OAuth
 * callback in another module, `/api/payments/:provider/:mode` — reduces to
 * `api/payments/*​/*`. Wildcards matched wildcards on both sides, so the two
 * met at every segment and the sweep called the callback reached. Nothing
 * about the two paths agrees: not the resource, not the action. The sweep did
 * not report a problem somebody then ignored — **it reported success.**
 */
test("a screen's variable prefix does not excuse an unrelated route of the same length", () => {
  const callback = write(
    "callback-route.ts",
    `app.get("/api/payments/:provider/:mode", (c) => c.json({ ok: true }));`,
  );
  const screen = write(
    "receipt.tsx",
    `function Receipt({ holder, id }) {
       return api(\`/api/\${holder}/\${id}/receipt\`);
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [callback], screenFiles: [screen] }),
  ).toEqual(["GET /api/payments/:provider/:mode"]);
});

/**
 * The defect this was extended for, and the reason the rule is about the route
 * set rather than about the ask.
 *
 * Every project page fetches `` `/api/projects/${id}` ``, which reduces to
 * `api/projects/*`. `GET /api/projects/time` — a time-and-cost report filtered
 * by person, date and billed state — reduces to `api/projects/time`, and the
 * two met because a wildcard was allowed to stand for the literal `time`. The
 * report had no caller in any screen in any repository and the sweep passed it,
 * so the guard's own green was the evidence that the feature existed.
 *
 * What tells it apart from the legitimate case below is `:id` sitting at the
 * same position on the same verb: where a sibling route takes a parameter
 * there, a `${…}` written there is that parameter, and the named route has to
 * earn a caller that says its name.
 */
test("a parameter does not stand for a sibling route's name", () => {
  const routes = write(
    "projects-route.ts",
    `app.get("/api/projects/:id", (c) => c.json({ project: {} }));
     app.get("/api/projects/time", (c) => c.json({ entries: [], totals: {} }));`,
  );
  const screen = write(
    "project-page.tsx",
    `function ProjectPage({ id }) {
       return api(\`/api/projects/\${id}\`);
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [routes], screenFiles: [screen] }),
  ).toEqual(["GET /api/projects/time"]);
});

/**
 * And the case that must keep passing, because it is how one screen reaches
 * five routes: `` `/api/invoices/${id}/${action}` `` with `action` holding
 * `send`, `void` or `credit`. No route takes a parameter at that last
 * position, so every route in the family is named and the variable can only be
 * standing for one of those names.
 *
 * Refusing this too was tried first, and it failed seven live invoice buttons,
 * three POS ticket actions and four newsletter maintenance jobs. A guard that
 * reports working buttons as broken is a guard somebody switches off, which is
 * the same hole wearing a different hat.
 */
test("a parameter still stands for a family of names nothing parameterises", () => {
  const routes = write(
    "invoice-actions.ts",
    `app.post("/api/invoices/:id/send", (c) => c.json({ ok: true }));
     app.post("/api/invoices/:id/void", (c) => c.json({ ok: true }));`,
  );
  const screen = write(
    "invoice-detail.tsx",
    `function InvoiceDetail({ id }) {
       const act = (action) =>
         api(\`/api/invoices/\${id}/\${action}\`, { method: "POST" });
       return act;
     }`,
  );

  expect(
    unreachableRoutes({ routeFiles: [routes], screenFiles: [screen] }),
  ).toEqual([]);
});
