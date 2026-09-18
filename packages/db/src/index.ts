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
