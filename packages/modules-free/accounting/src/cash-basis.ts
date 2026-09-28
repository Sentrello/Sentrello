import {
  CORE_ACCOUNTS,
  type CashBasisEntry,
  type CashBasisLine,
  cashBasisEntries,
  isTaxPayableCode,
} from "@sentrello/db/ledger";
import type { LedgerRow } from "./reports";

/**
 * The same books, read as a cash-basis tax return reads them.
 *
 * On the accrual basis an invoice is income the day it is issued, whether or
 * not anybody ever pays. That is the honest answer to "how is the business
 * doing" and the wrong answer to "what did I actually take" — and a great many
 * small businesses in the markets this is sold into file on the cash basis, so
 * a product that can only produce one of the two sends its customer back to a
 * spreadsheet every April.
 *
 * **The conversion is not a filter.** An invoice raised in March and paid in
 * May is March's income on one basis and May's on the other, so a period's
 * cash-basis figures depend on entries outside that period entirely. This
 * walks the whole ledger in order, holding income that has been earned and not
 * yet received in a pool beside the receivable that represents it, and
 * recognising out of that pool as the receivable comes down. Payables and
 * expenses, the same way round.
 *
 * **It follows the control account, not the invoice.** That keeps this in the
 * ledger, where every other report in this module reads from. A version that
 * reached into the invoice and bill tables would answer a slightly different
 * question each time another module learned how to post.
 */

/**
 * The two control accounts, and the tax account, by code.
 *
 * Taken from the chart every module posts against rather than written out
 * again: `cashBasisEntries` narrows the read to these same three codes, and
 * two lists that have to agree and are kept apart eventually do not — the
 * symptom being a report that quietly stopped seeing invoices.
 */
const RECEIVABLE_CODE = CORE_ACCOUNTS.accountsReceivable.code;
const PAYABLE_CODE = CORE_ACCOUNTS.accountsPayable.code;

export interface CashBasisRow {
  /** The entry that recognised the amount — the settlement, not the invoice. */
  entryId: string;
  accountId: string;
  code: string;
  name: string;
  type: string;
  /** Positive in the direction the account is read, as elsewhere. */
  amountCents: number;
  postedAt: Date;
}

/**
 * What a receivable or payable was built out of, so it unwinds the same way.
 *
 * `outstandingCents` is the control account's own balance; `byAccount` is the
 * income or expense behind it. The two differ by tax — an invoice for 1200
 * carries 1000 of income and 200 of tax the business is collecting for
 * somebody else — which is why recognising a receipt means taking a share of
 * the pool rather than the whole of the receipt.
 */
interface Pool {
  outstandingCents: number;
  byAccount: Map<string, number>;
}

const emptyPool = (): Pool => ({ outstandingCents: 0, byAccount: new Map() });

type Entry = CashBasisEntry;

function entriesOf(rows: CashBasisLine[]): Entry[] {
  const byEntry = new Map<string, Entry>();
  for (const row of rows) {
    const found = byEntry.get(row.entryId);
    if (found) {
      found.rows.push(row);
      continue;
    }
    byEntry.set(row.entryId, {
      id: row.entryId,
      postedAt: row.postedAt,
      rows: [row],
    });
  }
  return [...byEntry.values()].sort((a, b) => {
    const order = a.postedAt.getTime() - b.postedAt.getTime();
    // Two entries on one instant need some order, and it has to be the same
    // order every run or one report quietly disagrees with the next.
    return order !== 0 ? order : a.id.localeCompare(b.id);
  });
}

/** In the direction the account type is read. */
function amountOf(row: CashBasisLine): number {
  return row.type === "income" ||
    row.type === "liability" ||
    row.type === "equity"
    ? row.creditCents - row.debitCents
    : row.debitCents - row.creditCents;
}

