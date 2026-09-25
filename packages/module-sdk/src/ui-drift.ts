/**
 * What a screen built for itself that the platform already provides.
 *
 * Run over Core's screens and over every module's, so the answer to "why does
 * this module look different" stops being something somebody has to notice.
 * Text in, findings out — the file reading is the caller's, which is what lets
 * three repositories share one scanner.
 *
 * Deliberately blunt. It reads source as text rather than parsing it, so it can
 * be fooled by a string containing markup; a scanner that is wrong twice a year
 * and costs nothing beats a parser nobody maintains.
 */
import { exceptedAbove, lineOf, stripComments } from "./scan-text";

const RULES: { pattern: RegExp; say: string }[] = [
  {
    /*
     * A link class on a block of text.
     *
     * `.link-muted` and `.link-danger` carry `display: inline-flex` and a 24px
     * minimum height, because they exist for the Edit and Remove links at the
     * end of a table row where a tap target has to be hittable. Put one on a
     * `<p>` and the paragraph goes inline with it — two of them then sit flush
     * against each other with no space between, which is how the sign-in page
     * came to read "Powered by SentrelloSource code" under every form a
     * customer sees before they have an account.
     */
    pattern: /<p(?=[\s>])[^>]*className="[^"]*\blink-(?:muted|danger)\b/,
    say: "a link class on a paragraph — it carries display:inline-flex for a tap target, so the paragraph goes inline and runs into the next one. Put the class on the <a> and colour the paragraph with `muted`",
  },
  {
    pattern: /<h[23](?=[\s>])[^>]*(?:className|style)=/,
    say: "a section heading styled by hand — use SectionHeading, which also gets the level right",
  },
  {
    pattern: /<h[23]\s*>/,
    say: "an unstyled section heading, which renders at whatever size the browser picks — use SectionHeading",
  },
  {
    pattern: /\[\s*page\s*,\s*setPage\s*\]\s*=\s*useState/,
    say: "paging written by hand — use listUi.useListState, which Core's lists use",
  },
  {
    pattern: /\[\s*perPage\s*,\s*setPerPage\s*\]\s*=\s*useState/,
    say: "a page size written by hand — listUi.useListState carries PER_PAGE_CHOICES",
  },
];

/**
 * A tab strip that never became `ui.Tabs`.
 *
 * `setTab` names the state a hand-rolled strip needs to change tab; `<Tabs`
 * names the one primitive that already draws one. A screen with the first and
 * not the second is exactly the case two Core screens were found in — checked
 * against Core's own seven tab-bearing screens rather than assumed, because a
 * heuristic this blunt earns its keep only if it is right.
 */
const TAB_PATTERN = /\bsetTab\b/;
const HAS_TABS_COMPONENT = /<Tabs\b/;
const TAB_FINDING =
  "a tab strip built by hand — use ui.Tabs, which Core's own screens use";

/**
 * Excepts the line below it, with a reason — the only way to silence a
 * finding. A comment saying "leave it, note why" suppresses nothing on its
 * own; this does, and the reason sits on the line the next person editing it
 * will actually read.
 *
 *   // ui-drift-ignore: page resets elsewhere, a plain counter is safe here
 *   const [page, setPage] = useState(1);
 */
export interface HandRolledFinding {
  line: number;
  say: string;
}

/**
 * A fill token written where a text token belongs.
 *
 * The platform's status colours come in pairs: `--color-*` is the fill —
 * chart bars, the danger button, a border — and `--text-*` is the same idea
 * as a word, which each theme sets against its own surfaces. The fills are
 * tuned to be read *on*, not read *as*: dark enough for white text on light
 * paper, which made every status word in the dark theme measure around 3:1
 * against WCAG's 4.5:1 the first time anyone looked. `color:` with a fill
 * token is that mistake being made again, one screen at a time.
 *
 * `border-color`/`borderColor` and `background` are deliberately not
 * flagged — a fill at 3:1 is a legal graphic, and that is what fills are for.
 */
