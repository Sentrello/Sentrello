import { expect, test } from "bun:test";
import type { ListSpec } from "./list-query";
import {
  UNPAGED_MAX,
  capUnpaged,
  inChunks,
  listParams,
  orderByWith,
} from "./list-query";
import * as schema from "./schema";

/**
 * The two guards that keep one request from taking the instance down.
 *
 * Both were written after five years of a real business was generated and run
 * against: the contact list stopped working at 32,000 rows, not because of the
 * rows but because the tags hung off them bound one parameter each, and the
 * Postgres wire protocol counts a statement's parameters in a signed 16-bit
 * field.
 */

test("ids are sent a thousand at a time, once, in order", async () => {
  const ids = Array.from({ length: 2_500 }, (_, n) => `id-${n}`);
  const sizes: number[] = [];
  const seen = await inChunks(ids, async (chunk) => {
    sizes.push(chunk.length);
    return chunk;
  });
  expect(sizes).toEqual([1000, 1000, 500]);
  // Nothing dropped, nothing repeated, nothing reordered — this feeds a map
  // keyed by id, and a missing chunk is a row that silently loses its tags.
  expect(seen).toEqual(ids);
});

test("a short list is one query, and an empty one is none", async () => {
  let calls = 0;
  await inChunks(["a", "b"], async (chunk) => {
    calls += 1;
    return chunk;
  });
  expect(calls).toBe(1);
  await inChunks([], async () => {
    calls += 1;
    return [];
  });
  expect(calls).toBe(1);
});

test("an unpaged result is cut at the ceiling and says it was", () => {
  const rows = Array.from({ length: UNPAGED_MAX + 1 }, (_, n) => n);
  const capped = capUnpaged(rows);
  expect(capped.rows).toHaveLength(UNPAGED_MAX);
  expect(capped.truncated).toBe(true);
  // One row under the ceiling is not a truncation, and must not claim to be.
  const under = capUnpaged(rows.slice(0, UNPAGED_MAX));
  expect(under.truncated).toBe(false);
  expect(under.rows).toHaveLength(UNPAGED_MAX);
});

test("a caller that never mentions paging is still unpaged", () => {
  expect(listParams({}).page).toBeNull();
  expect(listParams({ page: "2" }).page).toBe(2);
});

/**
 * A paged list needs a second column to break ties on.
 *
 * Without one the database is free to return two rows sharing a sort value in
 * either order, and it does — so a row sits on page one, then on page two
 * after the next request, and is never read. Every list here sorts on
 * something people share: a date, a status, an amount.
 *
 * The tiebreaker has to run the same way as the column in front of it. Pinned
 * to `desc` while the list is ascending, the ties come out backwards and the
 * page boundary still moves; that is the quieter half of the same bug, and it
 * is what the bills list was doing when this was written.
 */
const SPEC: ListSpec = {
  sortable: {
    billDate: schema.bills.billDate,
    totalCents: schema.bills.totalCents,
  },
  defaultSort: { field: "billDate", order: "desc" },
};

/**
 * The direction each clause carries, read off the built SQL.
 *
 * Drizzle's `asc`/`desc` are a chunk list ending in the literal " asc" or
 * " desc", which is the only place the direction exists before the query is
 * handed to a driver — and the point of this file is to check that direction
 * without a database.
 */
const directions = (query: Record<string, string | undefined>) =>
  orderByWith(SPEC, listParams(query), schema.bills.id).map((clause) => {
    const chunks = (clause as unknown as { queryChunks: unknown[] })
      .queryChunks;
    // The direction is the last chunk: a StringChunk whose `value` is a
    // one-element array holding " asc" or " desc".
    const last = chunks.at(-1) as { value?: string[] } | undefined;
    return String(last?.value?.[0] ?? "").trim() === "desc" ? "desc" : "asc";
  });

test("the tiebreaker follows the sort it is breaking ties for", () => {
  expect(directions({ sort: "billDate", order: "asc" })).toEqual([
    "asc",
    "asc",
  ]);
  expect(directions({ sort: "billDate", order: "desc" })).toEqual([
    "desc",
    "desc",
  ]);
});

/**
 * An unknown sort field falls back to the spec's default *direction*, not to
 * whatever direction arrived beside it — otherwise a stale bookmark naming a
 * column that has since been removed silently reverses the list.
 */
test("a sort field the list does not offer takes the default direction", () => {
  expect(directions({ sort: "whatever", order: "asc" })).toEqual([
    "desc",
    "desc",
  ]);
});

test("a list asked for nothing sorts the way the spec says", () => {
  expect(directions({})).toEqual(["desc", "desc"]);
});
