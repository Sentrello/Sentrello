/**
 * Columns a module works out, on records Core owns.
 *
 * A computed field — a deal's weighted value, the days since anybody last
 * spoke to a contact — is worthless on a screen of its own. It is a column,
 * and the place somebody looks at their records is the list. The module that
 * defines one cannot put it there: the contact, company and deal lists are
 * built by one factory in Core, and the modules that would contribute to it
 * live in other repositories Core must never name.
 *
 * So the same shape as `registerSummary` and `registerPersonalData`: a module
 * says what it can add to an entity's rows, and Core asks whatever this
 * instance loaded. Nothing registered — a Free instance — is not an empty
 * column, it is no change to the response at all.
 *
 * ## One call per list, never one per row
 *
 * `load` is handed the whole page and answers for the whole page. That is the
 * contract, and it is the only thing standing between this and a list of two
 * hundred rows issuing two hundred queries: a provider written to take one
 * record would be called two hundred times, and each of those calls would be
 * somebody's idea of "just one small lookup". A provider whose values come off
 * columns already on the row — which is what a computed field is — issues no
 * query at all.
 *
 * ## Worked out on read
 *
 * Nothing here is stored. A column counting days is wrong from the first
 * midnight if it is cached, and a nightly job to fix that is a second
 * implementation of the same arithmetic.
 */

/** What a computed column is called, and how a screen should draw it. */
export interface ComputedColumn {
  /** Unique within the provider; the key its values arrive under. */
  key: string;
  label: string;
  /**
   * `money` is integer cents, like every other figure crossing this boundary.
   * `whole` is a count, `days` a number of days, `text` anything else.
   */
  kind?: "money" | "whole" | "days" | "text";
}

/** One column's answer for one record. */
export interface ComputedValue {
  value: number | string | null;
  /**
   * Why there is no value, in words for a screen.
   *
   * Present only when `value` is null. A column that cannot be worked out for
   * one record says so beside that record — an empty cell reads exactly like a
   * number somebody forgot to fill in.
   */
  reason?: string;
}

export interface ComputedColumns {
  /** Unique across modules; the module id is a good prefix. */
  id: string;
  /**
   * Which records these belong to, in the singular word the platform uses for
   * them: "contact", "company", "deal".
   */
  entity: string;
  /**
   * Every column, for a whole page of records, in one call.
   *
   * Given the rows Core has already loaded and scoped to the organization —
   * which is what keeps a computed column inside one business's data, since
   * the rows handed over are the whole of what it can see.
   */
  load: (
    organizationId: string,
    rows: readonly Record<string, unknown>[],
  ) => Promise<{
    columns: ComputedColumn[];
    /** By row id. A row absent from this simply has no computed values. */
    values: Record<string, Record<string, ComputedValue>>;
  }>;
}

export interface RegisteredComputedColumns extends ComputedColumns {
  moduleId: string;
}

const registry: RegisteredComputedColumns[] = [];

export function addComputedColumns(provider: RegisteredComputedColumns): void {
  const at = registry.findIndex((p) => p.id === provider.id);
  // Replaced rather than appended, like every other registry here: a module
  // registered twice — which the boot tests do — must not answer twice.
  if (at >= 0) registry[at] = provider;
  else registry.push(provider);
}

export function computedColumnsFor(
  entity: string,
): RegisteredComputedColumns[] {
  return registry.filter((p) => p.entity === entity);
}

/** For tests, and for a host that loads its modules more than once. */
export function clearComputedColumns(): void {
  registry.length = 0;
}

/**
 * The rows a list is about to return, with whatever this instance computes.
 *
 * Returns the rows untouched and no columns when nothing is registered, which
 * is the Free case and has to be indistinguishable from the list as it was.
 *
 * A provider that throws is dropped and the list is served without it. The
 * alternative is a list screen that goes blank because one business defined
 * one bad column, which is a far worse failure than a missing one — and a
 * provider that can answer for some records and not others reports that per
 * record, with a reason, rather than by throwing.
 */
export async function withComputedColumns(
  entity: string,
  organizationId: string,
  rows: Record<string, unknown>[],
): Promise<{
  rows: Record<string, unknown>[];
  columns?: ComputedColumn[];
}> {
  const providers = computedColumnsFor(entity);
  if (providers.length === 0 || rows.length === 0) return { rows };

  const columns: ComputedColumn[] = [];
  const values = new Map<string, Record<string, ComputedValue>>();

  for (const provider of providers) {
    try {
      const answered = await provider.load(organizationId, rows);
      for (const column of answered.columns ?? []) columns.push(column);
      for (const [id, cells] of Object.entries(answered.values ?? {})) {
        values.set(id, { ...values.get(id), ...cells });
      }
    } catch (err) {
      console.error(
        `[computed] ${provider.moduleId}:${provider.id} could not answer for ${entity}`,
        err,
      );
    }
  }

  if (columns.length === 0) return { rows };
  return {
    rows: rows.map((row) => ({
      ...row,
      computed: values.get(String(row.id)) ?? {},
    })),
    columns,
  };
}
