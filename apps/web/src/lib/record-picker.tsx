import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { api } from "./api";
import { Warning, border, muted } from "./ui";

/**
 * Choosing one record out of however many a business has.
 *
 * Every customer picker in this application was a `<select>` filled from
 * `/api/contacts` with no paging — the whole table, into the browser, on every
 * screen that names a customer. That list is capped at a thousand rows, and
 * the cap is right: past about thirty thousand the request stopped working at
 * all. What was wrong is what the screens did with it, which was nothing. A
 * business with four thousand customers opened a picker, typed a name, and the
 * person simply was not there — no message, no "showing 1,000 of 4,300". The
 * obvious conclusion is that the customer was never added.
 *
 * So the list is not fetched at all. The server searches as somebody types,
 * over every field that list already searches, and returns a short page of
 * matches with the real total beside it. Nothing is filtered in the browser,
 * nothing is capped silently, and the twenty rows on screen cost twenty rows.
 *
 * **It says what it is showing.** Twenty of four hundred matches is stated in
 * words, with what to do about it — type more of the name — rather than left
 * for somebody to work out from a list that ends.
 */

export interface PickableRecord {
  id: string;
  name: string;
  [key: string]: unknown;
}

/** Somebody has stopped typing. Long enough not to query per keystroke. */
function useSettled(value: string, ms = 200): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How many matches are offered at once. */
const PAGE = 20;

export function useRecordSearch<T extends PickableRecord>(
  path: string,
  resource: string,
  term: string,
  enabled: boolean,
) {
  const settled = useSettled(term);
  return useQuery({
    queryKey: [resource, "search", settled],
    enabled,
    queryFn: () =>
      api<Record<string, T[] | number>>(
        `${path}?q=${encodeURIComponent(settled)}&perPage=${PAGE}&page=1&sort=name&order=asc`,
      ).then((body) => ({
        rows: (body[resource] as T[]) ?? [],
        total: typeof body.total === "number" ? body.total : 0,
      })),
  });
}

/**
 * The line under the results, when there are more than fit.
 *
 * A person cannot act on "truncated: true". They can act on "showing 20 of
 * 431 — type more of the name".
 */
function Counted({ shown, total }: { shown: number; total: number }) {
  if (total <= shown) return null;
  return (
    <p className="px-2 py-1 text-xs" style={muted}>
      Showing {shown} of {total} matches — type more of the name to narrow it.
    </p>
  );
}

export function RecordPicker<T extends PickableRecord>({
  path,
  resource,
  value,
  onChange,
  placeholder = "Search…",
  clearLabel = "None",
  noun = "record",
}: {
  /** The list endpoint, e.g. "/api/contacts". */
  path: string;
  /** The key the endpoint returns its rows under, e.g. "contacts". */
  resource: string;
  /** What is chosen now, with its name, or nothing. */
  value: { id: string; name: string } | null;
  onChange: (picked: T | null) => void;
  placeholder?: string;
  /** The wording for choosing nobody. Absent means the choice is required. */
  clearLabel?: string | null;
  noun?: string;
}) {
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const results = useRecordSearch<T>(path, resource, term, open);

  // Clicking anywhere else puts it away. Without this the results sit over the
  // rest of the form until something else is typed into it.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const choose = (row: T | null) => {
    onChange(row);
    setTerm("");
    setOpen(false);
  };

  return (
    <div className="relative" ref={box}>
      <input
        type="search"
        /*
         * Only while there is something to control.
         *
         * `aria-controls` pointed at the results list whether or not the
         * results list existed, and it exists only while the picker is open —
         * so on a screen at rest this was a reference to an id that is in no
         * document. Axe calls that `aria-valid-attr-value` and rates it
         * critical, because a screen reader following the reference lands
         * nowhere; it failed every screen carrying a picker, not just the one
         * the report named.
         */
        aria-controls={open ? listId : undefined}
        value={open ? term : (value?.name ?? "")}
        placeholder={value ? value.name : placeholder}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setTerm(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        className="w-full rounded border px-2 py-1.5 text-sm"
        style={{
          background: "var(--surface-raised)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />
      {open ? (
        <div
          id={listId}
          className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded border shadow"
          style={{ ...border, background: "var(--surface-raised)" }}
        >
          {/*
           * Plain buttons rather than a hand-built listbox. Each one is in the
           * tab order and announced as what it is, which a `div role="listbox"`
           * is not unless every key is reimplemented — and a half-built one is
           * worse for a screen reader than no ARIA at all.
           */}
          <ul>
            {clearLabel ? (
              <li>
                <button
                  type="button"
                  onClick={() => choose(null)}
                  className="block w-full px-2 py-1.5 text-left text-sm"
                  style={muted}
                >
                  {clearLabel}
                </button>
              </li>
            ) : null}
            {(results.data?.rows ?? []).map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => choose(row)}
                  className="block w-full px-2 py-1.5 text-left text-sm hover:opacity-80"
                >
                  {row.name}
                </button>
              </li>
            ))}
          </ul>
          {results.isLoading ? (
            <p className="px-2 py-1.5 text-sm" style={muted}>
              Searching…
            </p>
          ) : null}
          {/* Before the empty line below, for the reason `find.tsx` gives:
              a lookup that failed has no rows either, and saying "no matches"
              about records nobody managed to read is a claim we cannot make. */}
          {results.error ? (
            <div className="px-2 py-1.5">
              <Warning>That list did not load. Try again in a moment.</Warning>
            </div>
          ) : null}
          {results.data?.rows.length === 0 &&
          !results.isLoading &&
          !results.error ? (
            <p className="px-2 py-1.5 text-sm" style={muted}>
              {term.trim()
                ? `No ${noun} matches “${term.trim()}”.`
                : `No ${noun} yet.`}
            </p>
          ) : null}
          <Counted
            shown={results.data?.rows.length ?? 0}
            total={results.data?.total ?? 0}
          />
        </div>
      ) : null}
    </div>
  );
}
