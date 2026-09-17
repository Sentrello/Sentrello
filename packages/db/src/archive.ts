import { createHash } from "node:crypto";
import { readZip, writeZip } from "@sentrello/module-sdk";
import type { SQL } from "drizzle-orm";
import { db } from "./client";
import { closedThrough, postJournalEntry } from "./ledger";
import { centsFromDriver } from "./money";
import { sql } from "./orm";

/**
 * Taking old data off a business's own server without losing it.
 *
 * A self-hosted instance fills up. The only answer we had was a bigger disk,
 * and the only answer most software has is a delete button — which is the one
 * thing a business asked for its records back cannot survive. So: write the
 * rows out in a format anybody can read, prove the file is readable *from
 * where it was written*, and only then remove what it holds.
 *
 * The order is the whole feature. Every function here is arranged so that
 * nothing local is deleted until an archive has been read back and matched,
 * and so that a failure anywhere before that point leaves the database exactly
 * as it was. A business that archives 2019, finds the file corrupt, and has
 * already lost 2019 has not been helped — it has been robbed, by us.
 *
 * ## What this is not
 *
 * It is not a backup. A backup is everything, taken often, restored whole
 * after a disaster; this is one period of one kind of record, taken once,
 * removed on purpose. An instance still needs backups and the self-hosting
 * guide still says so.
 *
 * ## Generic on purpose
 *
 * The engine speaks table and column *names* and moves rows as `jsonb`, rather
 * than being written once per table against the ORM's types. A module in
 * another repository — Shop's old orders, Booking's old appointments — should
 * be able to declare a set and get the verification, the statutory floor, the
 * orphan check and the round trip without reimplementing any of it. Writing it
 * per-table is how the third module ends up with a version that skips the
 * verify step.
 */

// ---------------------------------------------------------------------------
// The statutory floor
// ---------------------------------------------------------------------------

/**
 * How many years of records a business has to be able to produce, by the
 * country it says it trades from.
 *
 * This is a floor on **deletion**, never on export: a business may take a copy
 * of anything at any time, and often should. What it may not do is use us to
 * destroy the local copy of something a tax authority can still ask for.
 *
 * The numbers are deliberately the long end of each range. Where a country's
 * rule is "six years from the end of the accounting period it relates to" and
 * we are measuring from a document's own date, six years measured our way is
 * the shorter span — so a floor that is a little too generous is the only kind
 * worth having. The cost of being a year over is a year of disk; the cost of
 * being a month under is a business that cannot answer an audit.
 *
 * Only our four markets are listed, because they are the only ones this
 * product is built for. Anything else — and an instance that has not said
 * where it trades — gets the longest floor we know of rather than the
 * shortest, for the same reason.
 */
export const RETENTION_YEARS: Record<string, number> = {
  // HMRC: six years from the end of the accounting period.
  GB: 6,
  // CRA: six years from the end of the last tax year the records relate to.
  CA: 6,
  /*
   * The IRS's general period is three years and runs to seven in the cases a
   * small business is most likely to meet — a bad-debt deduction, an
   * understatement, employment taxes — and several states are longer again.
   * Seven is the number an American accountant will tell a micro-business, and
   * it is the one we hold them to.
   */
  US: 7,
  // The EU, where member states run from seven to ten and Germany, Austria and
  // the Netherlands are at the long end. One number for the union, and it is
  // the long one.
  AT: 10,
  BE: 10,
  BG: 10,
  HR: 10,
  CY: 10,
  CZ: 10,
  DK: 10,
  EE: 10,
  FI: 10,
  FR: 10,
  DE: 10,
  GR: 10,
  HU: 10,
  IE: 10,
  IT: 10,
  LV: 10,
  LT: 10,
  LU: 10,
  MT: 10,
  NL: 10,
  PL: 10,
  PT: 10,
  RO: 10,
  SK: 10,
  SI: 10,
  ES: 10,
  SE: 10,
};

/** What an instance that has not said where it trades is held to. */
export const DEFAULT_RETENTION_YEARS = 10;

export function retentionYears(countryCode: string | null | undefined): number {
  if (!countryCode) return DEFAULT_RETENTION_YEARS;
  return (
    RETENTION_YEARS[countryCode.trim().toUpperCase()] ?? DEFAULT_RETENTION_YEARS
  );
}

/**
 * The most recent day whose records may be deleted, for this country.
 *
 * Anything dated after this is inside the window and stays, however old the
 * business thinks it is.
 */
export function retentionCutoff(
  countryCode: string | null | undefined,
  now: Date = new Date(),
): Date {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - retentionYears(countryCode));
  return cutoff;
}

// ---------------------------------------------------------------------------
// What can be archived
// ---------------------------------------------------------------------------

/**
 * One table in a set.
 *
 * A **root** has an organization column and a date column, and its rows are
 * chosen by the period. A **child** has neither and follows its parent — an
 * invoice's lines go wherever the invoice goes. Every child's chain ends at a
 * root, which is what makes the organization filter reach every row in the
 * archive; `archive.test.ts` asserts it rather than trusting the declarations.
 */
