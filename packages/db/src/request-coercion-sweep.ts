/**
 * Where a request value is still coerced instead of checked.
 *
 * Shared because all three repositories have routes and all three had this
 * bug; a sweep written once per repository is three things to keep right, and
 * the one that drifts is the one nobody is looking at. Each repository's own
 * test says which directories to read and asserts the answer is empty.
 *
 * `String(body.name ?? "")` hands a text column the words "[object Object]"
 * and refuses nothing — see `asText` in `./text-columns` for the whole of it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/*
 * Not preceded by a letter, which is load-bearing twice.
 *
 * `asWholeNumber(body.x` ends with the characters `Number(body.`, so the first
 * version of this swept up the very call that fixes the bug — and found one
 * inside its own refusal message, in the file doing the sweeping.
 */
/*
 * And a bracket after it as well as a dot. `String(body[name] ?? "")` is the
 * same coercion with the field chosen at run time, and it was how every link's
 * comment and five fields of a campaign stored "[object Object]" on 9 October
 * while this sweep, reading only `body.`, reported nothing.
 */
const COERCED = /(?<![A-Za-z])String\(\s*(body|payload)(\.[A-Za-z_]|\[)/;
/**
 * The same hole on the numeric side, and the worse of the two. `Number([])` is
 * 0, so an empty list sent where a price belongs passed every range check in
 * the product and bought a subscription for nothing.
 */
const COUNTED = /(?<![A-Za-z])Number\(\s*(body|payload)(\.[A-Za-z_]|\[)/;
/**
 * Comments do not count, and this sweep found its own.
 *
 * The first version read whole files, and a note explaining that a response is
 * deliberately *not* called `body` contains the very spelling being swept for —
 * so the sweep reported the file that had just been fixed.
 */
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;
const SKIP = new Set(["node_modules", ".git", "dist", "drizzle", "build"]);

function sources(dir: string, found: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return found;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      found.push(path);
  }
  return found;
}

export function sourcesUnder(repo: string, where: string[]): string[] {
  return where.flatMap((dir) => sources(join(repo, dir)));
}

function sitesMatching(repo: string, where: string[], what: RegExp): string[] {
  const out: string[] = [];
  for (const file of sourcesUnder(repo, where)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (IS_COMMENT.test(line) || !what.test(line)) return;
        out.push(`${relative(repo, file)}:${i + 1}`);
      });
  }
  return out;
}

/** Each `file:line` that coerces a request value into text. */
export function coercedTextSites(repo: string, where: string[]): string[] {
  return sitesMatching(repo, where, COERCED);
}

/** Each `file:line` that coerces a request value into a number. */
export function coercedNumberSites(repo: string, where: string[]): string[] {
  return sitesMatching(repo, where, COUNTED);
}

export const WHY_NOT_NUMBER =
  'these turn a request value into a number with Number(), and Number([]) is 0 — so a list sent where a price belongs passes every range check — use asWholeNumber(body.x, "x") or asNumber from @sentrello/db/request-values';

export const WHY_NOT_STRING =
  'these turn a request value into text with String(), which stores an object as the words "[object Object]" and refuses nothing — use asText(body.x, "x") from @sentrello/db/text-columns';

/*
 * A choice read by comparing it with one of its words, and every other word —
 * a typo, `{}`, a list — becoming the default. `body.visibility === "public" ?
 * "public" : "private"` answered 201 to "pubic" and made a private list; found
 * on 9 October in a dozen places across the three repositories.
 */
const DEFAULTED_WORD =
  /(?<![A-Za-z])(body|payload)\??\.[A-Za-z_]\w*\s*===\s*"[^"]*"\s*\?\s*"[^"]*"\s*:\s*"/;
/*
 * The same with a list of words: `KINDS.includes(body.kind) ? body.kind :
 * "text"`. Read across a line break, because the formatter puts the `?` on the
 * next one more often than not.
 */
const DEFAULTED_LIST =
  /\.(includes|has)\(\s*(body|payload)\??\.[A-Za-z_]\w*[^)]*\)\s*\?/;

/** Each `file:line` that turns an unknown choice into a default instead of refusing it. */
export function defaultedChoiceSites(repo: string, where: string[]): string[] {
  const out: string[] = [];
  for (const file of sourcesUnder(repo, where)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (IS_COMMENT.test(line)) return;
      const joined = `${line} ${(lines[i + 1] ?? "").trim()}`;
      if (DEFAULTED_WORD.test(line) || DEFAULTED_LIST.test(joined)) {
        out.push(`${relative(repo, file)}:${i + 1}`);
      }
    });
  }
  return out;
}

export const WHY_NOT_DEFAULTED =
  'these turn a choice nobody offered into the default and answer 2xx, so the caller is told it worked — use asChoice(body.x, "x", [...choices], fallback) from @sentrello/db/request-values, which refuses an unknown word with a 400 naming the field';

/*
 * True or false read by comparing with one of them. `body.x === true` makes
 * `{}`, "yes" and `[true]` all false, and `!!body.x` makes them all true; both
 * answer 2xx. `typeof body.x === "boolean" ? body.x : current` is the third
 * spelling, and the worst, because it keeps the old value and says it saved.
 */
const COERCED_FLAG =
  /(?<![A-Za-z])(body|payload)\??\.[A-Za-z_]\w*\s*[!=]==\s*(true|false)\b|(!!|Boolean\()\s*(body|payload)\??(\.[A-Za-z_]|\[)|typeof (body|payload)\??\.[A-Za-z_]\w* === "boolean"/;

/** Each `file:line` that reads a request flag by comparison or coercion instead of asking. */
export function coercedFlagSites(repo: string, where: string[]): string[] {
  return sitesMatching(repo, where, COERCED_FLAG);
}

export const WHY_NOT_FLAG =
  'these read true or false by comparing or coercing, so {}, "yes" and [true] are quietly one or the other and the caller is told it worked — use asFlag(body.x, "x", fallback) from @sentrello/db/request-values';
