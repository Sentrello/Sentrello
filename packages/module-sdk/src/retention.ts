/**
 * How long a module's own logs are kept, and what is left of them afterwards.
 *
 * Every module writes something down as it works — a change feed, a delivery
 * log, an audit trail — and a log is the one kind of table that only ever
 * grows. On a self-hosted box under twenty people, with nobody watching the
 * disk, that is not an incident this year; it is an incident in two years, on
 * a customer's own server, where the answer today would be "log in and delete
 * some rows". That is not an answer to give somebody with no IT department.
 *
 * So a module says what it keeps and for how long, and the platform does the
 * sweeping. **The facility owns the mechanics** — batching, a wall-clock
 * budget, the loop over every organisation, isolation so one module's bad
 * policy cannot cost another its night, the backlog count and saying so out
 * loud. **The module owns the policy** — its own window, and whether an old
 * row is emptied or removed.
 *
 * Emptying is usually the better answer. That a run happened, that a delivery
 * was attempted, that a deal moved on the third — those are facts about the
 * business, two hundred bytes each, and they stay true for years. The copy of
 * a record the log carried alongside is the heavy half and goes stale in
 * weeks. Keep the fact, drop the copy.
 *
 * **Nothing financial can be reached from here.** Invoices, payments and
 * ledger entries are statutory records: a retention sweep that knows the name
 * of one is a `where` clause away from being the reason a business cannot
 * answer an auditor. `STATUTORY_TABLES` below makes pointing a policy at one a
 * compile error, and `addRetention` refuses it again at runtime for callers
 * who reached it from JavaScript or through a cast.
 *
 * Structural types rather than the ORM's, for the reason `SentrelloSession`
 * is structural: this package is the public module contract and carries one
 * dependency. A drizzle table, column and `SQL` satisfy these as they stand.
 */

/**
 * Tables a retention policy may never be pointed at.
 *
 * The books, the evidence behind them, and the numbering that ties the two
 * together. It errs wide on purpose — `deals` is here because it carries an
 * amount, not because anybody would prune it — since the cost of a table
 * being on this list is that somebody has to come and argue for it in review,
 * and the cost of one being missing is a business that cannot produce an
 * invoice for a tax authority.
 *
 * By table name, so a Pro or optional module's table called `invoices` is
 * refused exactly as Core's is. Kept honest by the ratchet in
 * `packages/db/src/retention.test.ts`: any table in the schema carrying an
 * amount in cents has to be named here.
 */
export const STATUTORY_TABLES = [
  "accounts",
  "bank_imports",
  "bank_payment_schedules",
  "bank_payments",
  "bank_reconciliations",
  "bank_rules",
  "bank_transactions",
  "bill_lines",
  "bill_payments",
  "billable_items",
  "bills",
  "budget_lines",
  "budgets",
  "contractor_tax_details",
  "customer_credits",
  "deals",
  "document_counters",
  "document_taxes",
  "exchange_rates",
  "exemption_certificates",
  "expenses",
  "fixed_assets",
  "invoice_lines",
  "invoices",
  "journal_entries",
  "journal_lines",
  "payments",
  "quote_instalments",
  "quote_lines",
  "quotes",
  "recurring_bills",
  "recurring_periods",
  "recurring_profiles",
  "tax_definitions",
  "transactions",
  "vendor_credit_applications",
  "vendor_credits",
] as const;

export type StatutoryTable = (typeof STATUTORY_TABLES)[number];

/** A drizzle `SQL` fragment, structurally. */
export interface SqlFragment {
  getSQL(): unknown;
}

/** A column, structurally. */
export interface RetentionColumn extends SqlFragment {
  readonly name: string;
}

/**
 * A table with an id and an organisation, structurally.
 *
 * `organizationId` is required in the type rather than checked in review: a
 * sweep that reached another organisation's rows is the worst thing this
 * facility could do, and every statement it writes is scoped by this column.
 */
export interface RetentionTable {
  readonly _: { readonly name: string };
  readonly id: RetentionColumn;
  readonly organizationId: RetentionColumn;
}

/**
 * The same table, unless it is one nobody may sweep.
 *
 * A statutory table resolves to `never`, so `registerRetention` refuses to
 * compile against it. The message is "not assignable to type 'never'", which
 * is obscure on its own — hence the name of this type in the signature.
 */
