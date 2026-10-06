/**
 * Where `String(body.x)` still turns a request value into text.
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

const COERCED = /String\(\s*(body|payload)\.[A-Za-z_]/;
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

/** Each `file:line` that coerces a request value into text. */
export function coercedTextSites(repo: string, where: string[]): string[] {
  const out: string[] = [];
  for (const file of sourcesUnder(repo, where)) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (IS_COMMENT.test(line) || !COERCED.test(line)) return;
        out.push(`${relative(repo, file)}:${i + 1}`);
      });
  }
  return out;
}

export const WHY_NOT_STRING =
  'these turn a request value into text with String(), which stores an object as the words "[object Object]" and refuses nothing — use asText(body.x, "x") from @sentrello/db/text-columns';