export interface ArchiveTable {
  /** The table's name in Postgres. */
  name: string;
  /**
   * What this entry is called within the set, where the table appears twice.
   *
   * `document_taxes` holds the tax of both invoices and quotes, told apart by
   * `document_type`, so the set names it once per parent. Everything the
   * manifest, the member filenames and the row counts are keyed by is this;
   * `name` is only ever the table the SQL touches.
   */
  key?: string;
  /**
   * The column names other tables use when they mean a row of this one.
   *
   * Declared because the convention does not hold: a row of `journal_entries`
   * is pointed at by `entry_id`, and one of `record_events` by `event_id`.
   * `archive-references.test.ts` sweeps the schema for these names and fails
   * if one turns up somewhere this set has not accounted for — which is how a
   * table added next year cannot quietly become the reference an archive
   * breaks.
   */
  pointedAtBy?: string[];
  /** The column holding the organization, where the table has one. */
  org?: string;
  /** The date this table's rows are chosen by. Roots only. */
  date?: string;
  /** For a child: whose id it carries, and in which column. */
  follows?: { parent: string; column: string };
  /**
   * An extra condition, for a table shared between two kinds of parent.
   * `document_taxes` holds both invoices' and quotes' tax, told apart by
   * `document_type`.
   */
  only?: { column: string; value: string };
}

/** Something outside a table that names its rows. */
export interface ArchiveReference {
  /** The table doing the pointing. */
  from: string;
  /** The column that holds the id. */
  column: string;
  /** The table it points at. */
  to: string;
  /** Shown to the operator when this is what blocks a deletion. */
  describedAs: string;
}

export interface ArchiveSet {
  id: string;
  label: string;
  description: string;
  tables: ArchiveTable[];
  references: ArchiveReference[];
  /**
   * Whether the statutory floor applies to deleting this.
   *
   * True for anything a tax authority can ask for. False for operational
   * history — a webhook delivery log is not a business record, and a rule that
   * treated it as one would leave the one table that actually fills the disk
   * untouchable for a decade.
   */
  statutory: boolean;
  /** Refuse to delete unless the books are closed through the whole period. */
  requiresClosedBooks?: boolean;
  /**
   * Post a summary in place of what is removed, so the reports do not move.
   * Only the ledger needs it, and `carryForward` below is the whole of it.
   */
  carriesForward?: boolean;
}

/**
 * The sets this repository ships.
 *
 * Three, chosen so that between them they cover both the table that actually
 * fills a micro-business's disk and the two hard cases — a statutory record,
 * and one that reports are read from. A module elsewhere adds its own by
 * calling `registerArchiveSet`; Shop's closed orders and Booking's past
 * appointments are the obvious next two and need nothing here to change.
 */
const CORE_SETS: ArchiveSet[] = [
  {
    id: "activity",
    label: "Change history and webhook deliveries",
    description:
      "Every field that changed on every record, and every webhook we sent about it. Nothing reads it but the audit screens and the automations, and it is almost always the largest thing on the disk.",
    statutory: false,
    tables: [
      {
        name: "record_events",
        org: "organization_id",
        date: "at",
        pointedAtBy: ["event_id"],
      },
      {
        name: "crm_webhook_deliveries",
        org: "organization_id",
        date: "created_at",
      },
      { name: "reminder_log", org: "organization_id", date: "sent_at" },
    ],
    references: [
      {
        from: "crm_webhook_deliveries",
        column: "event_id",
        to: "record_events",
        describedAs: "a webhook delivery still carries it",
      },
    ],
  },
  {
    id: "documents",
    label: "Invoices, credit notes, quotes and payments",
    description:
      "The documents themselves, their lines, their tax and the payments against them. A statutory record: it can be exported whenever you like, and removed only once it is out of the retention window your country sets.",
    statutory: true,
    tables: [
      { name: "invoices", org: "organization_id", date: "issue_date" },
      {
        name: "invoice_lines",
        follows: { parent: "invoices", column: "invoice_id" },
      },
      {
        name: "payments",
        org: "organization_id",
        follows: { parent: "invoices", column: "invoice_id" },
      },
      {
        name: "document_taxes",
        org: "organization_id",
        follows: { parent: "invoices", column: "document_id" },
        only: { column: "document_type", value: "invoice" },
      },
      { name: "quotes", org: "organization_id", date: "issue_date" },
      {
        name: "document_taxes",
        key: "document_taxes_quote",
        org: "organization_id",
        follows: { parent: "quotes", column: "document_id" },
        only: { column: "document_type", value: "quote" },
      },
      {
        name: "quote_lines",
        follows: { parent: "quotes", column: "quote_id" },
      },
      {
        name: "quote_instalments",
        follows: { parent: "quotes", column: "quote_id" },
      },
    ],
    references: [
      {
        from: "invoices",
        column: "reference_invoice_id",
        to: "invoices",
        describedAs: "a later credit note or re-issue still refers to it",
      },
      {
        from: "invoices",
        column: "quote_id",
        to: "quotes",
        describedAs: "an invoice raised from it is still here",
      },
      {
        from: "customer_credits",
        column: "invoice_id",
        to: "invoices",
        describedAs: "a customer's credit balance still refers to it",
      },
      {
        from: "customer_credits",
        column: "payment_id",
        to: "payments",
        describedAs: "a customer's credit balance came out of it",
      },
      {
        from: "reminder_log",
        column: "invoice_id",
        to: "invoices",
        describedAs: "a chasing reminder was logged against it",
      },
      {
        from: "recurring_periods",
        column: "invoice_id",
        to: "invoices",
        describedAs: "a repeating invoice's schedule still points at it",
      },
      {
        from: "quote_instalments",
        column: "invoice_id",
        to: "invoices",
        describedAs: "a quote's instalment was billed by it",
      },
      {
        from: "form_submissions",
        column: "quote_id",
        to: "quotes",
        describedAs: "a form somebody filled in produced it",
      },
    ],
  },
  {
    id: "ledger",
    label: "A closed period's journal",
    description:
      "The journal entries and lines of a period that is closed and out of the retention window. What is removed is replaced by one balanced summary per account per month, so every report over that period reads exactly as it did before.",
    statutory: true,
    requiresClosedBooks: true,
    carriesForward: true,
    tables: [
      {
        name: "journal_entries",
        org: "organization_id",
        date: "posted_at",
        pointedAtBy: ["entry_id"],
      },
      {
        name: "journal_lines",
        follows: { parent: "journal_entries", column: "entry_id" },
      },
    ],
    references: [
      {
        from: "bank_payments",
        column: "entry_id",
        to: "journal_entries",
        describedAs: "a payment out of the bank was posted by it",
      },
    ],
  },
];

