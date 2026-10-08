import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Every invoice says which convention it was priced under.
 *
 * The UK and the EU put the tax inside the price: a plan that says £120 means
 * £120 is what the customer pays, and £20 of it is the VAT. The US quotes net
 * and adds the tax on top. Which one a business does is one setting, read when
 * a document is made and then frozen onto it as `pricesIncludeTax`, because
 * every later reading — the screen, the PDF, a credit note, the e-invoice —
 * asks the document rather than the setting.
 *
 * A writer that leaves the column off gets `false`, so it does not fail, it
 * overcharges: £120 billed as £144, and the document then agrees with itself,
 * because its own copy of the flag says net as well. Nothing is inconsistent
 * and nothing throws; the only thing wrong anywhere is the amount, on the
 * invoices a business looks at least often.
 *
 * Two of them, found on 4 October 2026 — the door every module raises an
 * invoice through (a subscription period, a mid-period change, an appointment
 * that was kept) and Pro's inline recurring profile (a retainer). The US was
 * the one market where the default happened to be right, which is the same
 * shape as the `?? "USD"` fallback its sibling in this folder sweeps for.
 *
 * So an insert into `invoices` either sets the column or says in writing why it
 * does not, with a `gross-or-net:` note in the comment block above it.
 */

const REPO = resolve(import.meta.dir, "../../..");
const CODE = /\.(ts|tsx)$/;
const SKIP = new Set(["node_modules", ".git", "dist", "drizzle", "build"]);
const WRITES_AN_INVOICE = /\.insert\(\s*schema\.invoices\s*\)/;
/** The escape hatch, in the comment block above, with a reason after it. */
const EXCUSED = /gross-or-net:\s*\S/;
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;
/**
 * The `values({…})` the insert belongs to, read to its own closing brace.
 *
 * This was a 45-line window, which is a number that decides whether the guard
 * works and says nothing when it stops being enough. One line was added to an
 * invoice's values on 6 October — a refusal wrapped onto two — and
 * `pricesIncludeTax` fell out of the window: the guard reported a live writer
 * as not stating gross or net, which it had stated all along, 46 lines down.
 * Counting braces is the version with nothing to keep right.
 */
function valuesBlock(lines: string[], from: number): string {
  const start = lines
    .slice(from, from + 6)
    .findIndex((line) => line.includes(".values("));
  if (start === -1) return lines.slice(from, from + 6).join("\n");
  let depth = 0;
  const out: string[] = [];
  for (let i = from + start; i < lines.length; i++) {
    const line = lines[i] as string;
    out.push(line);
    for (const ch of line) {
      if (ch === "(" || ch === "{") depth++;
      else if (ch === ")" || ch === "}") depth--;
    }
    if (depth <= 0 && out.length > 1) break;
  }
  return out.join("\n");
}
/** How far above the insert an exception may be written. */
const EXCUSE_WITHIN = 14;

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

/** A sweep that has stopped finding what it reads is a guard that passes blind. */
test("there are invoice writers to sweep", () => {
  const writers = FILES.filter((file) =>
    WRITES_AN_INVOICE.test(readFileSync(file, "utf8")),
  );
  expect(writers.length).toBeGreaterThan(1);
});

test("every invoice written says whether its prices contain the tax", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!WRITES_AN_INVOICE.test(line) || IS_COMMENT.test(line)) return;

      /*
       * Read off the code, not off the prose beside it.
       *
       * This matched the whole block, comments included, so a writer that
       * *explained* why it set `pricesIncludeTax` satisfied the guard whether or
       * not it still did. Found on 8 October 2026 while writing the sibling that
       * sweeps for an unstated currency: that one passed a writer it should have
       * reported, because the comment above the fix used the word.
       */
      const block = valuesBlock(lines, i)
        .split("\n")
        .filter((l) => !IS_COMMENT.test(l))
        .join("\n");
      if (/pricesIncludeTax/.test(block)) return;

      /*
       * Or excused in writing, looked for in a window above rather than in the
       * comment block touching the line.
       *
       * `.insert(schema.invoices)` is in the middle of a chain — the statement
       * starts a line or two earlier with the assignment — so the line directly
       * above it is code, and a walk that stops at the first non-comment line
       * finds nothing however well the exception is written. The first version
       * of this guard did exactly that and reported the one file that had
       * complied with it.
       */
      const above = lines.slice(Math.max(0, i - EXCUSE_WITHIN), i);
      if (above.some((l) => IS_COMMENT.test(l) && EXCUSED.test(l))) return;
      offenders.push(`${relative(REPO, file)}:${i + 1}`);
    });
  }

  expect(
    offenders,
    `these write an invoice without saying whether its prices already contain the tax, so it defaults to net and a gross-quoting business is overcharged — read quotesGross(orgId) and set pricesIncludeTax, or say why above the insert with "gross-or-net: <reason>":\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});
