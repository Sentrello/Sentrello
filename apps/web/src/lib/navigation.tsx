import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { setModuleNavigator } from "./module-ui";
import { hasUnsaved } from "./unsaved";

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
  /**
   * A one-shot message to the screen being opened, read once on arrival.
   *
   * Here as well as on `go` because a module's chart has only `open` to reach
   * another screen with — so without it a module could draw a bar and never
   * say what pressing it should narrow to, which is the whole of the feature
   * for every chart outside Core.
   *
   * Not in the address, for the reason `go`'s copy of this gives: it names
   * something the screen should *do* on arrival, and a refresh should not do
   * it again.
   */
  intent?: string;
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
  /**
   * Where somebody asked to go while an editor held unsaved typing.
   *
   * Navigation is refused rather than queued: `null` means nothing is
   * waiting. The shell draws the question and calls `leaveAnyway` or
   * `stayHere`; nothing else should touch these three.
   */
  pending: View | null;
  leaveAnyway: () => void;
  stayHere: () => void;
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
  /**
   * Open a view *in place of* the one being left, not after it.
   *
   * For the case where the address asked for is not a page: `/crm` is a
   * heading and opens the first of its screens. Pushed, that leaves the
   * heading in the history right behind the screen it sent you to — so Back
   * lands on `/crm`, which redirects again, and there is no way past it. The
   * browser's own rule for a redirect is to replace, and so is this.
   */
  redirect: (moduleId: string, title: string) => void;
  /**
   * The screen the address bar asked for and this instance does not have.
   *
   * A path naming nothing put the reader on the dashboard and said nothing
   * about it — so a bookmark to a module that was switched off, a link in an
   * old email, or a typo all looked like the application ignoring a click.
   * The fallback is right; the silence was not. Cleared once read, so a
   * refresh does not bring it back.
   */
  missing: string | null;
  forgetMissing: () => void;
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
  /*
   * What was asked for, when it was something and it is not here.
   *
   * `/` is not a miss — it is how everybody arrives — so only a path that
   * names a first segment counts. The name rather than the whole path,
   * because that is the word somebody would look for in Settings.
   */
  const [missing, setMissing] = useState<string | null>(() => {
    const asked = window.location.pathname
      .replace(/^\/+|\/+$/g, "")
      .split("/")[0];
    if (!asked) return null;
    return viewFromPath(window.location.pathname, known) ? null : asked;
  });

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

  /*
   * The address bar follows the view, not only the click.
   *
   * This ran once, on the first paint, which was enough while every change
   * of view came from a click that had already pushed its own path. It is
   * not enough for a view the application chooses on arrival: a section like
   * `/crm` draws no page of its own and sends you to its first child, and
   * that redirect happens in a child effect — which runs *before* this one.
   * So this replaced the corrected path with the one the page was opened
   * with, and the address bar read `/crm` over the CRM dashboard.
   *
   * Running it whenever the view changes costs nothing: `showPath` returns
   * immediately when the path already matches, which is every ordinary
   * navigation, because those set the path themselves on the way through.
   */
  useEffect(() => {
    showPath(current, true);
  }, [current, showPath]);

  useEffect(() => {
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
  }, [known]);

  const setTitle = useCallback((title: string) => {
    setCurrent((view) => (view.title === title ? view : { ...view, title }));
  }, []);

  /**
   * Somewhere somebody asked to go while an editor held unsaved typing.
   *
   * Every editor in this product replaces the list in place, so the rail and
   * the panel are still beside a half-written invoice and one click threw it
   * away — nothing asked, nothing kept. The navigation is refused and parked
   * here; the shell draws the question.
   *
   * Refused rather than queued on purpose. If the answer is "stay", there
   * is nothing left over to fire later; if it is "leave", the navigation
   * that was refused runs exactly as it would have.
   */
  const [pending, setPending] = useState<View | null>(null);
  /**
   * The navigation itself, held until the question is answered.
   *
   * The destination alone is not enough. `go` clears the trail and `open`
   * extends it, so resuming a parked `go` by doing what `open` does would
   * put somebody on the right screen with the wrong breadcrumb behind them.
   * Each caller parks its own body, and answering "leave" runs that.
   */
  const parked = useRef<(() => void) | null>(null);
  /** True when this navigation may proceed; parks it and returns false when not. */
  const mayLeave = useCallback((to: View, carryOn: () => void) => {
    if (!hasUnsaved()) return true;
    parked.current = carryOn;
    setPending(to);
    return false;
  }, []);

  const open = useCallback(
    (view: View) => {
      const carryOn = () => {
        setTrail((t) => trailAfterOpening(t, currentRef.current, view));
        // Same one-shot slot `go` writes, so a screen reads an intent the same
        // way whichever door it was opened through.
        intentRef.current = view.intent ?? null;
        setCurrent(view);
        showPath(view);
      };
      if (mayLeave(view, carryOn)) carryOn();
    },
    [showPath, mayLeave],
  );

  // A module's screen navigates through the same door Core's own screens do,
  // rather than falling back to the full page load the runtime ships with.
  useEffect(() => {
    setModuleNavigator(open);
  }, [open]);

  const go = useCallback(
    (moduleId: string, title: string, intent?: string) => {
      const carryOn = () => {
        setTrail([]);
        intentRef.current = intent ?? null;
        setCurrent({ moduleId, title });
        showPath({ moduleId, title });
      };
      if (mayLeave({ moduleId, title }, carryOn)) carryOn();
    },
    [showPath, mayLeave],
  );

  const redirect = useCallback(
    (moduleId: string, title: string) => {
      setTrail([]);
      setCurrent({ moduleId, title });
      showPath({ moduleId, title }, true);
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

  /** Run the navigation that was refused, exactly as it would have run. */
  const leaveAnyway = useCallback(() => {
    const carryOn = parked.current;
    parked.current = null;
    setPending(null);
    carryOn?.();
  }, []);

  const stayHere = useCallback(() => {
    // Nothing left over to fire later: if the answer is stay, the
    // navigation that was refused is gone rather than waiting.
    parked.current = null;
    setPending(null);
  }, []);

  const forgetMissing = useCallback(() => setMissing(null), []);

  /*
   * And it goes when you go. The note belongs to the arrival, not to the
   * dashboard: left standing it followed somebody onto Contacts and told
   * them, on a screen they had just asked for, that a different one is not
   * here. The first render is the arrival itself, so the effect only fires
   * from the second view onwards.
   */
  const landed = useRef(current);
  useEffect(() => {
    if (landed.current === current) return;
    landed.current = current;
    setMissing(null);
  }, [current]);

  const value = useMemo<Navigation>(
    () => ({
      current,
      trail,
      pending,
      leaveAnyway,
      stayHere,
      open,
      go,
      redirect,
      backTo,
      setTitle,
      takeIntent,
      missing,
      forgetMissing,
    }),
    [
      current,
      trail,
      pending,
      leaveAnyway,
      stayHere,
      open,
      go,
      redirect,
      backTo,
      setTitle,
      takeIntent,
      missing,
      forgetMissing,
    ],
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
