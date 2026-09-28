import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { schema } from "@sentrello/db";
import {
  fieldsWritten,
  sourceFiles,
  unreadFields,
} from "@sentrello/module-sdk";

/**
 * Every field a free module accepts can be set from a screen.
 *
 * The route sweeps beside this one ask whether a route is reached. Both are
 * green on a route whose fields nobody can set, because a route is reached by
 * whichever one field the screen does send — Project Management's customer link
 * was unreachable for the module's whole life behind a `PATCH` that the status
 * dropdown called every day.
 *
 * Asserted exactly, so it is a ratchet in both directions: a new unreachable
 * field fails on the day it is written, and fixing one without deleting its
 * line fails just as loudly.
 */
const modules = join(import.meta.dir, "../../../packages/modules-free");
const screens = sourceFiles(join(import.meta.dir, "../../web/src"), [
  ".tsx",
  ".ts",
]);

/** Field names that are noise: a handler's locals, and words every file holds. */
const IGNORE = ["id", "name", "type", "status", "kind", "label", "value"];

/**
 * Written by something that is not one of our screens, and by what.
 *
 * **Find the caller before adding a line here.** Pro's route-level list carried
 * `POST /api/projects/time/invoiced` excused as "the module that raises the
 * invoice" for months — a plausible sentence about a caller that did not exist,
 * which hid the fact that billable hours could not be invoiced at all.
 */
const WRITTEN_ELSEWHERE: Record<string, string> = {
  // The period lock's control ships in the pro-accounting bundle — its Tax
  // and currency screen writes this against the Free half's
  // `/api/accounting/period`. Verified against the bundle's screens.
  closedThrough: "the pro-accounting bundle's Tax and currency screen",
};

/**
 * Accepted by a route, reachable from no screen, not yet fixed.
 *
 * Recorded rather than excused. Nobody can set any of these today.
 */
const KNOWN_GAPS: Record<string, string[]> = {};

test("there are modules and screens to check", () => {
  // A glob matching nothing passes every assertion below it.
  expect(readdirSync(modules).length).toBeGreaterThan(3);
  expect(screens.length).toBeGreaterThan(10);
});

for (const name of readdirSync(modules, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)) {
  const src = join(modules, name, "src");
  if (!existsSync(src)) continue;

  test(`every field ${name} accepts can be set from a screen`, () => {
    const routes = sourceFiles(src, [".ts"]).filter(
      (f) => !f.endsWith(".test.ts"),
    );
    expect(
      unreadFields({
        routeFiles: routes,
        screenFiles: screens,
        writtenElsewhere: WRITTEN_ELSEWHERE,
        ignore: IGNORE,
      }),
    ).toEqual(KNOWN_GAPS[name] ?? []);
  });
}

/**
 * And the tables the CRM's generic resource factory serves, which the sweep
 * above cannot see at all.
 *
 * `fieldsRead` finds what a route accepts by looking for `body.x`. The
 * factory in `crm/src/index.ts` does neither: it destructures the body,
 * spreads the rest into the update, and never names a field. So contacts,
 * companies, deals, tasks and notes — seven tables and most of the CRM —
 * are invisible to a guard whose whole job is noticing an unreachable
 * field, and it passes on them by seeing nothing.
 *
 * That is not theoretical. `tasks.assigneeId` had a column, an API that
 * accepted it, and a server check refusing anybody who is not a member of
 * the business — and no screen offered it, so every task in the product
 * belonged to nobody. It was found by reading, on 2026-09-27, and this
 * would have found it on the day it was written.
 *
 * Where the body is opaque the accepted fields are the table's own
 * columns, so that is what this compares. Each excused name says who sets
 * it, and "find the caller before adding a line here" applies twice over:
 * a wrong excuse here hides a whole column.
 */
const FACTORY_TABLES = {
  contacts: schema.contacts,
  companies: schema.companies,
  deals: schema.deals,
  tasks: schema.tasks,
  notes: schema.notes,
} as unknown as Record<string, Record<string, unknown>>;

/**
 * Columns nothing writes, and nothing should.
 *
 * Separate from the map below because the two say different things. That one
 * says "somebody else sets this"; this one says "nobody sets this, and here is
 * why that is right". `portalUserId` was in the wrong one, excused as "the
 * portal sign-in" — a sentence that describes a real feature and the wrong
 * column. The portal customers use signs in with `portalToken` and never
 * touches this; the account-based portal that did was removed, and the column
 * is a tombstone whose own comment in the schema says so.
 */
const TOMBSTONES: Record<string, string> = {
  portalUserId:
    "the removed account-based portal; kept one release in case an instance holds hand-entered data",
};

const SET_BY_THE_SERVER: Record<string, string> = {
  id: "the database",
  organizationId: "the session, never the body",
  createdAt: "the database",
  updatedAt: "the route, on every write",
  deletedAt: "the soft-delete route",
  portalToken: "minted by its own endpoint, and stripped from every read",
  customValues:
    "the custom-fields editor, which writes a map rather than a field",
  decidedAt: "the deal's own won/lost action",
  doneAt: "completing a task",
  authorId: "the session that wrote the note",
  sourceSubmissionId: "the public form pipeline",
  taxIdentifierValid: "the VAT-number check",
  taxIdentifierCheckedAt: "the VAT-number check",
  taxIdentifierCheckedName: "the VAT-number check",
  dealId: "the task composer, through its `subject` prop rather than by name",
};

test("every column the CRM factory writes can be set from a screen", () => {
  const written = fieldsWritten(screens);
  const unreachable: string[] = [];

  for (const [table, columns] of Object.entries(FACTORY_TABLES)) {
    for (const column of Object.keys(columns)) {
      // Drizzle hangs helpers off the table object; only real columns have
      // a `name`, which is what distinguishes them from `enableRLS`.
      const col = columns[column] as { name?: unknown } | undefined;
      if (!col || typeof col !== "object" || typeof col.name !== "string") {
        continue;
      }
      if (column in SET_BY_THE_SERVER || column in TOMBSTONES) continue;
      if (written.has(column)) continue;
      unreachable.push(`${table}.${column}`);
    }
  }

  expect(
    unreachable,
    `these columns can be written through the API and set from no screen:\n    ${unreachable.join("\n    ")}`,
  ).toEqual([]);
});

/**
 * And every excuse names a caller that exists.
 *
 * The map above is the guard's one soft spot: a line in it silences a column
 * for good, and a plausible sentence is all it takes. `portalUserId` sat there
 * for months as "the portal sign-in" while nothing in any repository wrote it.
 * So each excused name has to appear in code that is not a schema and not a
 * test — if the writer is gone, the column belongs in `TOMBSTONES` with the
 * reason, or on the screen it was always meant to have.
 */
test("every column excused as server-set is written somewhere", () => {
  const roots = ["packages", "apps/server/src"].map((d) =>
    join(import.meta.dir, "../../..", d),
  );
  const code = roots
    .flatMap((root) => sourceFiles(root, [".ts", ".tsx"]))
    .filter(
      (f) =>
        !/schema\.ts$/.test(f) &&
        !/\.test\.tsx?$/.test(f) &&
        !f.includes("/dist/"),
    );

  const unwritten = Object.keys(SET_BY_THE_SERVER).filter((column) => {
    const word = new RegExp(`\\b${column}\\b`);
    return !code.some((f) => word.test(readFileSync(f, "utf8")));
  });

  expect(
    unwritten,
    `excused as set by the server, and set by nothing:\n    ${unwritten.join("\n    ")}`,
  ).toEqual([]);
});
