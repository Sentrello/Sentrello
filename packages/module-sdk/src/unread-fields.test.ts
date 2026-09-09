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
   });`,
);

const screen = write(
  "screen.tsx",
  `const save = () => api("/api/projects/1", {
     method: "PATCH",
     body: JSON.stringify({ status, startsOn: day }),
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

test("fields the screen sends are seen, shorthand and all", () => {
  const written = fieldsWritten([screen]);
  expect(written.has("status")).toBe(true);
  expect(written.has("startsOn")).toBe(true);
});

/**
 * The whole point: `companyId` is read by the route and sent by nothing. This
 * is the shape of gap that route-level sweeps cannot see, because the route
 * itself *is* reached — by the status field beside it.
 */
test("a field read but never sent is reported", () => {
  const hits = unreadFields({ routeFiles: [route], screenFiles: [screen] }).map(
    (h) => h.split(": ")[1],
  );
  // `endsOn` too: the screen sends startsOn and not its pair, which is
  // exactly the sort of half-reachable field this is for.
  expect(hits).toEqual(["companyId", "endsOn", "scheduling"]);
});

test("a field written by something that is not a screen can be excused", () => {
  expect(
    unreadFields({
      routeFiles: [route],
      screenFiles: [screen],
      writtenElsewhere: { companyId: "the importer" },
      ignore: ["scheduling", "endsOn"],
    }),
  ).toEqual([]);
});
