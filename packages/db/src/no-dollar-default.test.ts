import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Nothing falls back to the dollar because nobody said.
 *
 * Four separate places wrote `?? "USD"` when a caller left a currency off,
 * and every one of them was the same bug with a different blast radius. Our
 * markets are the US, Canada, the UK and the EU; three of the four do not
 * trade in dollars, so on three of our four markets the fallback asked for a
 * rate that is never recorded — and the code underneath correctly refuses to
 * post at a rate nobody set.
 *
 * What that looked like, on 28 September 2026:
 *
 *  - **`raiseInvoice` defaulted to USD**, and a booking turning into an
 *    invoice says nothing about currency because it has no opinion. Booking
 *    could not bill at all outside the United States. Silent: the invoice
 *    simply never appeared.
 *  - **A subscription was sold in dollars**, so the billing run refused the
 *    profile every month, for the lifetime of the customer.
 *  - **A quote was written in dollars**, priced in dollars on the copy the
 *    customer read, and refused at the moment somebody pressed Convert.
 *  - **The invoice form sent `"USD"` on every document**, so the business
 *    could not raise one from its own main screen.
 *
 * The answer is always the same and it is one call: `baseCurrency(orgId)`.
 *
 * So a line may say `"USD"` as a fallback only where it is *about* the base
 * currency — `org?.baseCurrency ?? "USD"`, which is that function's own
 * definition of the default — or where the line above says why, with a
 * `dollar-default:` note. Anything else is this bug being written again.
 */

const REPO = resolve(import.meta.dir, "../../..");
const CODE = /\.(ts|tsx)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "drizzle", "build"]);
/** `?? "USD"`, `|| "USD"`, and the single-quoted forms. */
const FALLS_BACK = /(\?\?|\|\|)\s*["']USD["']/;
/** The escape hatch, on the line above, with a reason after the colon. */
const EXCUSED = /dollar-default:\s*\S/;
/**
 * A comment, which is where this bug gets *described* rather than written.
 * Every fix above left a note saying what the old fallback did, and a guard
 * that reads its own history as a violation is a guard people switch off.
 */
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

function sources(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      sources(full, found);
    } else if (CODE.test(name) && !name.includes(".test.")) {
      found.push(full);
    }
  }
  return found;
}

const FILES = sources(REPO);

/** A sweep that has stopped finding files is a guard that passes blind. */
test("there is source to sweep for the dollar fallback", () => {
  expect(FILES.length).toBeGreaterThan(50);
});

test("no currency falls back to the dollar", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!FALLS_BACK.test(line) || IS_COMMENT.test(line)) return;
      // About the base currency itself, which is where the default belongs.
      if (/baseCurrency/.test(line) || /baseCurrency/.test(lines[i - 1] ?? ""))
        return;
      /*
       * Or excused in writing, by somebody who had to state a reason.
       *
       * Looked for across the whole comment block above the line, not only
       * on the line immediately before it: a fallback worth keeping usually
       * has a paragraph explaining it, and the line touching the code is
       * then the block's closing marker rather than the reason.
       */
      let excused = false;
      for (
        let back = i - 1;
        back >= 0 && IS_COMMENT.test(lines[back] ?? "");
        back--
      ) {
        if (EXCUSED.test(lines[back] ?? "")) {
          excused = true;
          break;
        }
      }
      if (excused) return;
      offenders.push(`${relative(REPO, file)}:${i + 1}  ${line.trim()}`);
    });
  }

  expect(
    offenders,
    `these fall back to the dollar on a business that may not trade in one — use baseCurrency(orgId), or say why above the line with "dollar-default: <reason>":\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});