/**
 * The income and expense a period actually saw the money for, from rows
 * already in hand.
 *
 * Takes the business's whole history rather than the period's rows: money
 * received in June for work invoiced in March is June's, and June's entries
 * alone cannot say so. `cashBasisRowsFor` asks the database for the same walk
 * without holding the history; this is for a caller that has the rows anyway,
 * which since the routes moved across means the tests and nothing else.
 */
export function cashBasisRows(
  all: CashBasisLine[],
  period: { from?: Date; to?: Date } = {},
  /**
   * Where the VAT rows land, for the caller that wants them.
   *
   * The VAT on an invoice waits in the pool beside the income and comes out
   * with the same settlements — that is the whole of the cash accounting
   * scheme — but a profit and loss has no use for it, and pushing it into the
   * main output would change what every existing reader of this function
   * sees. So it goes to a collector the VAT return passes and nobody else
   * does, and the income figures stay bit-for-bit what they were.
   */
  vatOut?: CashBasisRow[],
): CashBasisRow[] {
  const walk = cashBasisWalk(period, vatOut);
  for (const entry of entriesOf(all)) walk.take(entry);
  return walk.rows;
}

/**
 * The same figures, one entry at a time, without the history in memory.
 *
 * The walk is unavoidable — what a period recognises depends on every
 * settlement before it, which is not a question a `group by` can answer — so
 * what is bounded is the reading of it: only the lines a cash-basis read can
 * see, nothing posted after the period, and before it only the entries that
 * left a receivable or a payable behind. `cashBasisEntries` is where that is
 * written down and measured.
 *
 * Identical arithmetic to the array above, entry for entry, because it is the
 * same code: both hand entries to the same walk in the same order.
 */
export async function cashBasisRowsFor(
  orgId: string,
  period: { from?: Date; to?: Date } = {},
  vatOut?: CashBasisRow[],
): Promise<CashBasisRow[]> {
  const walk = cashBasisWalk(period, vatOut);
  const entries = cashBasisEntries(orgId, period, { tax: Boolean(vatOut) });
  for await (const entry of entries) walk.take(entry);
  return walk.rows;
}

/**
 * The conversion, as a thing that can be fed one entry at a time.
 *
 * Everything that has to survive between entries lives here: what is owed and
 * unrecognised, and what each account is called. Entries arrive oldest first
 * and are never revisited, which is what lets the caller stream them.
 */
