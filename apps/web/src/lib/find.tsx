import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { useNavigation } from "./navigation";

/**
 * Find anything, from anywhere.
 *
 * The commonest thing somebody does after looking at today's figures is look
 * for one particular thing. Every list screen here can already filter itself,
 * which helps if you are on the right screen — and knowing which screen is most
 * of the work, especially for the person who uses this twice a week rather than
 * all day.
 *
 * Opened with ⌘K or Ctrl-K, and by a button that says so. **The shortcut alone
 * is not a door**: it is a feature for people who already know it exists, and
 * the ones most helped by search are the least likely to have read about it.
 */

interface Hit {
  kind: string;
  title: string;
  subtitle?: string | null;
  opens: { moduleId: string; recordId?: string };
}

export function FindButton() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="hidden items-center gap-2 rounded border px-2 py-1 text-sm sm:flex"
        style={{ borderColor: "var(--border)", opacity: 0.75 }}
      >
        Find anything
        {/*
          The shortcut shown rather than only bound, because a shortcut nobody
          is told about is a shortcut for the people who did not need it.
        */}
        <kbd className="text-xs opacity-70">⌘K</kbd>
      </button>
      {open ? <FindDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function FindDialog({ onClose }: { onClose: () => void }) {
  const { go, open: openRecord } = useNavigation();
  const [q, setQ] = useState("");
  const [at, setAt] = useState(0);
  const box = useRef<HTMLInputElement>(null);

  useEffect(() => {
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const found = useQuery({
    queryKey: ["search", q],
    queryFn: () =>
      api<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(q)}`),
    // Below two letters the server answers nothing, so there is no point asking.
    enabled: q.trim().length >= 2,
  });

  const hits = found.data?.hits ?? [];
  /*
   * A record opens as a record, and a list opens as a list.
   *
   * `go` forgets the trail, which is right for "take me to Contacts" and wrong
   * for "take me to Ruth": arriving at a person with no breadcrumb behind them
   * is arriving somewhere with no way back that says where you were.
   */
  const open = (hit: Hit) => {
    if (hit.opens.recordId) {
      openRecord({
        moduleId: hit.opens.moduleId,
        recordId: hit.opens.recordId,
        title: hit.title,
      });
    } else {
      go(hit.opens.moduleId, hit.title);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-24">
      {/*
        The backdrop is a button rather than a div with a click on it.
        
        A div that closes things when clicked is invisible to a keyboard and to
        a screen reader, and the usual answer — suppressing the rule — makes the
        warning go away rather than the problem. A button is reachable, sayable
        and closes on Enter for free.
      */}
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default"
        style={{ background: "rgba(0,0,0,.4)" }}
      />
      {/*
        A real dialog element rather than a div wearing the role. It brings the
        semantics with it, and a browser that knows it is a dialog does the
        right things about focus and about what is behind it.
      */}
      <dialog
        open
        aria-label="Find anything"
        className="relative w-full max-w-xl overflow-hidden rounded-lg border p-0 shadow-lg"
        style={{ background: "var(--surface)", borderColor: "var(--border)" }}
      >
        <input
          ref={box}
          value={q}
          placeholder="A name, a number, anything"
          aria-label="What are you looking for?"
          className="w-full border-b px-4 py-3 text-base outline-none"
          style={{ background: "transparent", borderColor: "var(--border)" }}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setAt((n) => Math.min(n + 1, hits.length - 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setAt((n) => Math.max(n - 1, 0));
            }
            if (e.key === "Enter" && hits[at]) open(hits[at]);
          }}
        />

        <div className="max-h-80 overflow-y-auto">
          {q.trim().length < 2 ? (
            <p className="px-4 py-6 text-sm" style={{ opacity: 0.7 }}>
              Type at least two letters. Contacts, companies, deals, invoices —
              whatever this instance has.
            </p>
          ) : found.isLoading ? (
            <p className="px-4 py-6 text-sm" style={{ opacity: 0.7 }}>
              Looking…
            </p>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-sm" style={{ opacity: 0.7 }}>
              Nothing matched “{q}”.
            </p>
          ) : (
            hits.map((hit, i) => (
              <button
                key={`${hit.kind}-${hit.opens.recordId ?? hit.title}`}
                type="button"
                onMouseEnter={() => setAt(i)}
                onClick={() => open(hit)}
                className="flex w-full items-baseline gap-3 px-4 py-2 text-left"
                style={
                  i === at ? { background: "var(--surface-raised)" } : undefined
                }
              >
                <span className="text-xs uppercase" style={{ opacity: 0.6 }}>
                  {hit.kind}
                </span>
                <span className="flex-1">{hit.title}</span>
                {hit.subtitle ? (
                  <span className="text-sm" style={{ opacity: 0.7 }}>
                    {hit.subtitle}
                  </span>
                ) : null}
              </button>
            ))
          )}
        </div>
      </dialog>
    </div>
  );
}
