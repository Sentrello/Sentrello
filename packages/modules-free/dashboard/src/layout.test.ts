import { expect, test } from "bun:test";
import type { RegisteredWidget } from "@sentrello/module-sdk";
import { scopedId } from "@sentrello/module-sdk";
import {
  CORE_TABS,
  CORE_WIDGETS,
  defaultLayout,
  normalizeLayout,
  shownTabs,
  upgradeWidgetIds,
  withArrivals,
  withTimeout,
} from "./layout";

/**
 * How a dashboard is laid out, without a database.
 *
 * The decisions worth pinning: what a stored layout is allowed to say, what
 * somebody sees before they have arranged anything, what a response may name
 * to a reader, and how a module bought later reaches the screen. All pure,
 * so none needs an instance.
 */

const widget = (
  id: string,
  moduleId = "dashboard",
  label = id,
): RegisteredWidget => ({ id, label, moduleId, key: scopedId(moduleId, id) });

/**
 * A panel as everything outside the module addresses it: `moduleId:id`.
 *
 * A module declares the word it thinks in — `money` — and the platform scopes
 * it, so a second module that also thinks `money` does not silently take the
 * first one's place. Layouts are stored in this spelling.
 */
const k = (id: string, moduleId = "dashboard") => scopedId(moduleId, id);

/** The dashboard's own Free four, as the loader would have declared them. */
const FREE_CORE = [
  widget("money"),
  widget("attention"),
  widget("pipeline"),
  widget("health"),
];

/**
 * Every module gets a tab, without anybody arranging anything.
 *
 * A business with the Shop opens the dashboard and finds a Shop tab. That is
 * the shape the product is meant to have, and it is what the default has to
 * produce because most people never open the arranging screen at all.
 */
test("the default layout gives each module's widgets a tab of their own", () => {
  const tabs = defaultLayout([
    ...FREE_CORE,
    widget("summary:shop", "shop", "Shop"),
    widget("summary:scheduling", "scheduling", "Booking"),
  ]);
  const names = tabs.map((t) => t.name);

  expect(names).toContain("Shop");
  expect(names).toContain("Booking");
  // Between the core screens and System, which stays last: it is where
  // somebody looks when the instance itself is what is wrong.
  expect(names.at(-1)).toBe("System");
  expect(tabs.find((t) => t.name === "Shop")?.widgets).toEqual([
    k("summary:shop", "shop"),
  ]);
});

/**
 * The default is built only from what this reader may have. A Free reader
 * gets no Performance tab of panels that would all refuse — a tab of
 * refusals is worse than no tab.
 */
test("the default layout has no tab for widgets the reader cannot have", () => {
  const names = defaultLayout(FREE_CORE).map((t) => t.name);
  expect(names).toEqual(["Overview", "Sales", "System"]);

  const everything = defaultLayout([
    ...FREE_CORE,
    widget("invoice-aging"),
    widget("revenue-trend"),
    widget("cash-position"),
    widget("top-customers"),
    widget("deals-by-stage"),
    widget("who-owes"),
    widget("balance-sheet"),
    widget("cash-flow"),
    widget("trial-balance"),
  ]).map((t) => t.name);
  expect(everything).toEqual([
    "Overview",
    "Performance",
    "Sales",
    "Reports",
    "System",
  ]);
});

/**
 * Every id the default layout places is a widget the module actually
 * declared.
 *
 * `CORE_TABS` and `CORE_WIDGETS` are two hand-written lists, and nothing
 * ties them together at the type level — a rename or a deletion in one
 * leaves a dangling id in the other. `defaultLayout` filters a dangling id
 * out silently (it is just never shown, to anyone, ever, with no error),
 * which is exactly why a person has to notice rather than a symptom
 * appearing — the two cash-flow and trial-balance bugs this guards against
 * were both a widget wrongly *visible*, not one wrongly invisible; a
 * dangling id is the same class of drift with the opposite symptom, and
 * this is the half of the check that has to run without a database.
 */
test("every widget the default layout places is a widget the module declared", () => {
  const declaredIds = new Set(CORE_WIDGETS.map((w) => k(w.id)));
  const placedIds = new Set(CORE_TABS.flatMap((tab) => tab.widgets));
  const dangling = [...placedIds].filter((id) => !declaredIds.has(id));
  expect(dangling).toEqual([]);
});

