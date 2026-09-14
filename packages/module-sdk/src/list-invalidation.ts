/**
 * An invalidation key that cannot match the list it means to refresh.
 *
 * `useListQuery(resource, state)` keys its cache as `[resource, query]` — one
 * joined string, such as `"shop/products"`, followed by the query it was
 * fetched with. TanStack Query matches a filter key against the cache key
 * element by element, so a mutation that invalidates the resource has to name
 * that same joined string. Two things go wrong instead, both seen in real
 * screens: the resource written back out in split form —
 * `["shop", "products"]`, which is never equal to `"shop/products"` at
 * element zero and so never matches anything — and a prefix that used to be
 * broad enough to catch a resource's children — `["newsletter"]` — which
 * fails the same way now that the child is one joined string rather than a
 * second array element.
 *
 * Both shipped as a mutation that "succeeds" while the list on screen never
 * refreshes: no error, no failed request, just stale rows. Caught only by a
 * review of the whole change, and once more immediately after, in the next
 * module to convert — which is what makes vigilance the wrong tool here.
 *
 * A resource and the mutation that invalidates it are not always written in
 * the same file — Shop's fourth site was a product editor in one file
 * invalidating the products list a completely different file fetches. A
 * scanner that only reads one file at a time cannot see that, so the entry
 * point, `findStaleInvalidations`, takes every screen in a module together:
 * every resource is collected across the whole set before any key is
 * checked against it. A single file is just a set of one.
 *
 * Text in, findings out, same as `ui-drift.ts`: source is read as a string
 * because these are screens built for the browser, not files a test can
 * import.
 */
import { exceptedAbove, lineOf, stripComments } from "./scan-text";

export interface StaleInvalidationFinding {
  file: string;
  line: number;
  say: string;
}

/** A raw resource or key-element string, with every `${...}` reduced to `*`. */
function normalize(raw: string): string {
  return raw.replace(/\$\{[^}]*\}/g, "*");
}

function segmentsOf(joined: string): string[] {
  return joined.split("/").filter(Boolean);
}

