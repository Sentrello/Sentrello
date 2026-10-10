/**
 * What a module's routes need from the host, through the SDK.
 *
 * The module linking exception covers a module written against
 * `@sentrello/module-sdk`, and a real one cannot stop there: every route
 * checks who is calling and what they may do, and every query reads the
 * business's own tables. Those live in `@sentrello/auth` and `@sentrello/db`,
 * and a module importing them directly is a module whose author has to read
 * the licence twice to know where they stand. So they are handed through
 * here, and the extension guide's example imports nothing else.
 *
 * **A separate entry point, not the SDK's index.** `@sentrello/auth` and
 * `@sentrello/db` both import the SDK's index, so re-exporting them from it
 * would make the SDK import itself on the way in. This file is imported by
 * neither of them, which keeps that a straight line: a module imports this,
 * this imports auth and db, and they import the index.
 */

export {
  activeOrganizationId,
  isKeyCaller,
  mayAccess,
  requirePermission,
  requireSession,
} from "@sentrello/auth/hono";

export { db, schema } from "@sentrello/db";

export {
  and,
  asc,
  between,
  bigint,
  boolean,
  date,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  index,
  integer,
  isNotNull,
  isNull,
  jsonb,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  pgSchema,
  pgTable,
  sql,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "@sentrello/db/orm";
