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
  return (
    path
      /**
       * Template expressions first, before anything looks for a `?`.
       *
       * Both orders were tried and only this one is right, because a `?` can
       * live *inside* an expression: `${project?.id}` is optional chaining and
       * `${filter ? `?${filter}` : ""}` is a nested template. Stripping the
       * query string first cut the path at that `?` and reduced a real route
       * to `/api/projects/*`, which reported three live screens as calling
       * nothing at all.
       */
      .replace(/\$\{[^}]*\}/g, "\u0000")
      // What a nested template leaves behind: an opening `${` with no close,
      // because the capture stopped at the inner backtick. It runs to the end
      // by definition and everything after it is unknowable.
      .replace(/\$\{[^}]*$/, "")
      .replace(/[?#].*$/, "")
      .split("/")
      .filter(Boolean)
      .map((segment) =>
        // `:id`, `${id}` and Hono's `:token{.+\.ics}` are all one variable.
        segment.startsWith(":") || segment.includes("\u0000") ? "*" : segment,
      )
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
      /\bapp\.(get|post|put|patch|delete)\(\s*"(\/api\/[^"]*)"/g,
    )) {
      // As the source escapes it: `\\.` in the file is one backslash in the
      // path Hono registers.
      const path = m[2]?.replace(/\\\\/g, "\\");
      if (path) paths.add(`${(m[1] as string).toUpperCase()} ${path}`);
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
  /**
   * Every `/api/…` a `const` could hold, not only the ones that are one
   * literal.
   *
   * `const path = asQuote ? "/api/quotes" : "/api/invoices"` is how one form
   * saves two kinds of document, and reading only single-literal bindings
   * meant `${path}/${documentId}` expanded to nothing — so the PATCH behind
   * the Edit button on every invoice looked unreachable. Both branches are
   * kept, and each produces its own reading of the file.
   */
  const bound = new Map<string, string[]>();
  for (const m of source.matchAll(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=([^;\n]*(?:\n[^;\n]*){0,3}?);/g,
  )) {
    const name = m[1];
    const paths = [...(m[2] ?? "").matchAll(/[`"'](\/api\/[^`"'\n]*)[`"']/g)]
      .map((p) => p[1] as string)
      .filter(Boolean);
    if (name && paths.length) bound.set(name, paths);
  }
  if (bound.size === 0) return [source];

  // One reading per branch, so a two-branch binding does not silently keep
  // only whichever came first.
  const width = Math.max(...[...bound.values()].map((p) => p.length));
  const readings: string[] = [];
  for (let i = 0; i < width; i++) {
    let expanded = source;
    for (const [name, paths] of bound) {
      expanded = expanded.replaceAll(
        `\${${name}}`,
        paths[Math.min(i, paths.length - 1)] as string,
      );
    }
    readings.push(expanded);
  }
  return [source, ...readings];
}

/** Every API path a set of screen files asks for. */
export function requestedPaths(files: string[]): AskedPath[] {
  const text = files
    .flatMap((f) => withLocalPrefixes(readFileSync(f, "utf8")))
    .join("\n");
  const asked: AskedPath[] = [];
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
    /**
     * `/api/` and nothing else identifies no route at all.
     *
     * `` `/api/${asQuote ? "quotes" : "invoices"}/${id}` `` is captured only as
     * far as the quote inside the expression, so what survives is the prefix.
     * Reading that as a request for `/api` reported one real screen as calling
     * a route nobody had registered.
     */
    if (shape.length <= 1) continue;
    /**
     * A path kept in a variable is used somewhere this text cannot see.
     *
     * `const path = \`/api/payments/accounts/${provider}/${mode}\`` is then
     * passed as `api(path, { method: "DELETE" })` several lines and several
     * mutations later, and reading the verb that happens to follow the
     * *binding* picks whichever one was written first — which said the Forget
     * button did not exist while it was on the screen.
     *
     * So a binding carries every verb. It weakens the check for these paths
     * and it cannot invent a false alarm, and of the two that is the error to
     * make: this test is only useful for as long as it is believed.
     */
    const isBinding = /=\s*$/.test(
      text.slice(Math.max(0, m.index - 8), m.index),
    );
    asked.push({
      shape,
      methods: isBinding
        ? new Set(ALL_METHODS)
        : methodsAfter(text, m.index + m[0].length),
    });
  }
  return asked;
}

/**
 * The verbs a request beside this path can carry.
 *
 * `fetch(path)` with no method is a GET. `{ method: "DELETE" }` is a DELETE.
 * `{ method }` or `method: editing ? "PATCH" : "POST"` is the screen deciding
 * at runtime, and the honest answer there is **all of them** — claiming
 * otherwise invents a false alarm, and a guard that cries wolf is a guard
 * somebody switches off.
 *
 * Read from the text following the path rather than by parsing, for the same
 * reason the rest of this file is text: the screens are built for the browser
 * and cannot be imported. The window ends at the next request in the file, so
 * one call's verb cannot be read as its neighbour's.
 */
function methodsAfter(text: string, from: number): Set<string> {
  const ahead = text.slice(from, from + 400);

  /**
   * The window ends at the next request, stepping over the ones beside it.
   *
   * `query ? "/api/documents?q=…" : folderId ? "/api/documents?folderId=…" :
   * "/api/documents"` is one call with three paths in it, and the verb belongs
   * to all three. Stopping at the first neighbour would read the first branch
   * as a bare GET; widening blindly past all of them reads the *next*
   * mutation's `method: "DELETE"` as this call's. So: step over a literal that
   * sits right beside the last one, and stop at the first that does not.
   */
  let at = 0;
  let window = ahead;
  for (const m of ahead.matchAll(/["`'](\/api\/[^"`'\n]*)/g)) {
    const offset = m.index;
    if (offset - at > 40) {
      window = ahead.slice(0, offset);
      break;
    }
    at = offset + m[0].length;
  }

  const literal = window.match(
    /\bmethod\s*:\s*["`'](GET|POST|PUT|PATCH|DELETE)["`']/i,
  );
  if (literal) return new Set([(literal[1] as string).toUpperCase()]);
  if (/\bmethod\b\s*[,:=]/.test(window)) return new Set(ALL_METHODS);
  return new Set(["GET"]);
}

const ALL_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** A path a screen asks for, and the verbs it may ask with. */
export interface AskedPath {
  shape: string[];
  methods: Set<string>;
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

  /**
   * Both kinds of registration.
   *
   * Template ones were invisible here until their variables could be resolved,
   * so the CRM's whole CRUD surface and every share link went unchecked and
   * nothing said so. Twelve unreachable routes were sitting in them.
   */
  const all = [
    ...registeredRoutes(args.routeFiles),
    ...templateRoutes(args.routeFiles),
  ];

  for (const route of all) {
    const method = route.slice(0, route.indexOf(" "));
    const path = route.slice(route.indexOf(" ") + 1);
    // An excuse may name the verb or just the path: a route reached by a
    // storefront is reached whichever way it is written down.
    if (excused[route] || excused[path]) continue;

    const wanted = pathShape(path);
    const reached = asked.some(
      (a) => sameShape(wanted, a.shape) && a.methods.has(method),
    );
    if (!reached) unreachable.add(route);
  }
  return [...unreachable].sort();
}

/**
 * Routes registered from a template rather than a literal.
 *
 * `ctx.app.get(`/api/${path}`, …)` inside a helper, and
 * `ctx.app.post(`/api/${kind}/:id/share`, …)` inside a loop over two kinds.
 * Both are good code — one CRUD implementation for seven resources beats seven
 * — and both are invisible to `registeredRoutes`, which reads double-quoted
 * paths only.
 *
 * That blind spot was silent, which is the part worth fixing: the whole of the
 * CRM's contacts, companies, deals, tags, tasks, notes and activities, and
 * every invoice and quote share link, were never checked by any sweep, and
 * nothing said so. A guard is only worth what it admits it cannot see.
 *
 * The `${…}` becomes a wildcard, so `/api/${kind}/:id/share` matches a screen
 * asking for `/api/invoices/${id}/share`. That is too loose to *find* an
 * unreachable route — `/api/${path}` would stand for half the platform — so
 * these are used only to avoid crying wolf in the other direction, and are
 * inventoried by a test of their own.
 */
export function templateRoutes(files: string[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const values = resolvableIn(source);

    for (const m of source.matchAll(
      /\bapp\.(get|post|put|patch|delete)\(\s*`(\/api\/[^`]*)`/g,
    )) {
      const method = (m[1] as string).toUpperCase();
      const path = m[2];
      if (!path) continue;
      for (const real of expand(path, values)) found.add(`${method} ${real}`);
    }
  }
  return [...found].sort();
}

/**
 * What each `${…}` in this file can actually be.
 *
 * The variables in these paths are not mysteries: `${path}` is a field in a
 * table of resource definitions — `path: "contacts"` — and `${kind}` is the
 * loop it sits in, `for (const kind of ["invoices", "quotes"])`. Reading them
 * turns one generic pattern into the seven or two real routes it registers.
 *
 * Worth the twenty lines, because the alternative is a wildcard: `/api/${path}
 * /:id` as `api/*​/*` matches any three-segment path in the platform, and a
 * matcher that matches everything proves nothing. It masked a screen calling a
 * verb no route answered — the very bug this file was extended to find.
 */
function resolvableIn(source: string): Map<string, string[]> {
  const values = new Map<string, string[]>();

  // `for (const kind of ["invoices", "quotes"])`
  for (const m of source.matchAll(
    /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g,
  )) {
    const name = m[1];
    const items = [...(m[2] ?? "").matchAll(/["'`]([^"'`]+)["'`]/g)].map(
      (x) => x[1] as string,
    );
    if (name && items.length) {
      values.set(name, [...(values.get(name) ?? []), ...items]);
    }
  }

  /**
   * `path: "contacts"` — a field of that name anywhere in the file.
   *
   * Only for names a loop did not already pin down. `kind` is the loop over
   * `["invoices", "quotes"]` in one file and also an unrelated field on a
   * ledger entry — merging the two invented `/api/credit_note/:id/share`,
   * a route nobody registered, and a route that does not exist is a false
   * alarm waiting for whoever reads the report.
   */
  const fromLoops = new Set(values.keys());
  for (const m of source.matchAll(
    /\b([A-Za-z_$][\w$]*)\s*:\s*["'`]([A-Za-z0-9_-]+)["'`]/g,
  )) {
    const name = m[1];
    const value = m[2];
    if (!name || !value || fromLoops.has(name)) continue;
    const seen = values.get(name) ?? [];
    if (!seen.includes(value)) values.set(name, [...seen, value]);
  }

  return values;
}

/** One template, as every concrete path it can stand for. */
function expand(path: string, values: Map<string, string[]>): string[] {
  const m = path.match(/\$\{([A-Za-z_$][\w$]*)\}/);
  if (!m) return [path];

  const options = values.get(m[1] as string);
  // Nothing to resolve it with: keep the wildcard, and let whoever reads the
  // inventory decide whether that is good enough.
  if (!options?.length) {
    return expand(path.replace(m[0], "*"), values);
  }
  return options.flatMap((value) => expand(path.replace(m[0], value), values));
}
