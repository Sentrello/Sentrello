/**
 * Drizzle's builders and query helpers, re-exported so modules never carry
 * their own copy of the ORM — a second copy gives structurally identical but
 * nominally incompatible types and a second set of runtime classes.
 *
 * This module deliberately does NOT touch `./client`: importing it must never
 * open a database connection. Schema files and migration tooling import from
 * here; anything that actually queries imports `db` from the package root.
 */
export {
  /**
   * Sixty-four bits, for a counter that is not money in cents.
   *
   * The SEO module counts in millionths — a rank check costs 600 of them — and
   * a business's yearly usage runs past what a 32-bit integer holds. Nothing
   * in the ledger uses this: money is integer cents there and always will be.
   */
  bigint,
  boolean,
  /**
   * A day, with no time and no zone.
   *
   * For the things a business says a date about rather than a moment: the day
   * a task starts, the day an hour was worked. A `timestamp` for these is how
   * a task planned for Monday shows as Sunday to whoever opens it from a
   * different timezone, and how "hours in September" quietly includes an hour
   * logged at 8pm on the 31st of August.
   */
  date,
  index,
  integer,
  jsonb,
  // A module with tables of its own may keep them in its own Postgres schema.
  // Two modules can want the same noun — Sentrello's SubShop and a customer's
  // Shop both have products — and `shop.products` says which is which better
  // than a longer prefix would.
  pgSchema,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export {
  and,
  asc,
  between,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm";

import { sql as drizzleSql } from "drizzle-orm";

/**
 * A moment in time, safe to interpolate into a raw `sql` template.
 *
 * Drizzle binds a `Date` correctly when it can see the column — `gte(t.at, d)`
 * is fine. Inside a `sql` template it cannot, so the driver is handed a Date
 * with no type and throws before Postgres ever sees the query:
 *
 *   TypeError: The "string" argument must be of type string ... Received an
 *   instance of Date
 *
 * That is a 500, and it is why three dashboards answered "Something went
 * wrong": every one of them had a `case when ... >= ${monthStart}` in it.
 *
 * The cast is `timestamp`, without a zone, because that is what the columns
 * are and `toISOString()` is what Drizzle itself writes into them. Matching it
 * exactly is the point: a `timestamptz` cast here would compare through the
 * session's time zone and be quietly wrong by hours on a server not in UTC.
 */
export function at(moment: Date) {
  return drizzleSql`${moment.toISOString()}::timestamp`;
}