/**
 * Kept even when the module is not loaded right now.
 *
 * A licence that lapses and is renewed, or a module switched off for a week,
 * should find its panel where it was left rather than having been quietly
 * deleted from the layout while it was away. Nothing is shown for it in the
 * meantime — responses go through `shownTabs`, which is the next test.
 */
test("a stored id keeps its place while its module is away", () => {
  const tabs = normalizeLayout([
    { name: "Anything", widgets: [k("summary:not-installed-today", "shop")] },
  ]);
  expect(tabs[0]?.widgets).toEqual([k("summary:not-installed-today", "shop")]);
});

/** An id is module-chosen, so its shape is checked rather than a list of them. */
test("a widget id that is not shaped like one is dropped", () => {
  const tabs = normalizeLayout([
    {
      name: "Mixed",
      widgets: [
        k("money"),
        "shop:summary:SHOUTING",
        "shop:summary:",
        7,
        k("health"),
      ],
    },
  ]);
  expect(tabs[0]?.widgets).toEqual([k("money"), k("health")]);
});

/** An empty or unreadable save means reset, and the caller treats it so. */
test("an empty layout normalizes to nothing rather than to a blank screen", () => {
  expect(normalizeLayout([])).toEqual([]);
  expect(normalizeLayout("nonsense")).toEqual([]);
});

/**
 * The non-disclosure rule itself: whatever is stored, a response only ever
 * names widgets the reader's licence and permissions cover. The tab the
 * business named survives the cut, empty.
 */
test("a response never names a widget the reader cannot have", () => {
  const cut = shownTabs(
    [
      { name: "Mine", widgets: [k("money"), k("revenue-trend")] },
      { name: "Ledger", widgets: [k("balance-sheet")] },
    ],
    new Set([k("money")]),
  );
  expect(cut).toEqual([
    { name: "Mine", widgets: [k("money")] },
    { name: "Ledger", widgets: [] },
  ]);
});

/**
 * A module bought on day 200 appends a tab of its own; a widget the business
 * removed on purpose — known, and on no tab — stays removed.
 */
test("a new arrival gets a tab, a deliberate removal stays removed", () => {
  const tabs = [{ name: "Ours", widgets: [k("money")] }];
  const known = [k("money"), k("attention")];

  const grown = withArrivals(tabs, known, [
    ...[widget("money"), widget("attention")],
    widget("summary:shop", "shop", "Shop"),
  ]);
  expect(grown).toEqual([
    { name: "Ours", widgets: [k("money")] },
    { name: "Shop", widgets: [k("summary:shop", "shop")] },
  ]);

  // Nothing new: the arrangement is exactly what was stored.
  expect(
    withArrivals(tabs, known, [widget("money"), widget("attention")]),
  ).toEqual(tabs);
});

/**
 * Every widget on a tab answers through one shared request, so a `load` that
 * never settles — not one that throws, one that simply never comes back —
 * would otherwise leave every other widget's card spinning behind it
 * forever. Raced against the clock instead: a hang becomes a rejection, which
 * the route already treats exactly like a thrown error.
 */
test("a widget load that never settles times out rather than hanging", async () => {
  const hangs = new Promise<string>(() => {}); // deliberately never resolves
  await expect(withTimeout(hangs, 10)).rejects.toThrow(/timed out/);
});

/** A widget that answers in time is unaffected by the race. */
test("a widget load that finishes before the deadline is unaffected", async () => {
  await expect(withTimeout(Promise.resolve("fine"), 1000)).resolves.toBe(
    "fine",
  );
});

/** A widget that fails on its own still fails on its own, not on a timer. */
test("a widget load that rejects on its own keeps its own reason", async () => {
  await expect(
    withTimeout(Promise.reject(new Error("boom")), 1000),
  ).rejects.toThrow("boom");
});

/**
 * The same, without a database: a stored bare id is a key's worth of meaning
 * that has to survive the scoping. Anything nothing answers to is left alone,
 * which is the rule the rest of this file already keeps — a module switched
 * off or whose licence lapsed finds its panel where it was left.
 */
test("a layout stored before panels were keyed by module comes forward", () => {
  const declared = [
    widget("money"),
    widget("health"),
    widget("summary:shop", "shop", "Shop"),
  ];

  expect(
    upgradeWidgetIds(
      ["money", "summary:shop", "away-today", k("health")],
      declared,
    ),
  ).toEqual([
    k("money"),
    k("summary:shop", "shop"),
    // Nothing declares it right now; kept exactly as stored.
    "away-today",
    // Already a key, and left alone rather than scoped twice.
    k("health"),
  ]);
});