const SETS = new Map(CORE_SETS.map((set) => [set.id, set]));

/** A module elsewhere declaring what of its own can be taken off the server. */
export function registerArchiveSet(set: ArchiveSet) {
  SETS.set(set.id, set);
}

export function archiveSets(): ArchiveSet[] {
  return [...SETS.values()];
}

export function archiveSet(id: string): ArchiveSet | undefined {
  return SETS.get(id);
}

export class ArchiveError extends Error {
  status = 400;
}

// ---------------------------------------------------------------------------
// Choosing the rows
// ---------------------------------------------------------------------------

const ident = (name: string) => sql.identifier(name);

/**
 * A list of ids as a Postgres array literal.
 *
 * Built out of individual placeholders rather than handed over as one value:
 * the driver has no column to infer a type from in a raw statement and sends a
 * JavaScript array as an anonymous record, which Postgres refuses to cast.
 */
const uuids = (ids: string[]): SQL =>
  sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )}]::uuid[]`;

/** What this entry is called inside its set. */
export const tableKey = (table: ArchiveTable): string =>
  table.key ?? table.name;

function tableOf(set: ArchiveSet, key: string): ArchiveTable {
  const found = set.tables.find((t) => tableKey(t) === key);
  if (!found) throw new ArchiveError(`${key} is not part of ${set.id}`);
  return found;
}

/**
 * The ids this table would contribute, as a subquery.
 *
 * Recursive through `follows`, so a child's rows are chosen by its parent's
 * and every chain ends at a root that carries the organization filter. Nothing
 * here ever selects across organizations, and there is no code path that could
 * — the root's filter is not optional.
 */
function chosenIds(
  set: ArchiveSet,
  table: ArchiveTable,
  orgId: string,
  from: Date,
  to: Date,
  /**
   * Rows this period would otherwise include and must not.
   *
   * The carry-forward summaries. They are posted inside the period they stand
   * for — they have to be, or every report over it would move — so a selection
   * written as "everything in this period" would sweep them straight back out
   * again, along with their lines. Excluded here rather than at the delete, so
   * that a child's selection inherits it through its parent: the lines belong
   * to an entry that is not being archived, and nothing downstream has to know
   * why.
   */
  exclude: string[] = [],
): SQL {
  const conditions: SQL[] = [];
  if (table.org) {
    conditions.push(sql`t.${ident(table.org)} = ${orgId}`);
  }
  if (table.date) {
    /*
     * Sent as text with an explicit cast, not as a Date. These are raw
     * statements rather than typed ORM queries, so the driver has no column
     * type to map a Date against and refuses it outright — which is the
     * failure to prefer, since the alternative would have been a date sent in
     * whatever the server's timezone happened to be.
     */
    conditions.push(
      sql`t.${ident(table.date)} >= ${from.toISOString()}::timestamp`,
    );
    conditions.push(
      sql`t.${ident(table.date)} <= ${to.toISOString()}::timestamp`,
    );
  }
  if (table.only) {
    conditions.push(sql`t.${ident(table.only.column)} = ${table.only.value}`);
  }
  if (table.follows) {
    const parent = tableOf(set, table.follows.parent);
    conditions.push(
      sql`t.${ident(table.follows.column)} in (${chosenIds(set, parent, orgId, from, to, exclude)})`,
    );
  }
  if (exclude.length > 0) {
    conditions.push(sql`t.id <> all(${uuids(exclude)})`);
  }
  if (!table.org && !table.follows) {
    // A table that is neither scoped nor descended from something that is
    // would archive every business on the instance. Unreachable through the
    // sets here and asserted against in the tests; refused anyway, because the
    // cost of being wrong is one business receiving another's records.
    throw new ArchiveError(`${table.name} is not scoped to an organization`);
  }
  return sql`select t.id from ${ident(table.name)} t where ${sql.join(conditions, sql` and `)}`;
}

async function countRows(
  set: ArchiveSet,
  table: ArchiveTable,
  orgId: string,
  from: Date,
  to: Date,
): Promise<number> {
  const rows = await db.execute(
    sql`select count(*)::int as n from (${chosenIds(set, table, orgId, from, to)}) ids`,
  );
  return Number((rows[0] as { n: number }).n);
}

// ---------------------------------------------------------------------------
// The plan, and what stands in the way of deleting
// ---------------------------------------------------------------------------

export interface ArchiveBlocker {
  kind: "statutory" | "open-books" | "reference" | "empty";
  message: string;
}

export interface ArchivePlan {
  set: ArchiveSet;
  organizationId: string;
  from: Date;
  to: Date;
  /** Rows per table, in the order the tables are declared. */
  counts: { table: string; rows: number }[];
  rows: number;
  /**
   * Why the local rows may not be removed. Empty means they may.
   *
   * Never a reason not to *write* the archive: exporting a copy is always
   * allowed, and a business inside its retention window that wants one off-site
   * should have one.
   */
  blockers: ArchiveBlocker[];
  retention: { years: number; countryCode: string | null; cutoff: Date };
}

async function organizationCountry(orgId: string): Promise<string | null> {
  const rows = await db.execute(
    sql`select country_code from ${ident("organizations")} where id = ${orgId} limit 1`,
  );
  const code = (rows[0] as { country_code?: string | null } | undefined)
    ?.country_code;
  return code ?? null;
}

async function organizationName(orgId: string): Promise<string> {
  const rows = await db.execute(
    sql`select name from ${ident("organizations")} where id = ${orgId} limit 1`,
  );
  return (rows[0] as { name?: string } | undefined)?.name ?? "";
}

export async function planArchive(
  orgId: string,
  setId: string,
  from: Date,
  to: Date,
  now: Date = new Date(),
): Promise<ArchivePlan> {
  const set = archiveSet(setId);
  if (!set) throw new ArchiveError(`there is no archive called "${setId}"`);
  if (!(from.getTime() <= to.getTime())) {
    throw new ArchiveError("the period ends before it starts");
  }

  const counts: { table: string; rows: number }[] = [];
  for (const table of set.tables) {
    counts.push({
      table: tableKey(table),
      rows: await countRows(set, table, orgId, from, to),
    });
  }
  const rows = counts.reduce((total, count) => total + count.rows, 0);

  const countryCode = await organizationCountry(orgId);
  const cutoff = retentionCutoff(countryCode, now);
  const blockers: ArchiveBlocker[] = [];

  if (rows === 0) {
    blockers.push({
      kind: "empty",
      message: "there is nothing in this period to archive",
    });
  }

  if (set.statutory && to.getTime() > cutoff.getTime()) {
    blockers.push({
      kind: "statutory",
      message: `records this recent have to be kept: ${
        countryCode ?? "an unstated country"
      } means ${retentionYears(countryCode)} years, so nothing dated after ${cutoff
        .toISOString()
        .slice(
          0,
          10,
        )} can be removed. You can still write the archive and keep the originals.`,
    });
  }

  if (set.requiresClosedBooks) {
    const closed = await closedThrough(orgId);
    if (!closed || closed.getTime() < to.getTime()) {
      blockers.push({
        kind: "open-books",
        message: closed
          ? `the books are only closed through ${closed.toISOString().slice(0, 10)}, and this period runs to ${to.toISOString().slice(0, 10)}`
          : "the books have never been closed, so no period of them is settled enough to archive",
      });
    }
  }

  for (const reference of set.references) {
    const target = set.tables.find((t) => tableKey(t) === reference.to);
    if (!target) continue;
    const chosen = chosenIds(set, target, orgId, from, to);
    const inSet = set.tables.find((t) => t.name === reference.from && !t.only);
    /*
     * A row that is itself being archived is not a dangling reference — it is
     * leaving with what it points at. Everything else is, and the archive is
     * refused rather than being allowed to take away the contact an open
     * invoice names.
     */
    const surviving = inSet
      ? sql` and r.id not in (${chosenIds(set, inSet, orgId, from, to)})`
      : sql``;
    const rows = await db.execute(sql`
      select count(*)::int as n
      from ${ident(reference.from)} r
      where r.${ident(reference.column)} in (${chosen})${surviving}
    `);
    const held = Number((rows[0] as { n: number }).n);
    if (held > 0) {
      blockers.push({
        kind: "reference",
        message: `${held} row${held === 1 ? "" : "s"} outside this period still point at it — ${reference.describedAs}`,
      });
    }
  }

  return {
    set,
    organizationId: orgId,
    from,
    to,
    counts,
    rows,
    blockers,
    retention: { years: retentionYears(countryCode), countryCode, cutoff },
  };
}

// ---------------------------------------------------------------------------
// Writing it
// ---------------------------------------------------------------------------

/** How many rows go in one member of the zip.
 *
 * Both writing and reading hold one member at a time, so this is the ceiling on
 * what the feature costs in memory however many years are being archived. Two
 * thousand rows of the widest table we archive is a few megabytes. */
const ROWS_PER_MEMBER = 2_000;

export const ARCHIVE_FORMAT = "sentrello-archive";
export const ARCHIVE_FORMAT_VERSION = 1;

export interface ArchiveMemberRecord {
  name: string;
  table: string;
  rows: number;
  bytes: number;
  sha256: string;
}

export interface ArchiveManifest {
  format: string;
  formatVersion: number;
  /** Stable for the life of the archive, and what a carry-forward names. */
  archiveId: string;
  writtenBy: string;
  writtenAt: string;
  organizationId: string;
  organizationName: string;
  set: string;
  setLabel: string;
  period: { from: string; to: string };
  tables: { name: string; rows: number }[];
  members: ArchiveMemberRecord[];
  rows: number;
}

const README = `This is a Sentrello archive.

