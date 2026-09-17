import { expect, test } from "bun:test";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { archiveSets, tableKey } from "./archive";
import * as schema from "./schema";

/**
 * Nobody remembers to update a list.
 *
 * The archive refuses to delete rows that something outside the period still
 * points at, and that refusal is worth exactly as much as the list of pointers
 * it checks. A table added next year with an `invoice_id` on it would not be on
 * that list, the check would pass, and the first a business would know is an
 * open record naming an invoice that no longer exists.
 *
 * So the list is not trusted. This sweeps the whole schema for any column whose
 * name means "a row of something archivable" and fails unless the set has
 * accounted for it — as its own child, as a declared reference, or as a waiver
 * below with a reason written down. A new table fails this test on the day it
 * is added, which is the day somebody can still think about it.
 */

/** Columns that carry one of these names but do not mean what they look like. */
const WAIVED: { table: string; column: string; because: string }[] = [
  {
    table: "payment_webhook_events",
    column: "event_id",
    because:
      "the payment processor's own id for the event it sent, a text field with nothing to do with the change feed",
  },
];

/**
 * Every table the schema declares.
 *
 * `schema` also exports relations and helpers, so the values are narrowed
 * through `unknown` — a predicate written against the module's own union is one
 * TypeScript rejects the moment a table is added to it.
 */
function everyTable(): PgTable[] {
  return Object.values(schema as Record<string, unknown>).filter(
    (value): value is PgTable => is(value, PgTable),
  );
}

function columnsOf(table: PgTable): string[] {
  return Object.values(getTableColumns(table)).map((column) => column.name);
}

test("every column that names an archivable row is accounted for", () => {
  const tables = everyTable();

  const failures: string[] = [];
  let examined = 0;

  for (const set of archiveSets()) {
    /** Column name -> the entry of this set it points at. */
    const names = new Map<string, string>();
    for (const entry of set.tables) {
      const pointers = entry.pointedAtBy ?? [
        `${entry.name.replace(/s$/, "")}_id`,
      ];
      for (const pointer of pointers) names.set(pointer, tableKey(entry));
    }

    for (const table of tables) {
      const name = getTableName(table);
      for (const column of columnsOf(table)) {
        const target = names.get(column);
        if (!target) continue;
        examined += 1;
        if (WAIVED.some((w) => w.table === name && w.column === column))
          continue;

        // Its own child, leaving with its parent.
        const asChild = set.tables.some(
          (t) => t.name === name && t.follows?.column === column,
        );
        if (asChild) continue;

        // Declared, so the plan checks it and refuses when it is held.
        const declared = set.references.some(
          (r) => r.from === name && r.column === column,
        );
        if (declared) continue;

        failures.push(
          `${name}.${column} points at ${target} in the "${set.id}" archive and is neither a child of it, a declared reference, nor waived`,
        );
      }
    }
  }

  expect(failures).toEqual([]);
  /*
   * And the sweep found something to check.
   *
   * A naming convention that stopped matching — a column renamed, a set's
   * `pointedAtBy` left stale — would make every assertion above pass by
   * examining nothing at all, which is the failure mode this whole test exists
   * to prevent somewhere else.
   */
  expect(examined).toBeGreaterThan(12);
});

test("every table in every set is reachable from an organization", () => {
  for (const set of archiveSets()) {
    for (const entry of set.tables) {
      let at = entry;
      const seen = new Set<string>();
      while (!at.org) {
        expect(
          at.follows,
          `${set.id}/${tableKey(at)} has no organization column and follows nothing`,
        ).toBeDefined();
        const parent = at.follows?.parent as string;
        expect(seen.has(parent), `${set.id} has a loop at ${parent}`).toBe(
          false,
        );
        seen.add(parent);
        const next = set.tables.find((t) => tableKey(t) === parent);
        expect(
          next,
          `${set.id}/${tableKey(at)} follows ${parent}, which is not in the set`,
        ).toBeDefined();
        at = next as typeof at;
      }
    }
  }
});

test("every table and column a set names actually exists", () => {
  const byName = new Map(
    everyTable().map(
      (table) => [getTableName(table), columnsOf(table)] as const,
    ),
  );

  for (const set of archiveSets()) {
    for (const entry of set.tables) {
      const columns = byName.get(entry.name);
      expect(
        columns,
        `${set.id} names a table that does not exist: ${entry.name}`,
      ).toBeDefined();
      for (const column of [
        entry.org,
        entry.date,
        entry.follows?.column,
        entry.only?.column,
      ]) {
        if (!column) continue;
        expect(
          columns?.includes(column),
          `${set.id}/${tableKey(entry)} names a column that does not exist: ${entry.name}.${column}`,
        ).toBe(true);
      }
    }
    for (const reference of set.references) {
      const columns = byName.get(reference.from);
      expect(
        columns,
        `${set.id} refers to a table that does not exist: ${reference.from}`,
      ).toBeDefined();
      expect(
        columns?.includes(reference.column),
        `${set.id} refers to a column that does not exist: ${reference.from}.${reference.column}`,
      ).toBe(true);
      expect(
        set.tables.some((t) => tableKey(t) === reference.to),
        `${set.id} refers to ${reference.to}, which is not in the set`,
      ).toBe(true);
    }
  }
});