const FILL_AS_TEXT: { pattern: RegExp; say: string }[] = [
  {
    pattern:
      /(?<!-)\bcolor\s*[:=][^;{}]{0,160}var\(--color-(success|warning|danger|info)\)/,
    say: "a fill token written as text — status words use var(--text-success|-warning|-danger|-info), which dark mode can read",
  },
  {
    pattern: /(?<!-)\bcolor\s*[:=][^;{}]{0,160}var\(--brand-on-white-text\)/,
    say: "the brand fill written as text — use var(--text-brand), which dark mode can read",
  },
];

export function findFillAsText(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const findings: HandRolledFinding[] = [];
  for (const rule of FILL_AS_TEXT) {
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (const match of clean.matchAll(global)) {
      const line = lineOf(clean, match.index);
      if (exceptedAbove(rawLines, line, "ui-drift")) continue;
      findings.push({ line, say: rule.say });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * A raised surface that chose its own shadow instead of inheriting the rule.
 *
 * The platform's elevation rule is stated once, in Core's `index.css`: **light
 * lifts with a shadow, dark lifts with the surface.** A black shadow is what
 * every component library ships and it is half a rule — on a near-black ground
 * it does nothing. Measured in the browser: a bottom sheet lifted by
 * `rgb(0 0 0 / 28%)` over `oklch(0.189)` reads as a faint dark haze, so the
 * sheet, the dialog behind it and the dropdown behind that are three flat
 * rectangles and nobody can tell what is on top of what. That is a usability
 * defect on a screen somebody uses all day, and no automated accessibility
 * check catches it — axe does not test whether a thing looks raised.
 *
 * So: `var(--shadow-raised)` for something sitting on the page, and the pair
 * `var(--surface-overlay)` + `var(--shadow-overlay)` for something over it —
 * a menu, a dropdown, a dialog, a sheet, the command palette. `var(--scrim)`
 * behind a modal. Each is defined per theme, so a module gets both themes by
 * writing neither.
 *
 * Tailwind's `shadow-sm`/`shadow-lg` are findings for the same reason a
 * literal is: the utility compiles the colour into the class at build time,
 * which is a hard-coded black by another name.
 *
 * A page that genuinely has no theme to inherit — a standalone customer-facing
 * document with its own palette — says so on the line above and is left alone.
 */
const UNTHEMED_ELEVATION: { pattern: RegExp; say: string }[] = [
  {
    pattern:
      /\bbox-?[Ss]hadow\s*[:=][^;{}]{0,200}(?:#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\s*\(|\b0\s+0\s+0\s*\/)/,
    say: "a shadow with a colour written into it — a black shadow is invisible on the dark theme's ground, which makes a sheet, a dialog and a dropdown read as three flat panels. Use var(--shadow-raised), or var(--surface-overlay) with var(--shadow-overlay) for something floating over the page",
  },
  {
    pattern: /(?<![\w-])shadow-(?:2xs|xs|sm|md|lg|xl|2xl)(?![\w-])/,
    say: "a Tailwind elevation utility, which compiles a fixed black into the class — use raised-panel, or overlay-panel for something floating over the page, both of which change with the theme",
  },
  {
    pattern:
      /\bbackground(?:-color|Color)?\s*[:=][^;{}]{0,80}(?:\brgba?\s*\(\s*0\s*[,\s]\s*0\s*[,\s]\s*0\b|#000(?:000)?\b)/,
    say: "a modal scrim written as literal black — use var(--scrim), which is tinted with the theme's own ink on light and plain black on dark",
  },
];

export function findUnthemedElevation(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const findings: HandRolledFinding[] = [];
  for (const rule of UNTHEMED_ELEVATION) {
    const global = new RegExp(rule.pattern.source, `${rule.pattern.flags}g`);
    for (const match of clean.matchAll(global)) {
      const line = lineOf(clean, match.index);
      if (exceptedAbove(rawLines, line, "ui-drift")) continue;
      findings.push({ line, say: rule.say });
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * A border colour with no border width, which draws nothing at all.
 *
 * Tailwind's preflight sets `border-width: 0` on every element. So an element
 * carrying `style={border}` — the exported `{ borderColor: "var(--border)" }`
 * — and no `border` class has a colour for a line it never draws. The author
 * plainly meant a line; the screen has none; nothing anywhere says so.
 *
 * Three were found in Pro on 25 September, all written months apart by
 * somebody expecting an edge: a notes textarea with no visible box at all, a
 * list of saved boards with no rule between them, and a Gantt chart with no
 * frame round its scrolling area.
 *
 * Matched on the opening tag rather than the line, because the class list and
 * the style object are often several lines apart on a formatted element.
 */
export function findColourWithoutBorder(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const findings: HandRolledFinding[] = [];
  const tags = /<[a-zA-Z][a-zA-Z0-9.]*\s[^<>]{0,600}?>/gs;
  for (const match of clean.matchAll(tags)) {
    const tag = match[0];
    const usesToken =
      /style=\{(?:ui\.)?border\}/.test(tag) ||
      /style=\{\{[^}]*\.\.\.(?:ui\.)?border\b/.test(tag) ||
      /borderColor:\s*"var\(--border\)"/.test(tag);
    if (!usesToken) continue;
    const classes = tag.match(/className="([^"]*)"/)?.[1] ?? "";
    // `border`, `border-t`, `border-x` — but not `border-line`, which is a
    // colour, nor `border-2`, which would have matched anyway.
    if (/\bborder(-[trblxy])?\b(?![-:\w])/.test(classes)) continue;
    const line = lineOf(clean, match.index);
    if (exceptedAbove(rawLines, line, "ui-drift")) continue;
    findings.push({
      line,
      say: "a border colour with no border width — preflight sets every border to 0, so this line is never drawn. Add `border` (or `border-t`, `border-b`…) beside it.",
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * A container's vertical rhythm written as a number instead of named.
 *
 * `space-y-*` is never a one-off decision. It is always the gap between the
 * things stacked inside a container, which is exactly what `--gap-stack` and
 * `--gap-tight` are for. Six different rhythms were in use across a hundred
 * and twenty screens — `space-y-4` sixty times, `space-y-1` forty-three,
 * `space-y-2` thirty-two — for what was almost always the same relationship
 * between the same two kinds of thing.
 *
 * Write `flex flex-col gap-(--gap-stack)` instead. It says what the number
 * stood in for, and one edit to the token moves every screen at once.
 *
 * **`space-y-*` only, on purpose.** The first draft also caught bare `gap-2`
 * through `gap-6` and found 375 things in core, most of them legitimate: the
 * `gap-2` between an icon and the word beside it is a real decision about two
 * things that belong together, not a container's rhythm. A guard that demands
 * a token for all of those produces noise until somebody suppresses it, and a
 * suppressed guard protects nothing.
 *
 * Held back from 25 September until the sweep that makes it pass was
 * finished, because a guard added before the thing it guards is a red suite
 * people learn to ignore. Armed when the count reached zero across Core, Pro
 * and Modules.
 */
export function findOwnVerticalRhythm(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const findings: HandRolledFinding[] = [];
  for (const match of clean.matchAll(/className="[^"]*?\b(space-y-[\d.]+)/g)) {
    const line = lineOf(clean, match.index);
    if (exceptedAbove(rawLines, line, "ui-drift")) continue;
    findings.push({
      line,
      say: `\`${match[1]}\` is a container's rhythm written as a number. Use \`flex flex-col gap-(--gap-stack)\`, or \`gap-(--gap-tight)\` where the things belong together.`,
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

export function findHandRolledUi(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const isExcepted = (line: number) =>
    exceptedAbove(rawLines, line, "ui-drift");

  const findings: HandRolledFinding[] = [];

  // Every match, not just the first: one excepted line earlier in the file
  // must never hide a genuine violation later in it.
  const allMatches = (pattern: RegExp) =>
    clean.matchAll(new RegExp(pattern.source, `${pattern.flags}g`));

  for (const rule of RULES) {
    for (const match of allMatches(rule.pattern)) {
      const line = lineOf(clean, match.index);
      if (isExcepted(line)) continue;
      findings.push({ line, say: rule.say });
    }
  }

  if (!HAS_TABS_COMPONENT.test(clean)) {
    for (const match of allMatches(TAB_PATTERN)) {
      const line = lineOf(clean, match.index);
      if (!isExcepted(line)) findings.push({ line, say: TAB_FINDING });
    }
  }

  return findings.sort((a, b) => a.line - b.line);
}

/**
 * A capped list route fetched by a screen that never asked for a page.
 *
 * The list routes cap an unpaged answer at a thousand rows and say so —
 * `truncated: true` in the body. That guard is right. What kept going wrong is
 * the other half of it: three separate defects in one day were a route
 * answering honestly and a caller reading only the rows. Five customer pickers
 * offered the first thousand contacts and called it the customer list; the
 * invoice form looked a company up in a list that stopped before it and
 * charged no tax at all; a person's audit tab showed a thousand events as
 * though it were their history. None of them errored, and none of them were
 * visible on any developer's data — which is exactly why a runtime warning in
 * development is no use here. The dataset that trips it is the customer's.
 *
 * So it is checked at the only time it can be: over the source, on every
 * commit, at every business's row count including zero. A screen may still
 * fetch one of these unpaged — a board that has to draw every card is a real
 * case — but it has to say why on the line above, and then it is its own job
 * to read `truncated` and tell somebody.
 *
 *   // ui-drift-ignore: a board draws every column whole; `truncated` is read below
 *   api<{ deals: Deal[] }>(`/api/deals?${query}`)
 *
 * A module that adds a list route of its own with the same cap belongs in the
 * list below; this reads text and cannot discover them.
 */
const CAPPED_LISTS = [
  "contacts",
  "companies",
  "deals",
  "activities",
  "tasks",
  "notes",
  "invoices",
  "quotes",
  "users/events",
];

/**
 * One whole `api(...)` read of a capped list: `api<{ companies: Company[] }>
 * ("/api/companies")`.
 *
 * The call, not the bare string, and a call with exactly one argument. That
 * is what separates a read from everything else the same path is written for
 * — `api("/api/notes", { method: "POST" })` writes one, `path="/api/contacts"`
 * hands `RecordPicker` somewhere to search — and what keeps the rule from
 * crying wolf on code that was never the problem. A path continuing into
 * another segment (`/api/invoices/counts`, `/api/contacts/import`) is a
 * different route and is not a list.
 *
 * The blind spot, stated: a query assembled by a helper —
 * `` `/api/deals?${query}` `` — cannot be read as text, so it is skipped. The
 * one caller in Core that builds an unpaged query that way is the deal board,
 * which reads `truncated` and says so on screen.
 */
const CAPPED_FETCH = new RegExp(
  `\\bapi\\s*(?:<[^(){}]*(?:\\{[^{}]*\\}[^(){}]*)*>)?\\(\\s*["\`](/api/(?:${CAPPED_LISTS.join("|")}))(\\?[^"\`]*)?["\`]\\s*\\)`,
);

/** A query that is nothing but one interpolation: `?${query}`, a builder. */
const WHOLE_QUERY_BUILT = /^\?\$\{[^}]*\}$/;

export function findUnpagedList(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  const findings: HandRolledFinding[] = [];
  for (const match of clean.matchAll(
    new RegExp(CAPPED_FETCH.source, `${CAPPED_FETCH.flags}g`),
  )) {
    const query = match[2] ?? "";
    // A query assembled elsewhere cannot be read from here, so it is left
    // alone rather than guessed at — the blind spot named above.
    if (WHOLE_QUERY_BUILT.test(query)) continue;
    if (/[?&](page|perPage)=/.test(query)) continue;
    const line = lineOf(clean, match.index);
    if (exceptedAbove(rawLines, line, "ui-drift")) continue;
    findings.push({
      line,
      say: `${match[1]} is capped at 1,000 rows and says \`truncated\` when it cuts — ask for a page, search it server-side through RecordPicker, or have the server answer the question the list was standing in for`,
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * The routes that answer with a sentence about what they cut.
 *
 * A paged report hands back `notice`: "Showing 200 of 6,412 invoices owed to
 * you, oldest first. The figures above cover all 6,412." Already composed, on
 * purpose — the lesson of `truncated: true`, which four screens received and
 * none printed, so a picker offered the first thousand customers and looked
 * complete. A sentence only has to be rendered.
 *
 * A route that starts answering with a `notice` belongs in this list. Like
 * `CAPPED_LISTS` above, this reads text and cannot discover them.
 */
const NOTICED_ROUTES = [
  "reports/accounts-receivable",
  "reports/accounts-payable",
];

const NOTICED_FETCH = new RegExp(
  `\\bapi\\s*(?:<[^(){}]*(?:\\{[^{}]*\\}[^(){}]*)*>)?\\(\\s*["\`](/api/(?:${NOTICED_ROUTES.join("|")}))(\\?[^"\`]*)?["\`]`,
);

/**
 * A screen that fetches one of those and never mentions `notice`.
 *
 * This is the other half of `findUnpagedList`. That one catches a screen
 * asking for a capped list whole; this catches a screen that asked correctly,
 * was told what was cut, and dropped the sentence on the floor — which looks
 * identical on any dataset a developer has, and on a real one silently
 * presents a page as the whole thing. `WhoOwesPanel` was exactly that: the
 * receivables report paged, said so, and the dashboard printed twelve names
 * with nothing saying there were six thousand more.
 *
 * **The blind spot, stated:** this is per-file and per-word. A screen whose
 * fetch lives in one file and whose markup lives in another passes without
 * rendering anything, and any use of the word `notice` in code satisfies it.
 * Both are deliberate — the cheap check catches the shape the defect has
 * actually taken every time, and the precise one needs a type-aware pass over
 * the whole tree to say which field of a response reached the DOM.
 */
export function findDroppedNotice(source: string): HandRolledFinding[] {
  const rawLines = source.split("\n");
  const clean = stripComments(source);
  // Comments stripped first: a doc comment explaining the notice is not a
  // screen rendering it, and that is the easy way to fool this.
  const renders = /\bnotice\b/.test(clean);
  if (renders) return [];
  const findings: HandRolledFinding[] = [];
  for (const match of clean.matchAll(
    new RegExp(NOTICED_FETCH.source, `${NOTICED_FETCH.flags}g`),
  )) {
    const line = lineOf(clean, match.index);
    if (exceptedAbove(rawLines, line, "ui-drift")) continue;
    findings.push({
      line,
      say: `${match[1]} is paged and answers with \`notice\`, a finished sentence saying what it cut — render it, or this screen shows one page as though it were everything`,
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/**
 * What kind of source a scanner is about.
 *
 * Three populations, because three rulebooks. `react` is a component the host
 * renders, where Core's stylesheet is on the page and every primitive is an
 * import away. `page` is what a module writes for somebody else's browser — a
 * published docs site, a storefront, a booking embed — server-side source
 * emitting HTML and CSS as strings, which cannot import React and never will.
 * `styles` is a stylesheet on disk.
 *
 * A `.tsx` file is `react`; a `.css` file is `styles`; server-side `.ts` that
 * emits markup is `page`. A repository classifies its own files, which is the
 * half it can actually answer.
 */
export type SourceKind = "react" | "page" | "styles";

export const SOURCE_KINDS: readonly SourceKind[] = ["react", "page", "styles"];

/**
 * Declares what a scanner's advice is addressed to.
 *
 * The property goes on the exported function, not in a map beside it, because
 * `Object.entries(uiDrift)` is already how three repositories discover these —
 * the scope arrives by the same route the scanner does, and there is no second
 * list to keep. A map would be the very thing this replaces: a hand-kept fact
 * about a scanner, sitting somewhere other than the scanner.
 *
 * `declareScope(fn)` with no kinds means all of them, so the shortest thing an
 * author can write is still the one that runs everywhere. Forgetting the call
 * entirely does not quietly narrow anything either — `scopeOf` throws and
 * names the scanner, in every repository that reads it. Loud, not skipped.
 *
 * The exception this replaces was real and correct: the modules repository
 * ran every scanner over its server-rendered pages except `findHandRolledUi`,
 * which was asking a string of HTML to import React. Twelve findings, all of
 * them bare `<h2>` in documents that style `h2` themselves. Right answer,
 * written down in the wrong repository — a fact about a scanner defined here,
 * maintained there, going stale the first time this file changes.
 */
function declareScope(
  scan: (source: string) => HandRolledFinding[],
  ...kinds: SourceKind[]
): void {
  Object.defineProperty(scan, "scope", {
    value: Object.freeze(kinds.length ? kinds : [...SOURCE_KINDS]),
    enumerable: false,
  });
}

/**
 * The scopes, stated once.
 *
 * `findHandRolledUi` is the only one that genuinely needs React: every finding
 * it makes ends in "use `SectionHeading`", "use `ui.Tabs`", "use
 * `listUi.useListState`" — imports, which a server-rendered string has no way
 * to take.
 *
 * `findFillAsText` and `findUnthemedElevation` are about markup and CSS
 * wherever they are written, including inside a template literal, and both
 * belong on stylesheets most of all — nine module stylesheets went unread
 * because the walk took `.tsx` alone, and the bottom-sheet shadow the
 * elevation rule exists for was in one of them. A standalone page having its
 * own palette is a reason to define both themes locally, not to be exempt.
 *
 * `findUnpagedList` and `findDroppedNotice` are about a `fetch` of a capped
 * route, so they read any TypeScript that makes one and have nothing to say
 * to a stylesheet.
 */
declareScope(findHandRolledUi, "react");
declareScope(findColourWithoutBorder, "react");
declareScope(findOwnVerticalRhythm, "react");
declareScope(findFillAsText);
declareScope(findUnthemedElevation);
declareScope(findUnpagedList, "react", "page");
declareScope(findDroppedNotice, "react", "page");

/** What a scanner reads: one file's source, findings out. */
export type Scanner = (source: string) => HandRolledFinding[];

/**
 * A scanner's declared scope, or a failure naming it.
 *
 * Undeclared is an error rather than a default, because the alternative is the
 * shape that keeps costing days: a guard that is fine and a scope that is
 * wrong, with nothing saying so. A scanner that should run everywhere says so
 * in one word.
 */
export function scopeOf(name: string, scan: unknown): readonly SourceKind[] {
  if (typeof scan !== "function" || scan.length !== 1) {
    throw new Error(
      `${name} is exported from ui-drift but is not a scanner of one source — either give it that shape or rename it so it is not discovered as one`,
    );
  }
  const scope = (scan as { scope?: unknown }).scope;
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error(
      `${name} does not declare what source it applies to — add declareScope(${name}, …) in ui-drift.ts, or declareScope(${name}) if it applies to all of ${SOURCE_KINDS.join(", ")}`,
    );
  }
  return scope as readonly SourceKind[];
}

/**
 * Every scanner in this module that applies to one kind of source.
 *
 * Discovery stays where it was — every export named `find…` — so a scanner
 * added here still runs in every repository tomorrow without anyone editing a
 * test. What changes is that a repository asks which of them its pages are
 * under instead of keeping the answer itself.
 *
 *   for (const [name, scan] of scannersFor(uiDrift, "page")) …
 */
export function scannersFor(
  module: Record<string, unknown>,
  kind: SourceKind,
): [string, Scanner][] {
  const found: [string, Scanner][] = [];
  for (const [name, value] of Object.entries(module)) {
    if (!name.startsWith("find")) continue;
    if (scopeOf(name, value).includes(kind))
      found.push([name, value as Scanner]);
  }
  return found;
}
