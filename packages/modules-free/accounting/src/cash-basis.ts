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

/** The two control accounts, by the codes every module posts to them with. */
const RECEIVABLE_CODE = "1100";
const PAYABLE_CODE = "2000";

export interface CashBasisRow {
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

interface Entry {
  id: string;
  postedAt: Date;
  rows: LedgerRow[];
}

function entriesOf(rows: LedgerRow[]): Entry[] {
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
function amountOf(row: LedgerRow): number {
  return row.type === "income" ||
    row.type === "liability" ||
    row.type === "equity"
    ? row.creditCents - row.debitCents
    : row.debitCents - row.creditCents;
}

/**
 * The income and expense a period actually saw the money for.
 *
 * Takes the business's whole history rather than the period's rows: money
 * received in June for work invoiced in March is June's, and June's entries
 * alone cannot say so.
 */
export function cashBasisRows(
  all: LedgerRow[],
  period: { from?: Date; to?: Date } = {},
): CashBasisRow[] {
  /**
   * What each account is called, learned as the ledger is read.
   *
   * An amount recognised in June belongs to an account named on an entry in
   * March, and the June entry does not carry the name. Held here rather than
   * in the module, so two businesses reported on in one process cannot end up
   * reading each other's account names.
   */
  const names = new Map<string, LedgerRow>();
  for (const row of all) names.set(row.accountId, row);

  const receivable = emptyPool();
  const payable = emptyPool();
  const out: CashBasisRow[] = [];

  const inPeriod = (at: Date) =>
    (!period.from || at >= period.from) && (!period.to || at <= period.to);

  const emit = (accountId: string, amountCents: number, at: Date) => {
    if (amountCents === 0 || !inPeriod(at)) return;
    const named = names.get(accountId);
    if (!named) return;
    out.push({
      accountId,
      code: named.code,
      name: named.name,
      type: named.type,
      amountCents,
      postedAt: at,
    });
  };

  for (const entry of entriesOf(all)) {
    const controlDelta = (code: string) =>
      entry.rows
        .filter((row) => row.code === code)
        .reduce((sum, row) => sum + row.debitCents - row.creditCents, 0);

    // A receivable grows on the debit side; a payable on the credit side.
    const arDelta = controlDelta(RECEIVABLE_CODE);
    const apDelta = -controlDelta(PAYABLE_CODE);

    const income = entry.rows.filter((row) => row.type === "income");
    const expense = entry.rows.filter((row) => row.type === "expense");
    const incomeDelta = income.reduce((sum, row) => sum + amountOf(row), 0);
    const expenseDelta = expense.reduce((sum, row) => sum + amountOf(row), 0);

    if (arDelta > 0) {
      // An invoice: not income yet. Into the pool with the receivable it made.
      receivable.outstandingCents += arDelta;
      for (const row of income) {
        add(receivable.byAccount, row.accountId, amountOf(row));
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
        emit(row.accountId, share, entry.postedAt);
      }
    } else if (arDelta < 0) {
      // Paid, or written off. Either way it is recognised now.
      for (const [accountId, amountCents] of drawDown(receivable, -arDelta)) {
        emit(accountId, amountCents, entry.postedAt);
      }
    }

    if (apDelta > 0) {
      payable.outstandingCents += apDelta;
      for (const row of expense) {
        add(payable.byAccount, row.accountId, amountOf(row));
      }
    } else if (apDelta < 0 && expenseDelta < 0) {
      const unabsorbed = giveBack(payable, -apDelta, -expenseDelta);
      for (const row of expense) {
        const share = shareOf(amountOf(row), expenseDelta, -unabsorbed);
        emit(row.accountId, share, entry.postedAt);
      }
    } else if (apDelta < 0) {
      for (const [accountId, amountCents] of drawDown(payable, -apDelta)) {
        emit(accountId, amountCents, entry.postedAt);
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
      for (const row of income)
        emit(row.accountId, amountOf(row), entry.postedAt);
    }
    if (apDelta === 0 && !(arDelta < 0 && expenseDelta < 0)) {
      for (const row of expense) {
        emit(row.accountId, amountOf(row), entry.postedAt);
      }
    }
  }

  return out;
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
