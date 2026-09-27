export * from "./actor";
export * from "./client";
export * from "./schema";

// Table builders and query helpers. Also available as `@sentrello/db/orm`,
// which is the import to use from a schema file: that subpath never opens a
// database connection.
export * from "./orm";

/*
 * Loaded for its side effect: Core declares which of its tables are evidence
 * of money and which are not, before any module can register a policy that
 * sweeps one. See `declareClassification` in the SDK for why this is an import
 * rather than an assertion in a test.
 */
import "./retention";

/**
 * A shape check before the database sees it.
 *
 * Postgres refuses a malformed uuid with an error rather than an empty
 * result, so an id typed into an address by hand — or left in a stale link —
 * is a 500 and a screen saying "something went wrong", where it should be a
 * 404 and a screen saying it could not find that.
 *
 * Here rather than in a module because three of them had written it out
 * already: the chart of accounts, the CRM's `owned`, and now invoicing. The
 * comment explaining why was written twice too.
 */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