function sameSegments(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

/** True if `prefix` is strictly shorter than `full` and matches its start. */
function isProperPrefix(prefix: string[], full: string[]): boolean {
  return (
    prefix.length > 0 &&
    prefix.length < full.length &&
    prefix.every((s, i) => s === full[i])
  );
}

/** Every resource string a file's own `useListQuery` calls query. */
function resourcesIn(clean: string): string[] {
  const found = new Set<string>();
  for (const m of clean.matchAll(
    /\buseListQuery(?:<[^>]*>)?\(\s*["'`]([^"'`]+)["'`]/g,
  )) {
    if (m[1]) found.add(normalize(m[1]));
  }
  return [...found];
}

/**
 * Every `queryKey` a plain `useQuery` declares as its own, verbatim.
 *
 * The distinction this exists to draw: a `useListQuery` resource is always
 * cached under one specific shape — the joined string, alone, as element
 * zero — so any key that does not take that shape is either wrong or aimed
 * at something else entirely. A plain `useQuery` has no such rule; it can
 * declare any array it likes as its own key, and `["shop", "warehouses"]`
 * is exactly as legitimate a key for one of those as `["shop/products"]` is
 * for a `useListQuery` resource. So when an invalidation's key is the
 * *exact, complete* key of a real `useQuery` declared somewhere in the
 * files being scanned, it is already spoken for — it cannot simultaneously
 * be a broken guess at a list's key, because it is somebody else's key,
 * correctly written.
 *
 * This only ever excuses an **exact** match, deliberately. A key that is
 * merely a *prefix* of some other query's key is not excused by this — that
 * shape (shorter than a real key it starts with) is not what a plain
 * `useQuery`'s own key ever looks like when read off this array, and
 * widening the exclusion to prefixes would swallow genuine findings the
 * same way accepting any shared leading segment would.
 */
function otherKeysIn(clean: string): string[][] {
  const found: string[][] = [];
  for (const m of clean.matchAll(/\buseQuery\(/g)) {
    const window = clean.slice(m.index, m.index + 300);
    const km = window.match(/queryKey\s*:\s*\[([^\]]*)\]/);
    if (!km?.[1]) continue;
    const elements = keyElements(km[1]);
    if (elements.length) found.push(segmentsOf(elements.join("/")));
  }
  return found;
}

/**
 * One `queryKey` array's elements, as text — a quoted string keeps its
 * content (normalized), and anything else (a variable, an id) becomes a
 * wildcard segment. Only the count and the joined shape matter: a filter key
 * is compared to the cache key by strict element equality at position zero,
 * so a longer key — the resource plus an id — can only ever be *more*
 * specific than the list, never a match for it, and that is exactly the
 * by-id case that must stay silent.
 */
function keyElements(raw: string): string[] {
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const quoted = part.match(/^["'`]([\s\S]*)["'`]$/);
      return quoted ? normalize(quoted[1] as string) : "*";
    });
}

/**
 * Every matched `{ ... }` pair in the text, as `[open index, close index]`.
 *
 * Blunt on purpose, like the rest of this file: a `{` inside a string or a
 * regex literal is counted like any other, which can mismatch a pair that
 * contains one. Real screens do not put braces in the handful of strings
 * that sit between an invalidation and its neighbours often enough to make
 * this worth a real parser.
 */
function bracePairs(text: string): [number, number][] {
  const stack: number[] = [];
  const pairs: [number, number][] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") stack.push(i);
    else if (text[i] === "}") {
      const open = stack.pop();
      if (open !== undefined) pairs.push([open, i]);
    }
  }
  return pairs;
}

/**
 * The smallest `{ ... }` span containing `index` — the enclosing statement
 * block, `onSuccess` handler, or function body a call sits in. Falls back to
 * the whole text when nothing encloses it (a call outside any braces at
 * all, which does not happen in practice but should not crash if it did).
 */
function innermostBlock(
  pairs: [number, number][],
  index: number,
  textLength: number,
): [number, number] {
  let best: [number, number] = [0, textLength];
  for (const [open, close] of pairs) {
    if (open < index && index < close && close - open < best[1] - best[0]) {
      best = [open, close];
    }
  }
  return best;
}

/**
 * A `queryKey` array's elements read from wherever `invalidateQueries(`
 * starts.
 *
 * The 300-character window exists to find a `queryKey` that is not the very
 * next token — real calls have a few lines of options before it — but a call
 * with no `queryKey` at all, `invalidateQueries()`, or one keyed by a
 * variable, `invalidateQueries({ queryKey: someVar })`, has nothing in its
 * own window for the regex to match. Left unchecked, the same window keeps
 * scanning past that call's end and picks up the *next* call's literal key
 * instead, misattributing it. A `;` or a second `invalidateQueries(` before
 * the match means the window ran off the end of this call's own statement,
 * so it is rejected rather than borrowed.
 */
const INVALIDATE_QUERIES_CALL = "invalidateQueries(";

function parseInvalidation(clean: string, matchIndex: number): string[] | null {
  const window = clean.slice(matchIndex, matchIndex + 300);
  const km = window.match(/queryKey\s*:\s*\[([^\]]*)\]/);
  if (!km?.[1] || km.index === undefined) return null;
  // Skip past this call's own opening — the window always starts with it —
  // so a `;` or a second `invalidateQueries(` is only ever found if the
  // match ran off the end of this call's own statement.
  const before = window.slice(INVALIDATE_QUERIES_CALL.length, km.index);
  if (before.includes(";") || before.includes(INVALIDATE_QUERIES_CALL)) {
    return null;
  }
  const elements = keyElements(km[1]);
  return elements.length ? elements : null;
}

/**
 * Whether some other `invalidateQueries` call in the same enclosing block
 * already invalidates `resource` exactly — the paired, correct form this
 * scanner asks a broad prefix to sit beside rather than replace. Both real
 * examples this was checked against write the pair as two consecutive
 * statements in the same function body, which is exactly what "the same
 * block" catches; it does not chase the pair across an `if`, a callback
 * passed to something else, or another file.
 */
function pairedExplicitly(
  clean: string,
  pairs: [number, number][],
  callIndex: number,
  resource: { segments: string[] },
): boolean {
  const [open, close] = innermostBlock(pairs, callIndex, clean.length);
  const block = clean.slice(open, close);
  for (const m of block.matchAll(/\binvalidateQueries\(/g)) {
    const elements = parseInvalidation(block, m.index);
    if (!elements || elements.length !== 1) continue;
    if (sameSegments(segmentsOf(elements[0] as string), resource.segments)) {
      return true;
    }
  }
  return false;
}

const MARKER = "list-invalidation";

interface ScannedResource {
  joined: string;
  segments: string[];
}

/** One screen's source, ready to be checked against a module's whole resource set. */
export interface ScreenFile {
  path: string;
  source: string;
}

/**
 * Stale invalidations across a module's screens, checked together.
 *
 * Every `useListQuery` resource is collected from every file first, so a
 * mutation in one screen invalidating a list another screen fetches — Shop's
 * product editor refreshing the products list the orders screen's sibling
 * declares — is still caught. Findings carry the file they were found in,
 * since with more than one file a line number alone no longer says where to
 * look.
 */
export function findStaleInvalidations(
  files: ScreenFile[],
): StaleInvalidationFinding[] {
  const cleaned = files.map((f) => ({
    path: f.path,
    rawLines: f.source.split("\n"),
    clean: stripComments(f.source),
  }));

  const resources: ScannedResource[] = [
    ...new Set(cleaned.flatMap((f) => resourcesIn(f.clean))),
  ].map((r) => ({ joined: r, segments: segmentsOf(r) }));
  if (resources.length === 0) return [];

  const otherKeys = cleaned.flatMap((f) => otherKeysIn(f.clean));

  const findings: StaleInvalidationFinding[] = [];

  for (const file of cleaned) {
    const isExcepted = (line: number) =>
      exceptedAbove(file.rawLines, line, MARKER);
    const pairs = bracePairs(file.clean);

    for (const m of file.clean.matchAll(/\binvalidateQueries\(/g)) {
      const elements = parseInvalidation(file.clean, m.index);
      if (!elements) continue;
      const keySegments = segmentsOf(elements.join("/"));
      if (otherKeys.some((k) => sameSegments(k, keySegments))) continue;

      const line = lineOf(file.clean, m.index);
      if (isExcepted(line)) continue;

      // Checked against every resource this key touches, not just the first
      // one found — a broad key can be a proper prefix of several resources
      // at once, correctly paired for one and silently missing another.
      for (const resource of resources) {
        if (sameSegments(keySegments, resource.segments)) {
          if (elements.length > 1) {
            findings.push({
              file: file.path,
              line,
              say: `an invalidation key split across array elements — the cache key is the joined string "${resource.joined}"; use ["${resource.joined}"] or this will never match it`,
            });
          }
          continue;
        }
        if (isProperPrefix(keySegments, resource.segments)) {
          if (!pairedExplicitly(file.clean, pairs, m.index, resource)) {
            findings.push({
              file: file.path,
              line,
              say: `a broad invalidation key that no longer reaches "${resource.joined}" — if this mutation actually changes that list, keep the broad key (it still covers screens that have not converted) and add ["${resource.joined}"] beside it; if it doesn't touch that list, this prefix match is a false alarm`,
            });
          }
        }
      }
    }
  }

  return findings.sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line,
  );
}
