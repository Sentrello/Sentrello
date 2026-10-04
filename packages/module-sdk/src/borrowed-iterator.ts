/**
 * An array method borrowed onto an iterator.
 *
 * `Array.prototype.reduce.call(x, …)` is a legitimate old trick, and it works
 * when `x` is *array-like*: a NodeList, an HTMLCollection, a form's `elements`,
 * `arguments`. Every one of those carries a `length`, which is the only thing
 * the borrowed method reads.
 *
 * An iterator does not. `formData.entries()`, `map.keys()`, `set.values()`,
 * `searchParams.entries()` all hand back an iterator, and a borrowed array
 * method on one sees `length === undefined`, treats that as nought, visits
 * nothing, and returns its initial value. No throw. No warning. The right
 * shape of answer, empty.
 *
 * That shipped, on 3 October 2026. The embeddable forms script built its
 * request body with `Array.prototype.reduce.call(data.entries(), …)` and posted
 * `{}` from every form that had no file on it — the instance answered "a name
 * or an email address is required" and the visitor was told the form could not
 * be sent. A form carrying a file posted the FormData itself and worked, so it
 * read as some forms being broken rather than as one line being wrong, and the
 * contact form on the marketing site was down for a day.
 *
 * Why a text scan and not the type checker: the code it lives in is a string.
 * An embeddable script is text we ship to somebody else's website, so nothing
 * type-checks it, and the only reader is whoever opens the file. Four other
 * borrowings exist across the repositories and all four are onto array-likes,
 * which is exactly why the broken one did not stand out.
 *
 * The fix is always one of two words — `Array.from(x)` or
 * `Object.fromEntries(x)` — or the collection's own `forEach`, which a FormData
 * has and which was already being used ten lines above the bug.
 */

export interface BorrowedIterator {
  line: number;
  /** The borrowed method, for the failure message. */
  method: string;
  /** The sentence for whoever meets the failure. */
  say: string;
}

/** The borrowing itself. */
const BORROWED = /Array\.prototype\.(\w+)\.call\(/;

/**
 * What an iterator looks like at the call site.
 *
 * By the call that produced it rather than by the variable's type, because this
 * reads text: `.entries()`, `.keys()`, `.values()` on anything at all, and the
 * explicit `[Symbol.iterator]()`.
 */
const AN_ITERATOR = /\.(entries|keys|values)\(\)|\[Symbol\.iterator\]\(\)/;

/** A comment, which is where this bug gets described rather than written. */
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

/** Said in writing, above the line, with a reason after it. */
const EXCUSED = /borrowed-on-purpose:\s*\S/;

/** How many lines below the borrowing its argument may sit. */
const ARGUMENT_WITHIN = 4;

export function findBorrowedIterator(source: string): BorrowedIterator[] {
  const out: BorrowedIterator[] = [];
  const lines = source.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const borrowed = BORROWED.exec(line);
    if (!borrowed || IS_COMMENT.test(line)) continue;
    /*
     * The argument can be on this line or a few below it. A borrowed call with
     * its iterator on a line of its own is the shape biome leaves behind once
     * the call is long enough to wrap, which the real one was not — but the
     * next one might be.
     */
    if (!AN_ITERATOR.test(lines.slice(i, i + ARGUMENT_WITHIN).join("\n"))) {
      continue;
    }
    const above = lines.slice(Math.max(0, i - 6), i);
    if (above.some((l) => IS_COMMENT.test(l) && EXCUSED.test(l))) continue;
    const method = borrowed[1] ?? "method";
    out.push({
      line: i + 1,
      method,
      say: `an iterator has no length, so Array.prototype.${method}.call visits nothing and hands back what it started with — use Array.from(…), Object.fromEntries(…), or the collection's own forEach`,
    });
  }
  return out;
}
