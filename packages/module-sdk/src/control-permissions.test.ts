import { expect, test } from "bun:test";
import {
  controlsFiringMutations,
  guardedRoutes,
  needsFor,
  normalisePath,
} from "./control-permissions";

/**
 * The two traps, which are the only reason this file is not three lines.
 *
 * Both were got wrong three times — by hand and then by a script written to
 * stop getting them wrong by hand. Both produce a plausible answer, which is
 * what let them through: a permission that is wrong but believable either
 * disables a control for somebody entitled to it, or leaves one open.
 */

test("a repeated mutation name resolves to the declaration in scope", () => {
  const source = [
    "function Ledger() {",
    "  const save = useMutation({",
    '    mutationFn: () => api("/api/accounts", { method: "POST" }),',
    "  });",
    "  return <Button onClick={() => save.mutate()}>Add an account</Button>;",
    "}",
    "function Taxes() {",
    "  const save = useMutation({",
    '    mutationFn: () => api("/api/invoicing/taxes", { method: "POST" }),',
    "  });",
    "  return <Button onClick={() => save.mutate()}>Add a rate</Button>;",
    "}",
  ].join("\n");

  const found = controlsFiringMutations(source);
  expect(found).toHaveLength(2);
  // The first control belongs to the first declaration, not the last parsed.
  expect(found[0]?.path).toBe("/api/accounts");
  expect(found[1]?.path).toBe("/api/invoicing/taxes");
});

test("a path matches its own method, not whichever route came first", () => {
  const routes = guardedRoutes(
    [
      "ctx.app.get(",
      '  "/api/subscriptions/proration/settings",',
      "  requireSession(),",
      '  requirePermission({ subscriptions: ["read"] }),',
      ");",
      "ctx.app.put(",
      '  "/api/subscriptions/proration/settings",',
      "  requireSession(),",
      '  requirePermission({ subscriptions: ["manage"] }),',
      ");",
    ].join("\n"),
  );
  expect(routes).toHaveLength(2);

  const writing = {
    line: 1,
    mutation: "save",
    gated: false,
    method: "PUT",
    path: "/api/subscriptions/proration/settings",
  };
  // read is the permissive answer and the one a path-only match returns.
  expect(needsFor(writing, routes)).toBe('subscriptions: ["manage"]');
});

test("a parameter and a template hole are the same kind of hole", () => {
  expect(normalisePath("/api/invoices/:id/void")).toBe("/api/invoices/:x/void");
  expect(normalisePath("/api/${kind}/:id/share")).toBe("/api/:x/:x/share");
  expect(normalisePath("/api/links?limit=5")).toBe("/api/links");
});

test("a control already carrying the prop is not reported as bare", () => {
  const source = [
    "const remove = useMutation({",
    '  mutationFn: () => api("/api/tags/1", { method: "DELETE" }),',
    "});",
    "<Button",
    '  needs={{ crm: ["delete"] }}',
    "  onClick={() => remove.mutate()}",
    ">Delete</Button>",
  ].join("\n");
  expect(controlsFiringMutations(source)[0]?.gated).toBe(true);
});

/**
 * The prop can sit a long way above the handler — a `ConfirmButton` carries a
 * title, a message and a confirm label between them. A fixed window reported
 * one of those as bare, and a guard that invents a gap is a guard somebody
 * switches off.
 */
test("a prop far above the handler still counts as gated", () => {
  const source = [
    "const toggle = useMutation({",
    '  mutationFn: () => api("/api/users/1", { method: "PATCH" }),',
    "});",
    "<ConfirmButton",
    '  title="Disable them?"',
    '  message="They lose access immediately and are signed out everywhere. Their record and everything they did stay — this is how somebody leaves without their work leaving with them."',
    '  confirmLabel="Disable them"',
    '  needs={{ settings: ["update"] }}',
    "  onConfirm={() => toggle.mutate(true)}",
    ">Disable</ConfirmButton>",
  ].join("\n");
  expect(controlsFiringMutations(source)[0]?.gated).toBe(true);
});

test("a control with no prop is reported as bare", () => {
  const source = [
    "const remove = useMutation({",
    '  mutationFn: () => api("/api/tags/1", { method: "DELETE" }),',
    "});",
    "<Button onClick={() => remove.mutate()}>Delete</Button>",
  ].join("\n");
  const [only] = controlsFiringMutations(source);
  expect(only?.gated).toBe(false);
  expect(only?.method).toBe("DELETE");
});

/** A route with no permission guard is not a gap; it is a route to leave. */
test("a route with no requirePermission is not offered as an answer", () => {
  const routes = guardedRoutes(
    ['ctx.app.post("/api/profile", requireSession(), handler);'].join("\n"),
  );
  expect(routes).toEqual([]);
});
