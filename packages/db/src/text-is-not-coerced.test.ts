import { expect, test } from "bun:test";
/**
 * `String(body.x)` is how "[object Object]" gets into a book.
 *
 * The rule has two halves and both were learned the hard way on 6 October. A
 * write guard on the database handle catches an object that *reaches* it — and
 * it caught nothing for the commonest shape in this repository, because
 * `String(body.name ?? "")` flattens the object on the way and hands over an
 * ordinary string that happens to read "[object Object]". A test through the
 * real server said 201 where it expected 400, which is the only reason this is
 * known.
 *
 * So the coercion is the thing to keep out: `asText(body.name, "name")`
 * refuses an object and a plain array, and the error handler answers 400
 * naming the field. This is the half that stays true after the next route is
 * written, because the alternative — remembering — was measured at 4 routes
 * out of 31.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../../..");
const WHERE = ["packages/modules-free", "apps/server/src"];
const SKIP = new Set(["node_modules", ".git", "dist", "drizzle", "build"]);
/**
 * A request body, by the three names every route in here gives it. Anything
 * else called `body` — a mail body, an activity's text — is a different thing
 * and is not what this is about.
 */
const COERCED = /String\(\s*(body|payload)\.[A-Za-z_]/;
/**
 * Comments do not count, and this guard found its own.
 *
 * The first version read whole files, and the note in `mtd.ts` explaining that
 * its `answer` is deliberately not called `body` contains the very spelling
 * being swept for — so the sweep reported the file that had just been fixed.
 * A guard that can match prose about itself is a guard whose failures have to
 * be argued with.
 */
const IS_COMMENT = /^\s*(\/\/|\*|\/\*)/;

function sources(dir: string, found: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, found);
    else if (/\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
      found.push(path);
  }
  return found;
}

const FILES = WHERE.flatMap((where) => sources(join(REPO, where)));

test("there is source to sweep", () => {
  expect(FILES.length).toBeGreaterThan(100);
});

test("no route flattens a request value into text with String()", () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (IS_COMMENT.test(line) || !COERCED.test(line)) return;
        offenders.push(`${relative(REPO, file)}:${i + 1}`);
      });
  }

  expect(
    offenders,
    `these turn a request value into text with String(), which stores an object as the words "[object Object]" and refuses nothing — use asText(body.x, "x") from @sentrello/db/text-columns:\n    ${offenders.join("\n    ")}`,
  ).toEqual([]);
});