function cashBasisWalk(
  period: { from?: Date; to?: Date },
  vatOut?: CashBasisRow[],
) {
  /**
   * What each account is called, learned as the ledger is read.
   *
   * An amount recognised in June belongs to an account named on an entry in
   * March, and the June entry does not carry the name. Held here rather than
   * in the module, so two businesses reported on in one process cannot end up
   * reading each other's account names.
   */
  const names = new Map<string, CashBasisLine>();

  const receivable = emptyPool();
  const payable = emptyPool();
  /**
   * The VAT waiting beside each pool, held apart from the income and expense.
   *
   * Separate pools rather than more entries in `byAccount`, so the shares the
   * income arithmetic hands out are untouched by whether anybody asked for
   * VAT: the same books must produce the same profit and loss either way.
   * Their outstanding figures move in step with the main pools' — the same
   * receivable is over both.
   */
  const receivableVat = emptyPool();
  const payableVat = emptyPool();
  const out: CashBasisRow[] = [];

  const inPeriod = (at: Date) =>
    (!period.from || at >= period.from) && (!period.to || at <= period.to);

  const push = (
    to: CashBasisRow[],
    accountId: string,
    amountCents: number,
    entry: Entry,
  ) => {
    if (amountCents === 0 || !inPeriod(entry.postedAt)) return;
    const named = names.get(accountId);
    if (!named) return;
    to.push({
      entryId: entry.id,
      accountId,
      code: named.code,
      name: named.name,
      type: named.type,
      amountCents,
      postedAt: entry.postedAt,
    });
  };

  const emit = (accountId: string, amountCents: number, entry: Entry) =>
    push(out, accountId, amountCents, entry);
  /** Credit-positive, the direction a liability is read. */
  const emitVat = (accountId: string, amountCents: number, entry: Entry) => {
    if (vatOut) push(vatOut, accountId, amountCents, entry);
  };

  const take = (entry: Entry) => {
    /*
     * The names this entry teaches, before anything is emitted.
     *
     * An account is only ever emitted from an entry that named it or from a
     * pool an earlier entry filled, so by the time a figure needs a name the
     * name has been seen.
     */
    for (const row of entry.rows) names.set(row.accountId, row);

    const controlDelta = (code: string) =>
      entry.rows
        .filter((row) => row.code === code)
        .reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);

    // A receivable grows on the debit side; a payable on the credit side.
    const arDelta = controlDelta(RECEIVABLE_CODE);
    const apDelta = -controlDelta(PAYABLE_CODE);

    const income = entry.rows.filter((row) => row.type === "income");
    const expense = entry.rows.filter((row) => row.type === "expense");
    // The shared tax account and every authority's own: a document carrying
    // two named taxes posts to "2200-<definition>", and matching the bare
    // code left that VAT out of the cash-basis return entirely.
    const vat = entry.rows.filter((row) => isTaxPayableCode(row.code));
    const incomeDelta = income.reduce((sum, row) => sum + amountOf(row), 0);
    const expenseDelta = expense.reduce((sum, row) => sum + amountOf(row), 0);
    /** Credit-positive: VAT charged on a sale, negative when reclaimable. */
    const vatDelta = vat.reduce(
      (sum, row) => sum + row.creditCents - row.debitCents,
      0,
    );

    if (arDelta > 0) {
      // An invoice: not income yet. Into the pool with the receivable it made.
      receivable.outstandingCents += arDelta;
      receivableVat.outstandingCents += arDelta;
      for (const row of income) {
        add(receivable.byAccount, row.accountId, amountOf(row));
      }
      for (const row of vat) {
        add(
          receivableVat.byAccount,
          row.accountId,
          row.creditCents - row.debitCents,
        );
      }
    } else if (arDelta < 0 && incomeDelta < 0) {
      /**
       * A credit note: the debt goes away and so does the income behind it.
       *
       * Taken back out of the pool rather than recognised, because nobody paid
       * anything — the invoice was cancelled. What the pool cannot absorb is a
       * credit against an invoice already paid for, and that is a real
       * reduction of income on the day it happened.
       */
      const unabsorbed = giveBack(receivable, -arDelta, -incomeDelta);
      for (const row of income) {
        const share = shareOf(amountOf(row), incomeDelta, -unabsorbed);
        emit(row.accountId, share, entry);
      }
      // The VAT on the credit note unwinds the same way: out of the pool
      // where the invoice was unpaid, a real reduction where it was not.
      const vatBack = giveBack(receivableVat, -arDelta, -vatDelta);
      for (const row of vat) {
        emitVat(
          row.accountId,
          shareOf(row.creditCents - row.debitCents, vatDelta, -vatBack),
          entry,
        );
      }
    } else if (arDelta < 0) {
      // Paid, or written off. Either way it is recognised now.
      for (const [accountId, amountCents] of drawDown(receivable, -arDelta)) {
        emit(accountId, amountCents, entry);
      }
      for (const [accountId, amountCents] of drawDown(
        receivableVat,
        -arDelta,
      )) {
        emitVat(accountId, amountCents, entry);
      }
    }

    if (apDelta > 0) {
      payable.outstandingCents += apDelta;
      payableVat.outstandingCents += apDelta;
      for (const row of expense) {
        add(payable.byAccount, row.accountId, amountOf(row));
      }
      // Unless an entry somehow grew both control accounts, in which case the
      // receivable's pool already claimed the VAT rows above.
      if (arDelta <= 0) {
        for (const row of vat) {
          add(
            payableVat.byAccount,
            row.accountId,
            row.debitCents - row.creditCents,
          );
        }
      }
    } else if (apDelta < 0 && expenseDelta < 0) {
      const unabsorbed = giveBack(payable, -apDelta, -expenseDelta);
      for (const row of expense) {
        const share = shareOf(amountOf(row), expenseDelta, -unabsorbed);
        emit(row.accountId, share, entry);
      }
      const vatBack = giveBack(payableVat, -apDelta, vatDelta);
      for (const row of vat) {
        // The payable pool is read debit-positive; the emission is
        // credit-positive like every other VAT row, hence the sign.
        emitVat(
          row.accountId,
          -shareOf(row.debitCents - row.creditCents, -vatDelta, -vatBack),
          entry,
        );
      }
    } else if (apDelta < 0) {
      for (const [accountId, amountCents] of drawDown(payable, -apDelta)) {
        emit(accountId, amountCents, entry);
      }
      // Reclaimable now the supplier is paid: the debit side, so negative.
      for (const [accountId, amountCents] of drawDown(payableVat, -apDelta)) {
        emitVat(accountId, -amountCents, entry);
      }
    }

    /**
     * Every line neither control account claimed.
     *
     * A card sale, a bank fee, a statement line a rule categorised: the money
     * moved as the entry was posted, so both bases agree and there is nothing
     * to defer. So does an expense sitting inside a settlement entry — the
     * write-off that made a debt disappear, or the discount taken off a
     * payment — which is real on the day it happened and was nobody's
     * receivable.
     *
     * Depreciation is deliberately among these. It is an expense with no cash
     * behind it, and every regime this is sold into allows it on a cash-basis
     * return — leaving it out would understate the expenses of any business
     * that owns a van.
     */
    if (arDelta === 0) {
      for (const row of income) emit(row.accountId, amountOf(row), entry);
    }
    if (apDelta === 0 && !(arDelta < 0 && expenseDelta < 0)) {
      for (const row of expense) {
        emit(row.accountId, amountOf(row), entry);
      }
    }
    // VAT that moved with its money — a card sale, a till receipt — is the
    // same on both bases and goes out as it stands. VAT on an entry that grew
    // or settled a control account went through the pools above instead.
    if (arDelta === 0 && apDelta === 0) {
      for (const row of vat) {
        emitVat(row.accountId, row.creditCents - row.debitCents, entry);
      }
    }
  };

  return { take, rows: out };
}

