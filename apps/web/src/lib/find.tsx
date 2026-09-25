import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Icon } from "./icons";
import { useNavigation } from "./navigation";
import { Warning, muted } from "./ui";

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
      {/*
        On a phone this was `hidden`, so there was no way to search at all.
        Which is the wrong way round: the panel is away on a small screen and
        the rail is icons, so finding one invoice meant a module, a screen and
        a scroll, where search is one press. Nobody had noticed because
        nothing had ever opened the product at phone width.

        The same button throughout, with the words and the shortcut dropping
        away rather than the control. A shortcut is no use on a phone and the
        label is what the magnifier already says.
      */}
      {/*
        Drawn as the field it opens, not as a small button beside the avatar.

        It was `opacity: 0.75` over a transparent background, which is fine on
        white and close to invisible in the dark: the panel behind it is
        already dim, so dimming a faint border against it leaves an outline
        nobody can find. Opacity also hides from the contrast test, which
        measures declared token pairs and cannot see a multiplier.

        So: a sunken surface and a real border. Nothing here is transparent
        and nothing is dimmed.

        The words are `--text`, not `--text-muted`. A muted prompt is the
        convention for a field somebody is about to type into, and it was
        still too quiet to read against the dark panel — this is a label on
        a control, not placeholder text waiting to be replaced. The magnifier
        and the shortcut stay muted, because those are hints beside the words
        rather than the words themselves.
      */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Find anything"
        className="flex h-9 w-9 flex-none items-center gap-2.5 rounded-md border px-2 text-sm sm:w-full sm:max-w-sm sm:flex-1 sm:px-3"
        style={{
          borderColor: "var(--border)",
          background: "var(--surface-sunken)",
          color: "var(--text)",
        }}
      >
        <span style={{ color: "var(--text-muted)" }} className="flex">
          <Icon name="search" size={16} />
        </span>
        <span className="hidden flex-1 text-left sm:inline">Find anything</span>
        {/*
          The shortcut shown rather than only bound, because a shortcut nobody
          is told about is a shortcut for the people who did not need it. It
          takes the muted token rather than a dimming of the words above it —
          nested opacity multiplies, and that is how this hint reached 3.49:1
          against white on every screen in the product.
        */}
        <kbd
          className="hidden text-xs sm:inline"
          style={{ color: "var(--text-muted)" }}
        >
          ⌘K
        </kbd>
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
        style={{ background: "var(--scrim)" }}
      />
      {/*
        A real dialog element rather than a div wearing the role. It brings the
        semantics with it, and a browser that knows it is a dialog does the
        right things about focus and about what is behind it.
      */}
      <dialog
        open
        aria-label="Find anything"
        className="overlay-panel relative w-full max-w-xl overflow-hidden rounded-lg border p-0 border-line"
      >
        {/*
          No `outline-none`. It was there to keep the flush top edge clean, and
          what it actually did was take the focus ring off the only focusable
          thing in the palette — the browser's own ring is the one indicator
          that adapts to both themes, and removing it fails WCAG 2.4.7 for the
          sake of a border.
        */}
        <input
          ref={box}
          value={q}
          placeholder="A name, a number, anything"
          aria-label="What are you looking for?"
          className="w-full border-b px-4 py-3 text-base"
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
            <p className="px-4 py-6 text-sm" style={muted}>
              Type at least two letters. Contacts, companies, deals, invoices —
              whatever this instance has.
            </p>
          ) : found.isLoading ? (
            <p className="px-4 py-6 text-sm" style={muted}>
              Looking…
            </p>
          ) : found.error ? (
            /*
             * Before the empty branch, deliberately.
             *
             * A search that failed has no hits either, so it used to fall
             * through to "Nothing matched" — the app stating, about the
             * business's own records, something it had no way of knowing.
             * Somebody looking for a contact they are certain exists is then
             * told it does not, which is the worst answer a search can give.
             */
            <div className="px-4 py-6">
              <Warning>The search did not run. Try again in a moment.</Warning>
            </div>
          ) : hits.length === 0 ? (
            <p className="px-4 py-6 text-sm" style={muted}>
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
                  i === at ? { background: "var(--surface-sunken)" } : undefined
                }
              >
                <span className="text-xs uppercase" style={muted}>
                  {hit.kind}
                </span>
                <span className="flex-1">{hit.title}</span>
                {hit.subtitle ? (
                  <span className="text-sm" style={muted}>
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
