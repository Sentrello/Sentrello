import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

/**
 * Where you are, and how you got there.
 *
 * The old model was a module id in a `useState` — enough to answer "which
 * screen", and nothing else. It is why the application cannot currently show
 * what connects to what: a deal has no way to open the contact it belongs to,
 * because there is nowhere to say "the contact, this one" and nothing to
 * remember you came from the deal.
 *
 * This is the smallest thing that fixes that. A view names a module, and
 * optionally a record inside it. Opening one keeps the trail, so a screen can
 * offer the way back — which is what a chain of contact → deal → invoice needs
 * in order not to feel like getting lost.
 */
export interface View {
  /** The module that owns the screen — matches what the server registered. */
  moduleId: string;
  /** A record within it. Absent means the module's list. */
  recordId?: string;
  /** What to call this in a breadcrumb. */
  title: string;
}

interface Navigation {
  current: View;
  /**
   * What the record on screen turns out to be called.
   *
   * A deep link carries an id and no name — the URL cannot know that
   * `/contacts/8f3…` is Ada Lovelace. The screen that loads the record does,
   * and tells the shell, so a refreshed page has the same heading as one that
   * was navigated to.
   */
  setTitle: (title: string) => void;
  /** Everything opened to get here, oldest first, excluding `current`. */
  trail: View[];
  /** Open a view, remembering where you were. */
  open: (view: View) => void;
  /**
   * Jump to a module's list, forgetting the trail — a top-nav click.
   *
   * `intent` is a one-shot message to the screen being opened: "arrive with
   * the new-contact form already up". Deliberately not in the URL — it names
   * something the screen should *do* on arrival, and a refresh should not do
   * it again.
   */
  go: (moduleId: string, title: string, intent?: string) => void;
  /**
   * The intent this screen was opened with, read once and cleared.
   *
   * Returns it on the render after the navigation and null on every render
   * after that, so a screen can open a form without it springing back up each
   * time the component re-renders.
   */
  takeIntent: () => string | null;
  /** Step back to a point in the trail. */
  backTo: (index: number) => void;
}

const NavigationContext = createContext<Navigation | null>(null);

/**
 * The address bar is the state.
 *
 * Until now a view lived only in React state: a refresh landed on the
 * dashboard, a deep link was impossible, and the browser's own back button
 * left the application. None of that is acceptable in something people work in
 * all day — "send me a link to that invoice" is the most ordinary request
 * there is.
 *
 * The shape is deliberately boring: `/contacts` for a list, `/contacts/:id`
 * for a record. It maps one-to-one onto what a view already was, so nothing
 * else in the application has to learn about routing.
 */
export function pathOf(view: View): string {
  return view.recordId
    ? `/${view.moduleId}/${encodeURIComponent(view.recordId)}`
    : `/${view.moduleId}`;
}

/**
 * A path back into a view, or nothing.
 *
 * Nothing means the module is not one this instance loaded — an old bookmark,
 * a link from somebody with modules this licence does not include, or a typo.
 * The caller lands on the usual first screen instead, which is a better answer
 * than an empty shell.
 */
export function viewFromPath(
  pathname: string,
  known: { id: string; label: string }[],
): View | null {
  const [moduleId, recordId] = pathname
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .map((part) => decodeURIComponent(part));
  if (!moduleId) return null;

  const entry = known.find((n) => n.id === moduleId);
  if (!entry) return null;

  return recordId
    ? { moduleId, recordId, title: entry.label }
    : { moduleId, title: entry.label };
}

/**
 * Where the trail goes when something is opened.
 *
 * Pulled out of `NavigationProvider.open` so it can be tested as itself
 * rather than restated in a test file. `navigation.test.tsx` used to hold a
 * copy of this rule under a comment saying it mirrored the component, which
 * meant the test could not fail when the component broke — the one thing a
 * test is for. `open` below calls this, so there is nothing left to drift.
 *
 * Re-opening something already in the trail is going back to it, not deeper:
 * otherwise contact -> deal -> the same contact grows for ever and the
 * breadcrumb becomes a lie.
 */
export function trailAfterOpening(
  trail: View[],
  leaving: View,
  opening: View,
): View[] {
  const seen = trail.findIndex(
    (v) => v.moduleId === opening.moduleId && v.recordId === opening.recordId,
  );
  return seen !== -1 ? trail.slice(0, seen) : [...trail, leaving];
}

