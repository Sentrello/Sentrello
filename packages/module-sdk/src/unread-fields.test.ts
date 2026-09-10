import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fieldsRead, fieldsWritten, unreadFields } from "./unread-fields";

const dir = mkdtempSync(join(tmpdir(), "unread-"));
const write = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

const route = write(
  "route.ts",
  `ctx.app.patch("/api/projects/:id", async (c) => {
     const body = await c.req.json();
     if (body.status !== undefined) patch.status = String(body.status);
     if (body.companyId !== undefined) patch.companyId = body.companyId;
     const { startsOn, endsOn: finish } = body;
     const mode = body["scheduling"];
     // Neither of these is a field anybody can send.
     const trimmed = body.slice(0, 100);
     const { organizationId: _ignored, ...rest } = body;
   });`,
);

const screen = write(
  "screen.tsx",
  `const save = () => api("/api/projects/1", {
     method: "PATCH",
     body: JSON.stringify({ status, startsOn: day }),
   });
   const finish = () => api("/api/bank-feeds/connect/finish", {
     method: "POST",
     body: JSON.stringify({ provider, scheduling }),
   });`,
);

test("a field the handler reads is found, however it reads it", () => {
  const read = fieldsRead([route]).get(route);
  expect([...(read ?? [])].sort()).toEqual([
    "companyId",
    "endsOn",
    "scheduling",
    "startsOn",
    "status",
  ]);
});

/**
 * The rename keeps the wire name. A screen sends `endsOn`; what the handler
 * calls it afterwards is its own business, and looking for `finish` would
 * report a field nobody can set while the screen sets it perfectly well.
 */
test("a renamed destructure is recorded under the name that goes over the wire", () => {
  expect(fieldsRead([route]).get(route)?.has("endsOn")).toBe(true);
  expect(fieldsRead([route]).get(route)?.has("finish")).toBe(false);
});

/**
 * Two things that look like fields and are not. Both were reported the first
 * time this ran across Core, and both would have taught somebody that this
 * check cries wolf — which is how a guard gets switched off.
 */
test("a method call on a string body is not a field", () => {
  // `body.slice(0, MAX)` — a request body is sometimes a string.
  expect(fieldsRead([route]).get(route)?.has("slice")).toBe(false);
});

test("a field destructured into `_name` is being refused, not missed", () => {
  // `const { organizationId: _ignored, ...rest } = body` is a handler stopping
  // a caller setting it. Reporting that is reporting the guard as the hole.
  expect(fieldsRead([route]).get(route)?.has("organizationId")).toBe(false);
});

test("fields the screen sends are seen, shorthand and all", () => {
  const written = fieldsWritten([screen]);
  expect(written.has("status")).toBe(true);
  expect(written.has("startsOn")).toBe(true);
});

/**
 * Two shorthand names in a row share the comma between them. Consuming it
 * meant only the first was ever seen — which reported `startToken` as
 * unreachable while the bank-connection screen sent `{ provider, startToken }`.
 */
test("both of two adjacent shorthand names are seen", () => {
  const written = fieldsWritten([screen]);
  expect(written.has("provider")).toBe(true);
  expect(written.has("scheduling")).toBe(true);
});

/**
 * The whole point: `companyId` is read by the route and sent by nothing. This
 * is the shape of gap that route-level sweeps cannot see, because the route
 * itself *is* reached — by the status field beside it.
 */
/**
 * A file that embeds the browser's own script reads `body.x` off a *response*.
 * The shop's storefront pages do exactly this, and it produced sixteen
 * findings, none of them real.
 */
test("a file that never parses a request body has no fields", () => {
  const clientScript = write(
    "storefront.ts",
    `const page = () => c.html(\`<script>
       const res = await fetch("/api/shop/basket");
       const body = await res.json();
       draw(body.checkout, body.orderToken);
     </script>\`);`,
  );
  expect(fieldsRead([clientScript]).size).toBe(0);
});

test("a field read but never sent is reported", () => {
  const hits = unreadFields({ routeFiles: [route], screenFiles: [screen] }).map(
    (h) => h.split(": ")[1],
  );
  // `endsOn` too: the screen sends startsOn and not its pair, which is
  // exactly the sort of half-reachable field this is for.
  // `scheduling` is sent by the second call in the screen fixture now.
  expect(hits).toEqual(["companyId", "endsOn"]);
});

test("a field written by something that is not a screen can be excused", () => {
  expect(
    unreadFields({
      routeFiles: [route],
      screenFiles: [screen],
      writtenElsewhere: { companyId: "the importer" },
      ignore: ["endsOn"],
    }),
  ).toEqual([]);
});

/**
 * A comment is not code, in either direction.
 *
 * Explaining why a field was removed means writing its name down, and the
 * sweep used to read that as the route still accepting it — so the only way
 * to write the explanation was to avoid naming the thing being explained.
 *
 * The other direction is the one that matters more: a commented-out line in a
 * screen made a field look reachable, which hides exactly the gap this exists
 * to find.
 */
test("a field named only in a comment is neither read nor sent", () => {
  const commented = write(
    "commented.ts",
    `export const r = (app) => app.post("/x", async (c) => {
       const body = await c.req.json();
       // This used to read \`body.lock\`, and no longer does.
       /* Nor body.legacy, which went with it. */
       return c.json({ ok: Boolean(body.real) });
     });`,
  );
  expect([...(fieldsRead([commented]).values().next().value ?? [])]).toEqual([
    "real",
  ]);

  const screenWithDeadCode = write(
    "dead-code.tsx",
    `export function S() {
       // body: JSON.stringify({ lock: true }),
       return fetch("/x", { body: JSON.stringify({ real: 1 }) });
     }`,
  );
  const hits = unreadFields({
    routeFiles: [commented],
    screenFiles: [screenWithDeadCode],
  }).map((h) => h.split(": ")[1]);
  expect(hits).toEqual([]);
});

test("a url inside a string is not mistaken for a comment", () => {
  const withUrl = write(
    "with-url.ts",
    `export const r = (app) => app.post("/x", async (c) => {
       const body = await c.req.json();
       const to = "https://example.test/hook";
       return c.json({ to, id: body.callbackId });
     });`,
  );
  expect([...(fieldsRead([withUrl]).values().next().value ?? [])]).toEqual([
    "callbackId",
  ]);
});
