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
 * The property is **evidence that money changed hands, or that somebody
 * bought something** — the books, the documents behind them, the numbering
 * that ties the two together, and what a customer was sold and billed for. It
 * errs wide on purpose: `deals` is here because it carries an amount, not
 * because anybody would prune it. The cost of a table being on this list is
 * that somebody has to come and argue for it in review; the cost of one being
 * missing is a business that cannot produce an invoice for a tax authority.
 *
 * **A column name cannot express that property, and this list is the proof.**
 * The ratchet that used to keep it honest looked for a column ending in
 * `_cents`, and four tables recording what customers bought and were billed
 * walked straight past it because none of them carries an amount at all — a
 * licence, a subscription and an entitlement are evidence of a purchase
 * written entirely in dates and identifiers. The mistake does not only go one
 * way: `companies.tax_identifier` and `organizations.base_currency` read like
 * money and are a VAT number and a preference. So the list is maintained by
 * hand, and what changed is that leaving a table off it is no longer
 * something that can happen quietly — see `NON_STATUTORY_TABLES` in
 * `@sentrello/db/retention`, which every other table in the schema has to be
 * named in, and the ratchet in `packages/db/src/retention.test.ts` that
 * refuses a table missing from both.
 *
 * By table name, so a Pro or optional module's table called `invoices` is
 * refused exactly as Core's is. A name with a schema on it — `seo_cloud.calls`
 * — is matched qualified instead, for the handful whose bare name is a word
 * an unrelated module could reasonably use for a log of its own.
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

  /*
   * What a customer bought from us, and what we billed them for it.
   *
   * These live in the control plane rather than in a business's own instance,
   * and none of them carries an amount — which is exactly why the column-name
   * ratchet never saw them. A licence, its subscription and the entitlements
   * it grants are the record of a sale: the answer to "what did they pay for,
   * and when did it start" is in dates and identifiers, and it is the evidence
   * behind every invoice we raise. The usage invoices and the call and credit
   * ledgers behind them are the metered half of the same thing.
   */
  "licenses",
  "license_subscriptions",
  "entitlements",
  "seo_usage_invoices",
  "seo_cloud.calls",
  "seo_cloud.credits",

  /*
   * The optional modules' own evidence of money taken.
   *
   * Qualified, because these live in schemas of their own and their bare names
   * are words another module could reasonably use for a log — `orders`,
   * `discounts`, `events`, `usage`, `tickets`. Named here rather than in the
   * repository that owns them because the refusal `addRetention` makes is by
   * name, and one list is the only way a policy written in any repository is
   * refused by the same rule.
   *
   * A till's ticket is a sale; its modifiers are what was on that sale and
   * what each cost; its adjustments are the voids and refunds; the drawer and
   * its events are cash counted in and paid out; a closure is a business's
   * record of a day's takings, which is the single row a tax inspector asks
   * for; the receipts are the documents handed over.
   *
   * A shop's orders and their lines are what was bought and billed. The
   * fulfilments say what was actually delivered, which is when the revenue is
   * earned. The allocations, cost layers and stock moves are the inventory
   * asset's cost basis — a balance-sheet figure and the cost of every sale —
   * and losing them is the defect found in the shop's own delete path this
   * week, arriving a second way. The tax classes and rates are what a document
   * was taxed at, protected for the same reason `tax_definitions` is, and the
   * discounts explain the difference between the list price and the charge.
   *
   * A subscription's charge attempts are money taken and money that failed;
   * its plan changes are what the customer bought and when that changed; its
   * dunning cycles are the evidence behind a cancellation and a debt not
   * collected; its discounts are as the shop's.
   *
   * `seo.usage` and `links.events` are metered: each is the basis a bill is
   * computed from, which is what makes an event log evidence rather than a
   * log. If either module ever stops billing on one, that is the argument for
   * taking it off this list — made in review, which is the point of the list.
   */
  "pos.tickets",
  "pos.ticket_line_modifiers",
  "pos.adjustments",
  "pos.drawers",
  "pos.drawer_events",
  "pos.closures",
  "pos.receipts",
  "pos.receipt_issues",
  "shop.orders",
  "shop.order_lines",
  "shop.fulfillments",
  "shop.allocations",
  "shop.stock_layers",
  "shop.stock_moves",
  "shop.tax_classes",
  "shop.tax_rates",
  "shop.discounts",
  "subscriptions.charge_attempts",
  "subscriptions.plan_changes",
  "subscriptions.dunning_cycles",
  "subscriptions.discounts",
  "seo.usage",
  "links.events",
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