/**
 * The ledger as the cash accounting scheme for VAT reads it.
 *
 * The same conversion the cash-basis profit and loss uses — the same pools,
 * the same settlements — with the VAT rows kept this time, handed back in the
 * ledger's own row shape so `vatReturn` and `flatRateVatReturn` work on them
 * exactly as they do on accrual rows. The difference between the two returns
 * is then entirely the timing of the rows, which is the whole of the scheme.
 *
 * Takes the business's whole history for the same reason `cashBasisRows`
 * does: the VAT on a March invoice paid in May belongs to May's return, and
 * May's entries alone cannot say so.
 *
 * One honest limit, said here because the screen says it too: a debt written
 * off is treated as settled, the way the income conversion treats it — so its
 * VAT still lands in the return. Under the scheme an invoice nobody ever pays
 * owes no VAT; a business writing debts off should adjust for them.
 */
export function cashBasisVatRows(
  all: CashBasisLine[],
  period: { from?: Date; to?: Date } = {},
): LedgerRow[] {
  const vat: CashBasisRow[] = [];
  return asLedgerRows(cashBasisRows(all, period, vat), vat);
}

/** The same, read from the database rather than from an array. */
export async function cashBasisVatRowsFor(
  orgId: string,
  period: { from?: Date; to?: Date } = {},
): Promise<LedgerRow[]> {
  const vat: CashBasisRow[] = [];
  return asLedgerRows(await cashBasisRowsFor(orgId, period, vat), vat);
}