It is an ordinary zip file. Open it however you open a zip.

  manifest.json   what is inside, which business, which period, which version
                  wrote it, and a SHA-256 of every other file here.
  data/*.jsonl    the records. One JSON object per line, one file per table,
                  numbered where a table needed more than one. Open them in any
                  text editor, or read them with any programming language; every
                  field carries the name the database used.

Nothing here needs Sentrello to read. If you still run it, the Archive screen
will take this file back and put the records where they were.

Money is whole cents, as an integer: 1234 is 12.34. Tax rates are millionths:
99750 is 9.975%. Dates are UTC, in the format 2019-03-31T00:00:00.000Z.
`;

async function* pageRows(
  set: ArchiveSet,
  table: ArchiveTable,
  orgId: string,
  from: Date,
  to: Date,
): AsyncGenerator<Record<string, unknown>[]> {
  let after: string | null = null;
  for (;;) {
    const chosen = chosenIds(set, table, orgId, from, to);
    const rows = (await db.execute(sql`
      select to_jsonb(row) as row, row.id as id
      from ${ident(table.name)} row
      where row.id in (${chosen})
        ${after ? sql`and row.id > ${after}` : sql``}
      order by row.id
      limit ${ROWS_PER_MEMBER}
    `)) as unknown as { row: Record<string, unknown>; id: string }[];
    if (rows.length === 0) return;
    yield rows.map((r) => r.row);
    after = rows[rows.length - 1]?.id ?? null;
    if (rows.length < ROWS_PER_MEMBER) return;
  }
}

/**
 * The archive, as bytes, a piece at a time.
 *
 * Nothing is deleted here and nothing can be: this function only reads. The
 * manifest goes last because it states a checksum of every other member and
 * cannot be written until they have been.
 */
