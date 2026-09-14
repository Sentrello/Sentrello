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
 * refreshes: no error, no failed request, just stale rows. Caught once by a
 * whole-plan review and once more immediately after, in the next module to
 * convert — which is what makes vigilance the wrong tool here.
 *
 * Text in, findings out, same as `ui-drift.ts`: source is read as a string
 * because these are screens built for the browser, not files a test can
 * import.
 */
import { exceptedAbove, lineOf, stripComments } from "./scan-text";

export interface StaleInvalidationFinding {
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
 * Every `queryKey` a plain `useQuery` in the file declares as its own.
 *
 * `["shop", "warehouses"]` reads exactly like the split-array mistake this
 * scanner exists to catch, and it sits beside a `useListQuery` resource whose
 * own path happens to start the same way — `"shop/warehouses/${id}/stock"`.
 * It is neither: it is the real, correct key for a different, ordinary list
 * fetched with a plain `useQuery`, declared right there in the same file. A
 * key that already names a genuine cache entry is never a stale guess at
 * someone else's, so it is collected here to be excluded rather than flagged.
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

const MARKER = "list-invalidation";

export function findStaleInvalidations(
  source: string,
): StaleInvalidationFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const isExcepted = (line: number) => exceptedAbove(rawLines, line, MARKER);

  const resources = resourcesIn(clean).map((r) => ({
    joined: r,
    segments: segmentsOf(r),
  }));
  if (resources.length === 0) return [];

  const otherKeys = otherKeysIn(clean);
  const findings: StaleInvalidationFinding[] = [];

  for (const m of clean.matchAll(/\binvalidateQueries\(/g)) {
    const window = clean.slice(m.index, m.index + 300);
    const km = window.match(/queryKey\s*:\s*\[([^\]]*)\]/);
    if (!km?.[1]) continue;

    const elements = keyElements(km[1]);
    if (elements.length === 0) continue;
    const keySegments = segmentsOf(elements.join("/"));
    if (otherKeys.some((k) => sameSegments(k, keySegments))) continue;

    const line = lineOf(clean, m.index);
    if (isExcepted(line)) continue;

    for (const resource of resources) {
      if (sameSegments(keySegments, resource.segments)) {
        if (elements.length > 1) {
          findings.push({
            line,
            say: `an invalidation key split across array elements — the cache key is the joined string "${resource.joined}"; use ["${resource.joined}"] or this will never match it`,
          });
        }
        break;
      }
      if (isProperPrefix(keySegments, resource.segments)) {
        findings.push({
          line,
          say: `a broad invalidation key that no longer reaches "${resource.joined}" — keep it (it still covers screens that have not converted) and add ["${resource.joined}"] beside it`,
        });
        break;
      }
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}
