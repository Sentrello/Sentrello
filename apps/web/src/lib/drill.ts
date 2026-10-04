/**
 * Arriving at a list already narrowed to what somebody pressed.
 *
 * A chart is a picture of rows. Until now pressing a bar either did nothing or
 * opened the whole list — so a reader who had just been shown that September was
 * the bad month arrived at every invoice ever raised and had to find September
 * again by hand. The figure answered "what", and the one screen that could
 * answer "which" made them start over.
 *
 * **Carried as an intent, not in the address.** `go(module, title, intent)`
 * already exists for exactly this kind of one-shot message, and the navigation
 * layer owns the address bar by pathname alone. The consequence is that a
 * refresh returns the plain list, which is the honest behaviour for something
 * that was a press rather than a place: the filters are visible in the rail with
 * a way to clear them, so nobody is left looking at a narrowed list wondering
 * why.
 *
 * The encoding is a query string because that is what the filters already are —
 * the same names the list sends the server, so a drill-through is readable in a
 * stack trace and in a log line without a decoder.
 */

const PREFIX = "filter:";

/** "arrive at this list with these filters applied". */
export function filterIntent(filters: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.set(key, value);
  }
  return `${PREFIX}${params.toString()}`;
}

/**
 * The filters an intent asks for, or null when it asks for something else.
 *
 * Null rather than an empty object, because "this intent is not about filters"
 * and "this intent clears the filters" are different instructions and a screen
 * reading one as the other would wipe what somebody had set.
 */
export function filtersFromIntent(
  intent: string | null | undefined,
): Record<string, string> | null {
  if (!intent || !intent.startsWith(PREFIX)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(intent.slice(PREFIX.length))) {
    // The same shape the server's own filter names take. Anything else is
    // dropped rather than passed on: this string is built by our own screens,
    // so a name outside it is a bug rather than input to be preserved.
    if (/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(key) && value.length <= 200) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * A month as the two filters a list wants: the first day and the last.
 *
 * Written once because three charts need it and each would otherwise have its
 * own idea of what the last day of February is. The month is `YYYY-MM`, which is
 * what every monthly series in this product already labels itself with.
 */
export function monthRange(month: string): { from: string; to: string } {
  const [year, index] = month.split("-").map(Number);
  if (!year || !index) return { from: "", to: "" };
  // Day 0 of the next month is the last day of this one, and it knows about
  // leap years without anybody writing them down.
  const last = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    from: `${year}-${pad(index)}-01`,
    to: `${year}-${pad(index)}-${pad(last)}`,
  };
}
