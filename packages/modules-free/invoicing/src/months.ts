/**
 * A month series, with no timezone in it.
 *
 * Its own file with no imports, for the same reason `eu.ts` is: the thing
 * worth pinning here is arithmetic, and a test that has to load `summary.ts`
 * loads the database client, the module context and the whole graph behind
 * them. Pure and alone, it can be run twice in two timezones — which is the
 * only kind of test that can see the fault below.
 */

/**
 * Six months, including the quiet ones.
 *
 * `group by` answers with the months that have invoices in them, which for a
 * business two months old is two rows — and the chart gives each point an
 * equal share of the card, so one month of trading drew a single bar the
 * width of the screen. It reads as a rendering fault rather than as a young
 * business, and worse, it hides the shape the chart exists to show: a month
 * where nothing was billed is exactly the month somebody wants to see.
 *
 * Filled here rather than in the browser because the browser does not know
 * how many months were asked for — it receives what came back and has no way
 * to tell two months of history from four quiet ones.
 */
export function sixMonthsFrom(
  since: Date,
  found: { month: string; billedCents: number }[],
): { month: string; billedCents: number }[] {
  /*
   * Nothing at all stays nothing.
   *
   * Six empty bars are not an honest drawing of a business that has never
   * invoiced anybody — the chart says "Nothing to chart yet" for that, which
   * is both true and useful. This fills the gaps in a series; it does not
   * invent one.
   */
  if (found.length === 0) return [];

  const byMonth = new Map(found.map((m) => [m.month, m.billedCents]));
  const series: { month: string; billedCents: number }[] = [];
  /*
   * Counted in months, not walked with a Date, and read in UTC.
   *
   * Two faults in one line, and they compounded. `since` is UTC midnight on
   * the first of a month, and the keys were built from `getFullYear()` and
   * `getMonth()` — the host's own calendar. So on any server west of UTC the
   * first key named the month *before* the window. Then `setMonth(+1)` was
   * asked to advance a date that read as the 31st there, and an impossible
   * 31st rolls forward: the second key skipped a month outright. On a New York
   * server, September's chart came back `2026-03, 2026-05, 2026-06, 2026-07,
   * 2026-08, 2026-09` — a bar for a month outside the query, which can only
   * ever read zero, and **April missing from the chart altogether**, with its
   * billing shown nowhere on the screen.
   *
   * `to_char` on the query side has no timezone in it and no month to skip, so
   * the way to agree with it is to do no date arithmetic at all. A month index
   * cannot roll over.
   */
  const base = since.getUTCFullYear() * 12 + since.getUTCMonth();
  for (let i = 0; i < 6; i++) {
    const month = base + i;
    const key = `${Math.floor(month / 12)}-${String((month % 12) + 1).padStart(2, "0")}`;
    series.push({ month: key, billedCents: byMonth.get(key) ?? 0 });
  }
  return series;
}