export type NotStatutory<T> = T extends { _: { name: infer Name } }
  ? Name extends StatutoryTable
    ? never
    : T
  : never;

/**
 * A payload to take out of a row, in the same words the erasure uses.
 *
 * Deliberately the shape `redactPayloads` takes, and emptied by the same
 * function: a bare column is emptied whole, a column with `keys` keeps
 * everything except those keys. Two ways of saying what a payload is would
 * agree for a fortnight, and the one that drifted would be the one telling a
 * data subject their copy was gone.
 */
export type RetentionPayload =
  | RetentionColumn
  | { column: RetentionColumn; keys: string[] };

/** What one organisation keeps. Zero, or absent, means for ever. */
export interface RetentionWindow {
  /** Days after which a finished row's payloads are emptied. */
  emptyAfterDays?: number;
  /** Days after which a finished row goes entirely. */
  removeAfterDays?: number;
}

export interface RetentionPolicy<T extends RetentionTable = RetentionTable> {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  /** What a person would call this log: "Change feed", "Sign-in history". */
  label: string;
  table: T;
  /**
   * The column that says when this row finished.
   *
   * Null means it has not, and a row that has not finished is live state —
   * a run still waiting on an approval, an event nothing has dispatched yet.
   * The sweep never touches one, whatever its age. A column that is never
   * null (a plain `at`) therefore means every row is eligible once it is old
   * enough, which is the right reading for a log of things that already
   * happened.
   */
  clock: RetentionColumn;
  /**
   * Rows this policy never touches, however old.
   *
   * For the handful a log cannot lose — the marker saying a prune happened is
   * the case here, and it is the only evidence of a removal.
   */
  keep?: SqlFragment;
  /** What comes out at `emptyAfterDays`. Absent means nothing is emptied. */
  payloads?: RetentionPayload[];
  /** How long this organisation keeps it. Asked per sweep, per organisation. */
  window: (
    organizationId: string,
  ) => RetentionWindow | Promise<RetentionWindow>;
  /**
   * Rows elsewhere that belong to this batch, dealt with first.
   *
   * For a log kept in two tables — a run and a row per step. Called with the
   * batch about to be emptied or removed, and returns how many rows it
   * touched, so the report counts them. First, because a parent removed
   * before its children leaves orphans with nothing to find them by, growing
   * in the dark; the other way round leaves a parent with no children, which
   * the same query offers again and finishes.
   */
  cascade?: (
    ids: string[],
    organizationId: string,
    phase: "empty" | "remove",
  ) => Promise<number>;
}

export interface RegisteredRetention extends RetentionPolicy {
  moduleId: string;
}

/**
 * The table's name at runtime.
 *
 * `_` is type-only on a drizzle table; the name lives under a registered
 * symbol, which is exactly what `getTableName` reads. Read here rather than
 * imported so this package keeps its one dependency.
 */
export function retentionTableName(table: RetentionTable): string {
  const named = table as unknown as Record<symbol, unknown>;
  const name = named[Symbol.for("drizzle:Name")] ?? table._?.name;
  return typeof name === "string" ? name : "";
}

const policies: RegisteredRetention[] = [];

/**
 * The runtime half of the refusal.
 *
 * The compiler stops a policy on `invoices` being written; this stops one
 * reaching the registry from JavaScript, from a cast, or from a module built
 * against a version of this file that had a shorter list. It throws rather
 * than dropping the policy, because a module whose retention silently did not
 * register is the failure this whole facility exists to prevent.
 *
 * A table this cannot name is refused too. Not knowing what is about to be
 * swept is the one state where carrying on is worse than stopping.
 */
export function addRetention(policy: RegisteredRetention): void {
  const table = retentionTableName(policy.table);
  if (!table) {
    throw new Error(
      `retention policy "${policy.id}" was given something that is not a table`,
    );
  }
  if ((STATUTORY_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `retention policy "${policy.id}" points at "${table}", which is a statutory record and is never swept`,
    );
  }
  const at = policies.findIndex((p) => p.id === policy.id);
  // Replaced rather than appended, so a module registered twice — which the
  // tests that boot the app more than once do — does not sweep twice and
  // report its work double.
  if (at >= 0) policies[at] = policy;
  else policies.push(policy);
}

export function retentionPolicies(): RegisteredRetention[] {
  return [...policies];
}

/** For tests, and for a host that loads its modules more than once. */
export function clearRetention(): void {
  policies.length = 0;
}