/**
 * The same table, with the schema it lives in when it has one.
 *
 * `shop.orders` rather than `orders`. Both forms are matched against the
 * statutory list: the bare name so an entry like `invoices` refuses any
 * module's table of that name whatever schema it is in, and the qualified one
 * so an entry like `seo_cloud.calls` refuses exactly that table and leaves a
 * CRM free to keep a log of telephone calls.
 */
export function retentionQualifiedName(table: RetentionTable): string {
  const named = table as unknown as Record<symbol, unknown>;
  const schema = named[Symbol.for("drizzle:Schema")];
  const name = retentionTableName(table);
  return typeof schema === "string" && schema ? `${schema}.${name}` : name;
}

/**
 * Every table a repository's schema exports, as this facility names them.
 *
 * A drizzle table carries its name under a registered symbol, which is what
 * `retentionTableName` reads — so this recognises one without importing the
 * ORM, the same way everything else here does.
 */
export function schemaTableNames(
  exported: Record<string, unknown>,
): { name: string; qualified: string }[] {
  const tables: { name: string; qualified: string }[] = [];
  for (const value of Object.values(exported)) {
    if (!value || typeof value !== "object") continue;
    const table = value as RetentionTable;
    const name = retentionTableName(table);
    if (!name) continue;
    tables.push({ name, qualified: retentionQualifiedName(table) });
  }
  return tables;
}

/** What a schema's classification is missing. Empty on all three is the pass. */
export interface ClassificationGaps {
  /** In neither list: nobody has decided what losing this table would cost. */
  unclassified: string[];
  /** In both, which is somebody having decided twice and differently. */
  both: string[];
  /** Named as ordinary but no longer in the schema — a guard over nothing. */
  stale: string[];
}

/**
 * The ratchet, in one place so three repositories cannot write it three ways.
 *
 * `STATUTORY_TABLES` is the refusal and it is central, because `addRetention`
 * matches by name and a policy written in any repository has to meet the same
 * list. The *other* half — "this table was looked at and is not evidence of
 * money" — is local: they are that repository's own logs and settings rows,
 * and nobody else has an opinion about them.
 *
 * So each repository runs this over its own schema with its own ordinary list,
 * and a table it adds tomorrow is in neither until somebody has decided. That
 * property held only inside Core until now, which made the guarantee
 * "protected where we remembered" — twenty-three tables recording money taken
 * at a till, sold from a shop and billed by subscription were registering
 * retention policies against a list that had never heard of them.
 *
 * The alternative considered was each module declaring its own statutory
 * tables and this facility consulting them at registration. It is the same
 * hole one level in: a module that forgets to declare is a module whose tables
 * are unprotected, and the thing that must not be forgettable is exactly the
 * declaring.
 */
export function classifySchema(
  exported: Record<string, unknown>,
  ordinary: readonly string[],
): ClassificationGaps {
  const statutory: readonly string[] = STATUTORY_TABLES;
  const known = new Set(ordinary);
  const gaps: ClassificationGaps = { unclassified: [], both: [], stale: [] };
  const present = new Set<string>();

  for (const { name, qualified } of schemaTableNames(exported)) {
    present.add(name);
    const isStatutory =
      statutory.includes(name) || statutory.includes(qualified);
    const isOrdinary = known.has(name) || known.has(qualified);
    if (isStatutory && isOrdinary) gaps.both.push(qualified);
    else if (!isStatutory && !isOrdinary) gaps.unclassified.push(qualified);
  }
  for (const name of ordinary) {
    if (!present.has(name) && !present.has(name.split(".").pop() ?? name)) {
      gaps.stale.push(name);
    }
  }
  return gaps;
}

/** Whether a table is one the books depend on and nothing may sweep. */
export function isStatutoryTable(table: RetentionTable): boolean {
  const names: readonly string[] = STATUTORY_TABLES;
  return (
    names.includes(retentionTableName(table)) ||
    names.includes(retentionQualifiedName(table))
  );
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
  if (isStatutoryTable(policy.table)) {
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