export async function* writeArchive(
  plan: ArchivePlan,
  archiveId: string = crypto.randomUUID(),
): AsyncGenerator<Uint8Array> {
  const members: ArchiveMemberRecord[] = [];
  const encoder = new TextEncoder();

  const set = plan.set;
  async function* content() {
    yield { name: "README.txt", bytes: encoder.encode(README) };

    for (const table of set.tables) {
      let part = 0;
      for await (const page of pageRows(
        set,
        table,
        plan.organizationId,
        plan.from,
        plan.to,
      )) {
        part += 1;
        const name = `data/${tableKey(table)}-${String(part).padStart(4, "0")}.jsonl`;
        const bytes = encoder.encode(
          `${page.map((row) => JSON.stringify(row)).join("\n")}\n`,
        );
        members.push({
          name,
          table: tableKey(table),
          rows: page.length,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
        yield { name, bytes };
      }
    }

    const manifest: ArchiveManifest = {
      format: ARCHIVE_FORMAT,
      formatVersion: ARCHIVE_FORMAT_VERSION,
      archiveId,
      writtenBy: `Sentrello ${process.env.SENTRELLO_VERSION ?? "unknown"}`,
      writtenAt: new Date().toISOString(),
      organizationId: plan.organizationId,
      organizationName: await organizationName(plan.organizationId),
      set: set.id,
      setLabel: set.label,
      period: { from: plan.from.toISOString(), to: plan.to.toISOString() },
      tables: plan.counts.map((c) => ({ name: c.table, rows: c.rows })),
      members,
      rows: plan.rows,
    };
    yield {
      name: "manifest.json",
      bytes: encoder.encode(JSON.stringify(manifest, null, 2)),
    };
  }

  yield* writeZip(content());
}

// ---------------------------------------------------------------------------
// Proving it before anything is removed
// ---------------------------------------------------------------------------

export class VerificationFailed extends Error {
  status = 409;
}

export interface Verification {
  manifest: ArchiveManifest;
  /** Rows actually found in the archive, per table. */
  counts: Record<string, number>;
}

/**
 * Read an archive back and say whether it is what it claims to be.
 *
 * Handed a stream, because the thing being checked is the copy at the
 * destination rather than the bytes we still have in hand. Verifying the buffer
 * we just wrote would prove that memory is memory — the question is whether
 * what landed can be read, and the only way to answer it is to read it from
 * there.
 *
 * Three claims are checked, and every one of them has to hold:
 *
 *  - each member unpacks and matches the CRC in its own zip header (the reader
 *    does that, and throws before a member is ever handed over);
 *  - each member's bytes match the SHA-256 the manifest states;
 *  - the row counts add up, per table, to what the manifest says.
 *
 * `expected` is the plan's own counts, passed when this is being run against an
 * archive we have just written. A manifest that agrees with itself but not with
 * the database would otherwise pass.
 */
export async function verifyArchive(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  expected?: { table: string; rows: number }[],
): Promise<Verification> {
  const seen = new Map<
    string,
    { sha256: string; rows: number; bytes: number }
  >();
  const counts: Record<string, number> = {};
  let manifest: ArchiveManifest | null = null;

  for await (const member of readZip(source)) {
    const sha256 = createHash("sha256").update(member.bytes).digest("hex");
    if (member.name === "manifest.json") {
      manifest = JSON.parse(
        new TextDecoder().decode(member.bytes),
      ) as ArchiveManifest;
      continue;
    }
    if (!member.name.startsWith("data/")) continue;
    // A trailing newline means the last split is empty; the rows are the rest.
    const text = new TextDecoder().decode(member.bytes);
    const rows = text.split("\n").filter((line) => line.length > 0).length;
    seen.set(member.name, { sha256, rows, bytes: member.bytes.length });
  }

  if (!manifest) {
    throw new VerificationFailed(
      "the archive has no manifest — it is not one of ours, or it did not arrive whole",
    );
  }
  if (manifest.format !== ARCHIVE_FORMAT) {
    throw new VerificationFailed("that file is not a Sentrello archive");
  }
  if (manifest.formatVersion > ARCHIVE_FORMAT_VERSION) {
    throw new VerificationFailed(
      `that archive was written by a later version of Sentrello (format ${manifest.formatVersion})`,
    );
  }

  for (const declared of manifest.members) {
    const found = seen.get(declared.name);
    if (!found) {
      throw new VerificationFailed(
        `${declared.name} is missing from the archive`,
      );
    }
    if (found.sha256 !== declared.sha256) {
      throw new VerificationFailed(
        `${declared.name} does not match the checksum the manifest states`,
      );
    }
    if (found.rows !== declared.rows) {
      throw new VerificationFailed(
        `${declared.name} holds ${found.rows} records and the manifest says ${declared.rows}`,
      );
    }
    counts[declared.table] = (counts[declared.table] ?? 0) + found.rows;
    seen.delete(declared.name);
  }
  if (seen.size > 0) {
    throw new VerificationFailed(
      `the archive holds ${[...seen.keys()].join(", ")}, which its manifest does not mention`,
    );
  }

  for (const table of manifest.tables) {
    if ((counts[table.name] ?? 0) !== table.rows) {
      throw new VerificationFailed(
        `the archive holds ${counts[table.name] ?? 0} rows of ${table.name} and says it holds ${table.rows}`,
      );
    }
  }

  for (const { table, rows } of expected ?? []) {
    if ((counts[table] ?? 0) !== rows) {
      throw new VerificationFailed(
        `${table} has ${rows} rows here and ${counts[table] ?? 0} reached the archive`,
      );
    }
  }

  return { manifest, counts };
}

// ---------------------------------------------------------------------------
// Carrying a closed period forward
// ---------------------------------------------------------------------------

interface Summary {
  month: string;
  accountId: string;
  classId: string | null;
  locationId: string | null;
  net: number;
}

/**
 * One balanced entry per month, standing in for everything removed.
 *
 * This is what makes archiving a closed period safe to do at all. The detail
 * goes; the *figures* stay, per account, per class, per location, per calendar
 * month — so a profit and loss, a balance sheet or a trial balance over any
 * period that does not cut into a month reads exactly as it did before. The
 * accounting tests assert that rather than describing it.
 *
 * Whole months are the unit because a report boundary inside an archived month
 * has nothing left to answer with, which is why the routes refuse a period that
 * is not whole months. Per day would keep every boundary exact and save almost
 * nothing, which is the wrong trade for the one feature whose purpose is space.
 *
 * Nothing is unposted, reversed or voided. The original entries are removed
 * only after the archive holding them has been read back and matched, and each
 * summary is a new entry that balances on its own — the sum of the nets over a
 * month is zero because every entry that went into it balanced.
 */
async function carryForward(
  orgId: string,
  from: Date,
  to: Date,
  archiveId: string,
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
): Promise<string[]> {
  const rows = (await tx.execute(sql`
    select
      to_char(date_trunc('month', e.posted_at), 'YYYY-MM') as month,
      l.account_id as "accountId",
      l.class_id as "classId",
      l.location_id as "locationId",
      sum(l.debit_cents - l.credit_cents)::bigint as net
    from ${ident("journal_lines")} l
    join ${ident("journal_entries")} e on e.id = l.entry_id
    where e.organization_id = ${orgId}
      and e.posted_at >= ${from.toISOString()}::timestamp
      and e.posted_at <= ${to.toISOString()}::timestamp
    group by 1, 2, 3, 4
    having sum(l.debit_cents - l.credit_cents) <> 0
    order by 1, 2
  `)) as unknown as Summary[];

  const byMonth = new Map<string, Summary[]>();
  for (const row of rows) {
    const list = byMonth.get(row.month) ?? [];
    /*
     * `::bigint`, never `::int`: a month of a busy ledger can exceed
     * $21,474,836.47 on one account, and a 32-bit cast answers "integer out of
     * range" — which here would be an archive that cannot be written rather
     * than a screen that will not open. A 64-bit total arrives from the driver
     * as a string, and a string handed to `postJournalEntry` as a debit is a
     * worse failure than either, so it is converted here and checked.
     */
    list.push({ ...row, net: centsFromDriver(row.net) });
    byMonth.set(row.month, list);
  }

  const created: string[] = [];
  for (const [month, summaries] of [...byMonth.entries()].sort()) {
    const [year, m] = month.split("-").map(Number);
    // The last instant of the month, so the summary falls inside every period
    // that contained the detail it replaces and inside none that did not.
    const at = new Date(
      Date.UTC(year as number, m as number, 0, 23, 59, 59, 999),
    );
    const entry = await postJournalEntry(
      orgId,
      `Archived ${month} — summary of entries taken off this server`,
      `archive:${archiveId}`,
      summaries.map((s) => ({
        accountId: s.accountId,
        debitCents: s.net > 0 ? s.net : 0,
        creditCents: s.net < 0 ? -s.net : 0,
        classId: s.classId,
        locationId: s.locationId,
      })),
      at,
      // The one caller allowed through the period lock, and only because the
      // only periods it touches are closed ones — that is the precondition for
      // archiving a ledger at all.
      { intoClosedPeriod: true, tx },
    );
    created.push(entry.id);
  }
  return created;
}

// ---------------------------------------------------------------------------
// Removing what the archive holds
// ---------------------------------------------------------------------------

export interface Removal {
  counts: { table: string; rows: number }[];
  carriedForward: string[];
}

/**
 * Delete exactly what the archive was verified to hold, or nothing.
 *
 * One transaction, and every table's deleted count is compared against what the
 * verified archive says it holds. A row written into the period between the
 * export and this call would be deleted without ever having been archived —
 * so the counts disagreeing rolls the whole thing back rather than being
 * reported afterwards.
 *
 * Children go before their parents, and the carry-forward is posted before the
 * delete inside the same transaction, so a failure anywhere leaves the ledger
 * exactly as it was rather than holding a summary of entries that are still
 * there.
 */
export async function removeArchived(
  plan: ArchivePlan,
  verified: Verification,
): Promise<Removal> {
  if (plan.blockers.length > 0) {
    throw new ArchiveError(
      `this period may not be removed: ${plan.blockers.map((b) => b.message).join("; ")}`,
    );
  }
  if (verified.manifest.organizationId !== plan.organizationId) {
    throw new VerificationFailed("that archive belongs to another business");
  }

  const set = plan.set;
  // Deepest first: a child is chosen by its parent, so deleting the parent
  // first would leave the child unreachable and undeleted.
  const depth = (table: ArchiveTable): number =>
    table.follows ? 1 + depth(tableOf(set, table.follows.parent)) : 0;
  const order = [...set.tables].sort((a, b) => depth(b) - depth(a));

  const counts: { table: string; rows: number }[] = [];
  let carriedForward: string[] = [];

  await db.transaction(async (tx) => {
    if (set.carriesForward) {
      carriedForward = await carryForward(
        plan.organizationId,
        plan.from,
        plan.to,
        verified.manifest.archiveId,
        tx,
      );
    }

    for (const table of order) {
      /*
       * `id in (chosen)` rather than repeating the predicate: the summary
       * entries just posted sit inside the period, and a delete written as
       * "everything in this period" would take them straight back out again.
       * The subquery is evaluated against the rows as they are now, so it has
       * to exclude anything this transaction created.
       */
      const chosen = chosenIds(
        set,
        table,
        plan.organizationId,
        plan.from,
        plan.to,
        carriedForward,
      );
      const removed = await tx.execute(sql`
        delete from ${ident(table.name)}
        where id in (${chosen})
        returning 1 as one
      `);
      counts.push({ table: tableKey(table), rows: removed.length });
    }

    for (const { table, rows } of counts) {
      const archived = verified.counts[table] ?? 0;
      if (rows !== archived) {
        throw new VerificationFailed(
          `${rows} rows of ${table} were about to be removed and the archive holds ${archived} — nothing has been deleted`,
        );
      }
    }
  });

  return { counts, carriedForward };
}

// ---------------------------------------------------------------------------
// Getting it back
// ---------------------------------------------------------------------------

export interface Restoration {
  manifest: ArchiveManifest;
  inserted: { table: string; rows: number }[];
  /** Rows already present, left alone. */
  skipped: number;
  /** Summary entries removed because the detail they stood for came back. */
  summariesRemoved: number;
}

/**
 * Put an archive back into the live tables.
 *
 * **Back into the live tables, not into a read-only copy beside them.** An
 * archive holds the original primary keys, so re-inserting is exact and a
 * restored invoice is the invoice — it shows on the customer's account, it is
 * found by search, it appears in the reports. A read-only side copy would need
 * a second implementation of every screen that reads the real ones, and would
 * still not answer the question a business actually asks when it restores,
 * which is "show me what we had".
 *
 * Verified first, in a pass of its own, and only then inserted. The stream is
 * read twice deliberately: nothing should be written into a live table on the
 * strength of bytes that have not yet been checked.
 *
 * A row already present is left exactly as it is. Restoring twice changes
 * nothing, and an archive cannot overwrite a record somebody has edited since.
 */
export async function restoreArchive(
  orgId: string,
  open: () => AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<Restoration> {
  const verified = await verifyArchive(open());
  const manifest = verified.manifest;
  if (manifest.organizationId !== orgId) {
    // Not a technicality. The ids in the archive are that business's ids, and
    // writing them into this one's tables would be one customer's records
    // appearing inside another's.
    throw new ArchiveError(
      "that archive was written by a different business, and its records cannot be put into this one",
    );
  }

  const set = archiveSet(manifest.set);
  if (!set) {
    throw new ArchiveError(
      `that archive holds "${manifest.set}", which this instance does not know how to restore`,
    );
  }

  const inserted = new Map<string, number>();
  let rows = 0;
  let summariesRemoved = 0;

  await db.transaction(async (tx) => {
    for await (const member of readZip(open())) {
      if (!member.name.startsWith("data/")) continue;
      const declared = manifest.members.find((m) => m.name === member.name);
      if (!declared) continue;
      const table = set.tables.find((t) => tableKey(t) === declared.table);
      if (!table) {
        throw new ArchiveError(
          `this instance has no ${declared.table} to restore into`,
        );
      }
      const payload = new TextDecoder()
        .decode(member.bytes)
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      rows += payload.length;

      if (table.org) {
        for (const row of payload) {
          if (row[table.org] !== orgId) {
            throw new ArchiveError(
              "that archive holds records belonging to another business",
            );
          }
        }
      }

      const done = await tx.execute(sql`
        insert into ${ident(table.name)}
        select * from jsonb_populate_recordset(null::${ident(table.name)}, ${JSON.stringify(payload)}::jsonb)
        on conflict (id) do nothing
        returning 1 as one
      `);
      inserted.set(
        tableKey(table),
        (inserted.get(tableKey(table)) ?? 0) + done.length,
      );
    }

    /*
     * The summaries come out as the detail goes back in.
     *
     * They exist only so the reports do not move while the detail is away, and
     * leaving them would double every figure in the period — the one outcome
     * worse than the detail being missing.
     */
    if (set.carriesForward) {
      const summaries = (await tx.execute(sql`
        select id from ${ident("journal_entries")}
        where organization_id = ${orgId} and source = ${`archive:${manifest.archiveId}`}
      `)) as unknown as { id: string }[];
      if (summaries.length > 0) {
        const ids = summaries.map((s) => s.id);
        await tx.execute(sql`
          delete from ${ident("journal_lines")} where entry_id = any(${uuids(ids)})
        `);
        await tx.execute(sql`
          delete from ${ident("journal_entries")} where id = any(${uuids(ids)})
        `);
        summariesRemoved = summaries.length;
      }
    }
  });

  return {
    manifest,
    inserted: [...inserted.entries()].map(([table, count]) => ({
      table,
      rows: count,
    })),
    skipped: rows - [...inserted.values()].reduce((total, n) => total + n, 0),
    summariesRemoved,
  };
}