/** Recognised amounts, back in the row shape the return arithmetic reads. */
function asLedgerRows(rows: CashBasisRow[], vat: CashBasisRow[]): LedgerRow[] {
  return [...rows, ...vat].map((row) => {
    // Back into debits and credits, in the direction each type is read —
    // the inverse of `amountOf`, so a round trip changes nothing.
    const creditSide =
      row.type === "income" ||
      row.type === "liability" ||
      row.type === "equity";
    const debitCents = creditSide
      ? Math.max(0, -row.amountCents)
      : Math.max(0, row.amountCents);
    const creditCents = creditSide
      ? Math.max(0, row.amountCents)
      : Math.max(0, -row.amountCents);
    return {
      entryId: row.entryId,
      classId: null,
      locationId: null,
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      type: row.type,
      debitCents,
      creditCents,
      postedAt: row.postedAt,
    };
  });
}

/**
 * Take a settlement out of a pool, spread across what built it.
 *
 * Proportion rather than order: a payment of half an invoice recognises half
 * of each account on it. Exact whenever a receivable was built from one income
 * account, which is what an invoice always is here.
 *
 * The last account takes the remainder, so the shares add up to what was
 * actually taken out. Dropping the fractions instead would leave income stuck
 * in the pool forever — a business whose cash-basis income is a few pennies
 * short of what it banked, every year, with nothing to point at.
 */
function drawDown(pool: Pool, amountCents: number): [string, number][] {
  /**
   * No guard for an empty pool.
   *
   * A receipt against nothing settles nothing, holds nothing, and falls out
   * below on its own — an early return here would be a branch no test could
   * ever reach and no reader could tell was load-bearing.
   */
  const outstanding = pool.outstandingCents;
  const settled = Math.min(amountCents, outstanding);
  const shares = [...pool.byAccount.entries()].filter(([, value]) => value > 0);
  const held = shares.reduce((sum, [, value]) => sum + value, 0);

  pool.outstandingCents = outstanding - settled;
  if (held <= 0) return [];

  /**
   * How much of the pool this settlement realises.
   *
   * A receivable is larger than the income behind it by the tax on it — an
   * invoice for 1200 holds 1000 of income and 200 the business is collecting
   * for somebody else — so a receipt realises its share of the income rather
   * than the whole of itself. Settling the last of a receivable realises
   * exactly what is left in the pool, whatever the rounding did on the way.
   */
  const realising =
    settled === outstanding
      ? held
      : Math.min(held, Math.round((held * settled) / outstanding));

  const taken: [string, number][] = [];
  let handed = 0;
  shares.forEach(([accountId, value], index) => {
    const last = index === shares.length - 1;
    const share = last
      ? realising - handed
      : Math.round((realising * value) / held);
    handed += share;
    if (share <= 0) return;
    pool.byAccount.set(accountId, value - share);
    taken.push([accountId, share]);
  });
  return taken;
}

/**
 * A credit note, taken back out of the pool it came from.
 *
 * Returns whatever the pool could not absorb — a credit against an invoice
 * that has already been paid for, which is a real reduction of income on the
 * day it was raised rather than something to unwind.
 */
function giveBack(
  pool: Pool,
  receivableCents: number,
  incomeCents: number,
): number {
  pool.outstandingCents = Math.max(0, pool.outstandingCents - receivableCents);

  let left = incomeCents;
  for (const [accountId, held] of [...pool.byAccount.entries()]) {
    if (left <= 0) break;
    const taken = Math.min(held, left);
    pool.byAccount.set(accountId, held - taken);
    left -= taken;
  }
  return left;
}

/** One line's share of a total, in the same direction as the total. */
function shareOf(line: number, total: number, amount: number): number {
  if (total === 0 || amount === 0) return 0;
  return Math.round((amount * line) / total);
}

function add(map: Map<string, number>, key: string, value: number): void {
  if (value === 0) return;
  map.set(key, (map.get(key) ?? 0) + value);
}