export function NavigationProvider({
  initial,
  known = [],
  children,
}: {
  initial: View;
  /** The modules this instance loaded, so a path can be checked against them. */
  known?: { id: string; label: string }[];
  children: React.ReactNode;
}) {
  const [current, setCurrent] = useState<View>(
    () => viewFromPath(window.location.pathname, known) ?? initial,
  );
  const [trail, setTrail] = useState<View[]>([]);

  // `open` reads the view it is leaving. A ref keeps that out of its dependency
  // list, so the callback stays stable and every screen does not re-render on
  // each navigation.
  const currentRef = useRef(current);
  currentRef.current = current;
  /** What the next screen was asked to do on arrival. Cleared once read. */
  const intentRef = useRef<string | null>(null);

  /**
   * The address bar follows, and the back button works.
   *
   * `replace` for the first paint so a refresh does not add an entry, `push`
   * for everything after: pressing back should undo one navigation, not walk
   * out of the application.
   */
  const showPath = useCallback((view: View, replace = false) => {
    const path = pathOf(view);
    if (window.location.pathname === path) return;
    window.history[replace ? "replaceState" : "pushState"]({}, "", path);
  }, []);

  useEffect(() => {
    showPath(currentRef.current, true);

    const onPop = () => {
      const view = viewFromPath(window.location.pathname, known);
      // A path this instance does not have is not navigated to; the screen
      // simply stays, which is what a browser does with an unknown fragment.
      if (view) {
        setCurrent(view);
        // The trail is not in the URL, and reconstructing it from history
        // would be a guess. Stepping back leaves the breadcrumb behind rather
        // than showing one that is wrong.
        setTrail([]);
      }
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // `known` is the loaded module list: stable for the life of the session.
  }, [showPath, known]);

  const setTitle = useCallback((title: string) => {
    setCurrent((view) => (view.title === title ? view : { ...view, title }));
  }, []);

  const open = useCallback(
    (view: View) => {
      setTrail((t) => trailAfterOpening(t, currentRef.current, view));
      setCurrent(view);
      showPath(view);
    },
    [showPath],
  );

  const go = useCallback(
    (moduleId: string, title: string, intent?: string) => {
      setTrail([]);
      intentRef.current = intent ?? null;
      setCurrent({ moduleId, title });
      showPath({ moduleId, title });
    },
    [showPath],
  );

  /**
   * A ref rather than state: reading an intent must not itself cause a render,
   * or the screen that consumed it re-renders, consumes null, and closes the
   * form it had just opened.
   */
  const takeIntent = useCallback(() => {
    const intent = intentRef.current;
    intentRef.current = null;
    return intent;
  }, []);

  const backTo = useCallback(
    (index: number) => {
      setTrail((t) => {
        const target = t[index];
        if (target) {
          setCurrent(target);
          showPath(target);
        }
        return t.slice(0, index);
      });
    },
    [showPath],
  );

  const value = useMemo<Navigation>(
    () => ({ current, trail, open, go, backTo, setTitle, takeIntent }),
    [current, trail, open, go, backTo, setTitle, takeIntent],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): Navigation {
  const ctx = useContext(NavigationContext);
  if (!ctx) throw new Error("useNavigation used outside NavigationProvider");
  return ctx;
}

/**
 * The record on screen, named.
 *
 * A deep link carries an id and no name, so the heading and the breadcrumb
 * would otherwise say "Contacts" above a person's page after a refresh and
 * their name after a click. The screen knows once its data lands; this is how
 * it says so.
 */
export function useRecordTitle(title: string | null | undefined): void {
  const { setTitle } = useNavigation();
  useEffect(() => {
    if (title) setTitle(title);
  }, [title, setTitle]);
}

/**
 * A link to a related record.
 *
 * The point of the whole file: a deal can render `<RelatedLink>` for its
 * contact, and the contact opens with a way back to the deal. Modules get this
 * without knowing anything about routing.
 */
export function RelatedLink({
  to,
  children,
}: {
  to: View;
  children: React.ReactNode;
}) {
  const { open } = useNavigation();
  return (
    <button type="button" onClick={() => open(to)} className="link">
      {children}
    </button>
  );
}

/** The trail, rendered. Nothing at all when you are at the top. */
export function Breadcrumb() {
  const { trail, current, backTo } = useNavigation();
  if (!trail.length) return null;

  return (
    <nav className="breadcrumb mb-2 flex flex-wrap items-center gap-1">
      {trail.map((view, i) => (
        <span key={`${view.moduleId}-${view.recordId ?? "list"}`}>
          <button type="button" onClick={() => backTo(i)}>
            {view.title}
          </button>
          <span className="mx-1">/</span>
        </span>
      ))}
      <span style={{ color: "var(--text)" }}>{current.title}</span>
    </nav>
  );
}
