import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Finding routes nothing can reach.
 *
 * The commonest defect in this codebase, and the hardest to see: a route is
 * written, tested, and described in the module's notes as **built**. No screen
 * ever calls it. Every API test passes, because the API is right. The feature
 * does not exist, because nobody can reach it — and the notes say it is done,
 * so nobody looks again.
 *
 * Found by hand in four modules before it was worth writing down. It lives in
 * the SDK rather than in either repository's tests because Core's modules and
 * the commercial ones have the same shape of hole, and a second copy of this
 * is a copy that gets the matching subtly wrong in one repository only.
 *
 * Source is read as text on purpose. The screens are compiled for the browser
 * against `window.__sentrello` and cannot be imported into a test.
 */

/** Files under `dir` with one of these extensions, tests excluded. */
export function sourceFiles(dir: string, extensions: string[]): string[] {
  const found: string[] = [];
  const walk = (at: string) => {
    for (const entry of readdirSync(at)) {
      const path = join(at, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.includes(".test.")) continue;
      if (extensions.some((e) => entry.endsWith(e))) found.push(path);
    }
  };
  walk(dir);
  return found;
}

/**
 * A path as segments, with anything variable reduced to a wildcard.
 *
 * A route writes its variable parts as `:id`; a screen writes them as `${id}`
 * inside a template literal. Reduced to the same shape the two compare
 * directly, which keeps the comparison exact everywhere else:
 * `/api/shop/orders/${id}/refund` matches `/api/shop/orders/:id/refund` and
 * nothing else, while `/api/shop/tax` does **not** cover `/api/shop/tax/rates`
 * — a different screen, which may well not exist.
 *
 * An earlier version cut the path at the first variable instead. That made
 * `/api/shop/orders/` stand for every route beneath it, and the module with
 * sixteen unreachable routes came back clean.
 */
export function pathShape(path: string): string[] {
  return path
    .replace(/[?#].*$/, "")
    .split("/")
    .filter(Boolean)
    .map((segment) =>
      // `:id`, `${id}` and Hono's `:token{.+\.ics}` are all one variable.
      segment.startsWith(":") || segment.includes("${") ? "*" : segment,
    );
}

function sameShape(a: string[], b: string[]): boolean {
  return (
    a.length === b.length &&
    a.every((segment, i) => segment === "*" || b[i] === "*" || segment === b[i])
  );
}

/**
 * The API paths registered across a set of source files.
 *
 * Only `/api/…`: a module also serves public pages, an embed script and an
 * `.ics` feed, and none of those is something an admin screen calls.
 */
export function registeredRoutes(files: string[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(
      /\bapp\.(?:get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g,
    )) {
      // As the source escapes it: `\\.` in the file is one backslash in the
      // path Hono registers.
      const path = m[1]?.replace(/\\\\/g, "\\");
      if (path) paths.add(path);
    }
  }
  return [...paths];
}

/**
 * Paths a screen assembles from a variable it declared.
 *
 * `const path = \`/api/payments/accounts/${provider}/${mode}\`` followed by
 * `api(\`${path}/test\`)` is a real and reasonable way to write four related
 * requests, and it is invisible to a scan that only looks for literals
 * starting `/api/`. Left unhandled it reported two live buttons as
 * unreachable, and a false alarm is the failure that gets a guard like this
 * switched off.
 *
 * **Per file, and in addition to the original text rather than instead of
 * it.** Both halves were learned by getting them wrong. Substituting across
 * the whole codebase let `path` in one screen overwrite `path` in another and
 * invented four fresh false alarms. Replacing the text rather than adding to
 * it lost the wildcard reading of \`/api/invoices/${id}/${action}\`, which is
 * how one screen legitimately reaches five routes.
 */
function withLocalPrefixes(source: string): string[] {
  const bound = new Map<string, string>();
  for (const m of source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*[`"'](\/api\/[^`"'\n]*)[`"']/g,
  )) {
    if (m[1] && m[2]) bound.set(m[1], m[2]);
  }
  if (bound.size === 0) return [source];

  let expanded = source;
  for (const [name, path] of bound) {
    expanded = expanded.replaceAll(`\${${name}}`, path);
  }
  return [source, expanded];
}

/** Every API path a set of screen files asks for. */
export function requestedPaths(files: string[]): string[][] {
  const text = files
    .flatMap((f) => withLocalPrefixes(readFileSync(f, "utf8")))
    .join("\n");
  const asked: string[][] = [];
  // Up to the closing quote or backtick: a template literal's `${…}` is part
  // of the path, and `pathShape` is what makes sense of it.
  for (const m of text.matchAll(/["`'](\/api\/[^"`'\n]*)/g)) {
    if (!m[1]) continue;
    const shape = pathShape(m[1]);
    /**
     * `/api/${resource}` on its own says nothing about which route.
     *
     * One generic list fetcher writes exactly that, and left in it silently
     * excused every two-segment route in the codebase — including a dead
     * duplicate of recurring invoices in the paid module. A deeper path with a
     * variable at the front, like `/api/${holder}/${id}/receipt`, still counts:
     * the segments after it identify the route.
     */
    if (shape.length === 2 && shape[1] === "*") continue;
    asked.push(shape);
  }
  return asked;
}

/**
 * Routes with nothing calling them.
 *
 * `calledByOther` names the routes something that is not an admin screen
 * reaches — a storefront, a payment provider, a calendar application.
 * Excusing a route falsely is how a module comes back clean with a dead
 * feature in it, so each entry is expected to say what does call it.
 */
export function unreachableRoutes(args: {
  routeFiles: string[];
  screenFiles: string[];
  calledByOther?: Record<string, string>;
}): string[] {
  const excused = args.calledByOther ?? {};
  const asked = requestedPaths(args.screenFiles);
  const unreachable = new Set<string>();

  for (const path of registeredRoutes(args.routeFiles)) {
    if (excused[path]) continue;
    const wanted = pathShape(path);
    if (!asked.some((a) => sameShape(wanted, a))) unreachable.add(path);
  }
  return [...unreachable].sort();
}
