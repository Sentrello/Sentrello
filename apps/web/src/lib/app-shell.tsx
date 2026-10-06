import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { ErrorBoundary } from "./error-boundary";
import { FindButton } from "./find";
import { Icon, type IconName } from "./icons";
import { useNavigation } from "./navigation";
import { type Theme, useTheme } from "./theme";
import { Button, Card, Dialog, muted } from "./ui";

/**
 * The frame every screen sits in.
 *
 * A top header rather than the sidebar it replaces. The sidebar listed modules
 * as equals, which is exactly the thing that made it hard to tell what
 * connects to what — eight unrelated items, no sense that a contact leads to a
 * deal leads to an invoice. A header leaves the full width for a record and
 * whatever it is related to, which is where that relationship has to be shown.
 */

export interface NavEntry {
  id: string;
  label: string;
  moduleId?: string;
  group?: string;
  /** Where the module asked for this to sit among its siblings. */
  order?: number;
  /** Set on a module's own pages: the id of the entry they sit under. */
  parent?: string;
  /**
   * A heading to gather this page under, inside the panel.
   *
   * A row that opens, not a label — the panel draws as many levels as the
   * data has. Pages without a section render above the headings, which is
   * what every module does today.
   *
   * It is not a place to hang a page off a page. That is one level further
   * down than the panel draws, and it is how eleven screens once vanished
   * from the menu.
   *
   * It exists because Money is one module with sixteen pages: invoicing and
   * the books are one subject to a business and one undifferentiated list on
   * screen. Any module with enough pages can use it — the Shop has ten.
   */
  section?: string;
  icon?: string;
}

/**
 * Sections, in the order a business works through them rather than
 * alphabetically: find the customer, agree the price, take the money, do the
 * job. A section the host has never heard of sorts to the end rather than
 * being dropped — a module may name its own.
 */
export const GROUP_ORDER = [
  /*
   * Set by James, 27 September 2026: Sales, Marketing, Work, Money.
   *
   * Money led this list before, which is the order a bookkeeper works in
   * rather than the order a business does. The customer comes first, then
   * what brings the next one in, then the job, then the invoice.
   *
   * Marketing was once missing from this list entirely, which is not a small
   * thing: an unlisted group scores 99 and sorts below `Configuration`, so
   * Links, Search and Documentation rendered *under* Settings and Users.
   * Nobody chose that — it was the absence of two lines, and the order this
   * list exists to state was not the order anybody saw.
   */
  "Sales",
  "Marketing",
  "Work",
  "Money",
  // Nothing registers this yet; HR will. Kept so the day it arrives it lands
  // where it belongs rather than at the end with the unranked.
  "People",
  // Last, always. Settings are settings wherever you are.
  "Configuration",
];

/** Whatever the rail should draw for a section that named no icon of its own. */
export const GROUP_ICONS: Record<string, IconName> = {
  // A handshake, not a contact card: the section is where a deal gets agreed,
  // and the card belongs to Contacts, which is one screen inside it.
  Sales: "handshake",
  /*
   * The purse, not a receipt: a receipt is one document and Invoices draws
   * that. This icon stands for everything the business does with money.
   */
  Money: "wallet",
  Work: "briefcase",
  // An advert, not a rising line: the line belongs to Deals, and a group and a
  // module drawing the same glyph is two different things wearing one face.
  Marketing: "marketing",
  People: "users",
  Configuration: "settings",
};

/** One module, as the rail draws it and the panel opens it. */
export interface RailModule {
  moduleId: string;
  label: string;
  icon: IconName;
  items: NavEntry[];
}

/** One rail icon: a section of the business, and the modules inside it. */
export interface RailGroup {
  /** The group's name, or the module id when a module named no group. */
  id: string;
  label: string;
  icon: IconName;
  modules: RailModule[];
}

/** Where a group sorts. Unranked goes to the end rather than being dropped. */
function position(name: string | undefined): number {
  if (!name) return -1;
  const known = GROUP_ORDER.indexOf(name);
  return known === -1 ? 99 : known;
}

/** Every module, keyed by id, with the entries it registered. */
export function railModules(nav: NavEntry[]): RailModule[] {
  const byModule = new Map<string, NavEntry[]>();
  for (const item of nav) {
    // A module's own pages belong beneath their parent in the panel, not as a
    // second icon on the rail.
    if (item.parent) continue;
    const key = item.moduleId ?? item.id;
    const list = byModule.get(key);
    if (list) list.push(item);
    else byModule.set(key, [item]);
  }

  return [...byModule.entries()]
    .map(([moduleId, items]) => {
      /**
       * The entry that names the module, if it registered one.
       *
       * The CRM registers a parent called "CRM" and hangs five pages off it;
       * Invoicing registers five siblings and no parent. Preferring the entry
       * whose id *is* the module id gets the first case right, and the first
       * entry is the only thing available in the second.
       */
      const named = items.find((i) => (i.moduleId ?? i.id) === i.id);
      const head = named ?? items[0];
      return {
        moduleId,
        label: head?.label ?? moduleId,
        icon: (head?.icon ??
          items.find((i) => i.icon)?.icon ??
          "layout") as IconName,
        items,
      };
    })
    .sort((a, b) => {
      const byGroup = position(a.items[0]?.group) - position(b.items[0]?.group);
      return byGroup !== 0 ? byGroup : a.label.localeCompare(b.label);
    });
}

/**
 * The rail: one icon per section of the business, not per module.
 *
 * It was one icon per module for a while, on the argument that somebody
 * arriving with "where is Invoicing" should not have to know which section it
 * was filed under. That answered the question by asking a different one:
 * thirteen equal glyphs, growing by one with every module bought, saying
 * nothing about what belongs with what. Settings and Users are one idea and
 * were two icons; Money and the POS are one part of the business and were two.
 *
 * So the rail is the sections again — and the panel beside it is allowed the
 * depth that makes that work, which is what it was missing the first time.
 *
 * A module that named no section is not filed under a blank one: it keeps an
 * icon of its own, which is what the Dashboard has always had.
 */
export function railGroups(nav: NavEntry[]): RailGroup[] {
  const groups = new Map<string, RailModule[]>();
  for (const module of railModules(nav)) {
    const name = module.items[0]?.group;
    const key = name || `module:${module.moduleId}`;
    const list = groups.get(key);
    if (list) list.push(module);
    else groups.set(key, [module]);
  }

  return [...groups.entries()]
    .map(([key, modules]) => {
      const name = modules[0]?.items[0]?.group;
      /**
       * One occupant is never drawn as a level of its own.
       *
       * A section holding a single module is that module — showing its name
       * on the icon and again on the panel title is a level of navigation
       * that never branches. The rule runs all the way down: a module alone
       * in a panel does not draw a row either.
       */
      const alone = modules.length === 1 ? modules[0] : undefined;
      return {
        id: key,
        label: alone ? alone.label : (name ?? key),
        icon:
          alone?.icon ??
          (name ? GROUP_ICONS[name] : undefined) ??
          ("layout" as IconName),
        modules,
      };
    })
    .sort((a, b) => {
      const byGroup =
        position(a.modules[0]?.items[0]?.group) -
        position(b.modules[0]?.items[0]?.group);
      return byGroup !== 0 ? byGroup : a.label.localeCompare(b.label);
    });
}

/** A module's own pages, in the order it registered them. */
export function childrenOf(nav: NavEntry[], parentId: string): NavEntry[] {
  /*
   * In the order they arrive, which is the order they asked for.
   *
   * `apps/server/src/loader.ts` sorts the whole nav by `order` before it is
   * served, so filtering preserves it. Sorting again here looked like
   * belt-and-braces and was the opposite: the loader treats a missing order as
   * 0 and puts those first, and a second sort written from scratch put them
   * last. One idea in two places, disagreeing — which is a worse failure than
   * either rule, because the panel and the menu would answer differently about
   * the same module.
   */
  return nav.filter((n) => n.parent === parentId);
}

/**
 * A module's pages, broken into the headings it asked for.
 *
 * Sections come out in the order they are first met, and pages keep the order
 * they were registered in. Pages with no section come first, under no heading:
 * a module that never asked for one renders exactly as it did before, which is
 * what every module but Money does.
 *
 * A heading with nothing under it is not produced, so a section whose only
 * pages are behind an entitlement disappears with them rather than leaving a
 * label over empty space on a Free instance.
 */
export function sectionsOf(
  pages: NavEntry[],
): { heading?: string; items: NavEntry[] }[] {
  const out: { heading?: string; items: NavEntry[] }[] = [];
  const index = new Map<string, number>();
  for (const page of pages) {
    const key = page.section ?? "";
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, out.length);
      out.push({
        ...(page.section ? { heading: page.section } : {}),
        items: [page],
      });
    } else {
      out[at]?.items.push(page);
    }
  }
  // Unsectioned pages lead, whatever order they were met in.
  return out.sort((a, b) => Number(!!a.heading) - Number(!!b.heading));
}

/**
 * A row in the panel: a screen, or something that opens onto screens.
 *
 * The panel used to draw exactly two kinds of row and so had exactly two
 * levels. That was enough while one icon meant one module, and stopped being
 * enough the moment an icon meant a section: Money and the POS share one, and
 * each has headings of its own inside it.
 *
 * So the panel draws a tree and the tree decides its own depth, which is what
 * keeps it from turning into ceremony — a level with one occupant is not
 * drawn at all. Booking, alone in Work with no headings, is a flat list of six
 * screens. Money alone is its headings. Money beside the POS is both, and that
 * is the only place three levels appear.
 */
export interface NavNode {
  /** Unique within the panel: what remembers whether this row is open. */
  id: string;
  label: string;
  icon?: IconName;
  /** Set when the row is a screen. A row with children is not. */
  entry?: NavEntry;
  /**
   * Set when the row is one of a module's own headings.
   *
   * A heading is a divider that happens to fold, not a place. It starts
   * open; a module row starts closed unless it holds the screen you are
   * on. See `isOpen`.
   */
  heading?: true;
  children: NavNode[];
}

const leafNode = (entry: NavEntry): NavNode => ({
  id: entry.id,
  label: entry.label,
  entry,
  children: [],
});

/** Pages, with each heading the module asked for as a row that opens. */
function pageNodes(prefix: string, pages: NavEntry[]): NavNode[] {
  return sectionsOf(pages).flatMap((part) => {
    if (!part.heading) return part.items.map(leafNode);
    /*
     * A heading that only repeats its one page is not a heading.
     *
     * The CRM's panel ended "Settings" over "Settings", one indent apart and
     * both opening the same screen — which is what a rule about where
     * settings go produces when a module has exactly one settings page and
     * calls it the obvious thing. The page keeps its section, so every guard
     * still reads it as filed; the panel just stops saying the word twice.
     */
    const only = part.items.length === 1 ? part.items[0] : undefined;
    if (only && only.label === part.heading) return [leafNode(only)];
    return [
      {
        id: `${prefix}/${part.heading}`,
        label: part.heading,
        heading: true as const,
        children: part.items.map(leafNode),
      },
    ];
  });
}

/** What one module contributes to the panel, with its own name left off. */
export function moduleNodes(nav: NavEntry[], module: RailModule): NavNode[] {
  const items = module.items;
  const head = items.length === 1 ? items[0] : undefined;
  if (head) {
    const pages = childrenOf(nav, head.id);
    return pages.length ? pageNodes(module.moduleId, pages) : [leafNode(head)];
  }
  return items.map((item) => {
    const pages = childrenOf(nav, item.id);
    return pages.length
      ? {
          id: item.id,
          label: item.label,
          ...(item.icon ? { icon: item.icon as IconName } : {}),
          children: pageNodes(item.id, pages),
        }
      : leafNode(item);
  });
}

/** The whole panel for one rail icon. */
export function panelNodes(nav: NavEntry[], group: RailGroup): NavNode[] {
  const alone = group.modules.length === 1 ? group.modules[0] : undefined;
  if (alone) return moduleNodes(nav, alone);
  return group.modules.map((module) => ({
    id: `module:${module.moduleId}`,
    label: module.label,
    icon: module.icon,
    children: moduleNodes(nav, module),
  }));
}

/**
 * Whether the second level of the sidebar has anything to say.
 *
 * A single row that opens onto nothing only repeats the icon the rail already
 * showed. The Dashboard is exactly that, and always will be. Fifteen rem of
 * panel to restate one word is fifteen rem taken off the screen somebody is
 * trying to work in.
 */
export function panelWorthShowing(nodes: NavNode[]): boolean {
  if (nodes.length > 1) return true;
  return (nodes[0]?.children.length ?? 0) > 0;
}

/** Every screen somewhere under a row, so a row knows when it holds you. */
function holds(node: NavNode, pageId: string): boolean {
  if (node.entry?.id === pageId) return true;
  return node.children.some((child) => holds(child, pageId));
}

/** The first screen under a row — where opening it lands you. */
function firstLeaf(node: NavNode): NavEntry | undefined {
  if (node.entry) return node.entry;
  for (const child of node.children) {
    const found = firstLeaf(child);
    if (found) return found;
  }
  return undefined;
}

/**
 * One level of the panel, and every level below it.
 *
 * Drawn by recursion rather than by two hand-written levels, because the depth
 * is the data's to decide: whoever adds a module with headings beside another
 * module should not also have to add a third `map` to this file.
 */
function NavRows({
  nodes,
  depth,
  currentId,
  isOpen,
  onToggle,
  onGo,
}: {
  nodes: NavNode[];
  depth: number;
  currentId: string;
  isOpen: (node: NavNode) => boolean;
  onToggle: (node: NavNode) => void;
  onGo: (entry: NavEntry) => void;
}) {
  return (
    <>
      {nodes.map((node) => {
        const open = node.children.length > 0 && isOpen(node);
        return (
          <div key={node.id}>
            <button
              type="button"
              // Spaces before the `${`s, like every class list here: a class
              // name ends where its characters end, and one with an
              // interpolation welded to it is a class Tailwind emits no rule
              // for. These three are hand-written in `index.css` so nothing was
              // broken by it, but the rule has no exceptions worth remembering.
              className={`nav-link nav-parent ${depth > 0 ? "nav-child" : ""} ${node.heading ? "nav-section" : ""}`}
              aria-current={node.entry?.id === currentId ? "page" : undefined}
              aria-expanded={node.children.length ? open : undefined}
              onClick={() => {
                if (node.children.length) onToggle(node);
                else if (node.entry) onGo(node.entry);
              }}
            >
              {/* A drawing only at the top level.
                  
                  The rail draws a group and the panel draws the modules in
                  it; a page inside a module gets its name and nothing else.
                  Every row carrying a picture made the panel a column of
                  pictures with words beside them, and the icons stopped
                  telling you which level you were looking at — which is the
                  one job they have here. James, 25 September. */}
              {depth === 0 && node.icon ? (
                <Icon name={node.icon} size={16} />
              ) : null}
              <span className="flex-1 text-left">{node.label}</span>
              {node.children.length ? (
                // Drawn in CSS, not an icon and not "▸" at 0.6rem. The glyph
                // renders at whatever weight the font has for it, which on
                // this stack is barely a mark; an icon-set chevron reads as a
                // picture of an arrow sitting beside the label. See .nav-caret.
                <span
                  className="nav-caret"
                  data-open={open}
                  aria-hidden="true"
                />
              ) : null}
            </button>
            {open ? (
              <div className="nav-children">
                <NavRows
                  nodes={node.children}
                  depth={depth + 1}
                  currentId={currentId}
                  isOpen={isOpen}
                  onToggle={onToggle}
                  onGo={onGo}
                />
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

/**
 * The sidebar: a rail of sections, and the one you are in opened beside it.
 *
 * The rail says "these are the parts of the business"; the panel says "this is
 * what is in this part", to whatever depth that part actually has.
 */
function Sidebar({ nav }: { nav: NavEntry[] }) {
  const { current, go } = useNavigation();
  const groups = railGroups(nav);

  /** Which entry is on screen, so the rail and the panel can both mark it. */
  const activeEntry = nav.find((n) => n.id === current.moduleId);
  const parentEntry = activeEntry?.parent
    ? nav.find((n) => n.id === activeEntry.parent)
    : undefined;
  const activeModule =
    (parentEntry ?? activeEntry)?.moduleId ??
    (parentEntry ?? activeEntry)?.id ??
    "";
  const activeGroup = groups.find((g) =>
    g.modules.some((m) => m.moduleId === activeModule),
  );

  /**
   * The section the panel is showing.
   *
   * It follows wherever you are by default, so arriving on a screen opens the
   * section it belongs to. Clicking the rail pins a different one — somebody
   * looking for the next thing to do should be able to browse without leaving
   * the screen they are on.
   */
  const [pinned, setPinned] = useState<string | null>(null);
  const group = groups.find((g) => g.id === pinned) ?? activeGroup ?? groups[0];
  const nodes = group ? panelNodes(nav, group) : [];

  /**
   * Rows opened out.
   *
   * A module's own headings start open; anything else starts open only if it
   * holds the screen you are on.
   *
   * Headings were folded like everything else, and on a module's own
   * dashboard that meant nothing held you, so the whole panel was shut.
   * Money opened as five words — "Getting paid", "Spending", "The books",
   * "Tax", "Settings" — and somebody who came to write an invoice had to
   * guess which of the five hid it. The headings were added to make sixteen
   * pages scannable and had ended up hiding all sixteen.
   *
   * They fold because a long panel should be foldable, not because folded is
   * where they belong. Whatever anybody folds here is theirs for as long as
   * the panel is on screen.
   *
   * And a module row opens when you are in that module — which is not the
   * same question as whether it holds the page, because a module's own head
   * is not one of its pages. Arriving on Settings drew "Settings" and
   * "Users", two closed words, with the six pages of the module you were
   * standing in behind one of them.
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (node: NavNode) =>
    expanded[node.id] ??
    (node.heading ||
      node.id === `module:${activeModule}` ||
      holds(node, current.moduleId));

  const showPanel = panelWorthShowing(nodes);

  /** A row that opens is not a screen: opening one lands on its first. */
  const openNode = (node: NavNode) => {
    if (isOpen(node)) {
      setExpanded((e) => ({ ...e, [node.id]: false }));
      return;
    }
    setExpanded((e) => ({ ...e, [node.id]: true }));
    const first = firstLeaf(node);
    if (first) go(first.id, first.label);
  };

  /**
   * Hide and show the panel without re-rendering what it frames.
   *
   * One attribute on the shell, flipped in the DOM: the panel is a frame
   * around whatever screen is open, and collapsing a frame should not
   * re-render the thing inside it, nor stop working when a module screen
   * throws — both of which React state here would.
   *
   * Two buttons share it. The one inside the panel goes with the panel, so
   * the one that brings it back has to live on the rail, which is the only
   * thing still on screen. Whichever is showing takes the focus, or a
   * keyboard user presses a control and lands on the document body.
   */
  /**
   * On a narrow screen the panel starts away.
   *
   * The rail is 68px and the panel about 240, so on a 390px phone the two of
   * them took 308 and left the screen itself **82 pixels** — one word per
   * line, and 33 of the 35 screens scrolling sideways because of it. Nothing
   * had ever opened the product at phone width: every Playwright project is
   * Desktop Chrome. With the panel away, 3 of the 35 overflow, and those are
   * three layouts rather than one shell.
   *
   * The same attribute the button flips, so there is one mechanism and not
   * two, and anybody can still open it — a phone drawer covering the screen
   * is how a phone drawer works.
   *
   * Only on the way in and on a real change of width. Re-applying it on
   * every resize event would shut the panel on somebody who had just opened
   * it, which is a worse thing to do than never opening it for them.
   */
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 899px)");
    const apply = (matches: boolean) => {
      const shell = document.querySelector("[data-shell]");
      if (shell) setPanelHidden(shell, matches);
    };
    apply(narrow.matches);
    const onChange = (e: MediaQueryListEvent) => apply(e.matches);
    narrow.addEventListener("change", onChange);
    return () => narrow.removeEventListener("change", onChange);
  }, []);

  /**
   * On a phone the panel lies over the screen, so it needs the ways out an
   * overlay has. It had none.
   *
   * Opened on a 390px phone it covered three quarters of the screen, and
   * nothing put it away again: not Escape, not a tap on the page behind it,
   * and not choosing a screen — so the ordinary thing somebody does with a
   * drawer, open it to go somewhere, left them on the page they asked for
   * with the drawer still on top of it. The only way back was the one
   * control inside the drawer itself.
   *
   * None of this applies above 900px, where the panel is a column beside
   * the screen rather than on it. Closing a column every time somebody
   * changed page would be its own kind of rude.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissPanelOverlay(true);
    };
    const onClick = (e: MouseEvent) => {
      // The rail is beside the drawer rather than under it, and the control
      // that opens the drawer lives there — so a click on the rail is not a
      // click away from the drawer.
      if ((e.target as Element | null)?.closest(".app-sidebar, .app-rail"))
        return;
      dismissPanelOverlay();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("click", onClick);
    };
  }, []);

  /**
   * And going somewhere is the end of the drawer, whoever asked — a row in
   * the panel, an icon on the rail, the account menu. Watching the screen
   * change catches all of them at once; watching each control would be one
   * more list to keep in step with the shell.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: the change of screen is the event, not the value
  useEffect(() => {
    dismissPanelOverlay();
  }, [current.moduleId]);

  const togglePanel = (e: React.MouseEvent<HTMLButtonElement>) => {
    const shell = e.currentTarget.closest("[data-shell]");
    if (!shell) return;
    const hidden = !shell.hasAttribute("data-panel-hidden");
    setPanelHidden(shell, hidden);
    shell
      .querySelector<HTMLElement>(hidden ? ".panel-tab" : ".panel-collapse")
      ?.focus();
  };

  return (
    <div className="flex items-stretch" data-shell>
      <nav className="app-rail" aria-label="Modules">
        {/* The tab that brings the panel back, at the top of the rail where
            the panel's own control used to be — the two swap places rather
            than one control moving, because only one of them can ever be on
            screen at a time. */}
        {showPanel ? (
          <button
            type="button"
            className="panel-tab"
            aria-expanded="false"
            aria-controls="section-panel"
            aria-label="Show the section panel"
            title="Show the section panel"
            onClick={togglePanel}
          >
            <span className="nav-caret" aria-hidden="true" />
          </button>
        ) : null}
        {groups.map((item) => {
          const here = group?.id === item.id;
          return (
            <button
              key={item.id}
              type="button"
              className="rail-button"
              aria-label={item.label}
              title={item.label}
              aria-current={here ? "true" : undefined}
              onClick={() => {
                setPinned(item.id);
                /**
                 * A rail click goes somewhere.
                 *
                 * An icon that only ever highlights is a dead end, and the
                 * destination is never in doubt: the first screen of the first
                 * module in the section.
                 */
                const first = panelNodes(nav, item)
                  .map(firstLeaf)
                  .find(Boolean);
                if (first) go(first.id, first.label);
              }}
            >
              <Icon name={item.icon} size={26} />
            </button>
          );
        })}
      </nav>

      {showPanel && group ? (
        <>
          <aside
            id="section-panel"
            className="app-sidebar p-2"
            aria-label="Screens"
          >
            {/* The section's name and the control that puts it away, on one
                line at the top — where somebody looks for it, and where the
                tab reappears when it is gone. */}
            <div className="panel-head">
              <p className="panel-title">{group.label}</p>
              <button
                type="button"
                className="panel-collapse"
                aria-expanded="true"
                aria-controls="section-panel"
                aria-label="Hide the section panel"
                title="Hide the section panel"
                onClick={togglePanel}
              >
                <Icon name="panel" size={16} />
              </button>
            </div>
            <NavRows
              nodes={nodes}
              depth={0}
              currentId={current.moduleId}
              isOpen={isOpen}
              onToggle={openNode}
              onGo={(entry) => go(entry.id, entry.label)}
            />
          </aside>
        </>
      ) : null}
    </div>
  );
}

/**
 * The panel's open state is one attribute and two `aria-expanded`s, and they
 * have to move together — so they move in one place. Four things ask for it
 * now: the width on the way in, the two buttons, and a phone drawer being
 * dismissed.
 */
function setPanelHidden(shell: Element, hidden: boolean) {
  shell.toggleAttribute("data-panel-hidden", hidden);
  for (const button of shell.querySelectorAll(
    "[aria-controls='section-panel']",
  )) {
    button.setAttribute("aria-expanded", hidden ? "false" : "true");
  }
}

/** Under 900px the panel lies over the screen instead of beside it. */
const panelOverlays = () => window.matchMedia("(max-width: 899px)").matches;

/**
 * Put the drawer away, if there is a drawer and it is open.
 *
 * `focusTab` is for the dismissals a keyboard made — Escape should leave the
 * focus on the control that brings the panel back, not on the body. A tap
 * elsewhere, or a change of screen, should leave the focus where the person
 * just put it.
 */
function dismissPanelOverlay(focusTab = false) {
  if (!panelOverlays()) return;
  const shell = document.querySelector("[data-shell]");
  if (!shell || shell.hasAttribute("data-panel-hidden")) return;
  setPanelHidden(shell, true);
  if (focusTab) shell.querySelector<HTMLElement>(".panel-tab")?.focus();
}

/**
 * "That screen is not on this instance."
 *
 * An address naming nothing put the reader on the dashboard and said
 * nothing about it, so a bookmark to a module that was switched off, a link
 * in an old email and a mistyped word all looked the same: like the
 * application ignoring them. Landing on the dashboard is the right thing to
 * do; doing it in silence was not.
 *
 * Named rather than described — "shop" is the word somebody will look for
 * in Settings, and the one they typed. Dismissed on reading, and gone after
 * a refresh, because it is about the arrival rather than the screen.
 */
function MissingScreen() {
  const { missing, forgetMissing } = useNavigation();
  if (!missing) return null;
  return (
    <Card className="mb-(--gap-stack)">
      <p className="text-sm">
        There is no <strong>{missing}</strong> on this instance. It may be a
        module that is not installed, or one switched off in Settings → Modules
        — or the link may be out of date. This is your dashboard instead.
      </p>
      <div className="mt-(--gap-toolbar)">
        <button
          type="button"
          onClick={forgetMissing}
          className="text-sm link-muted"
        >
          Right you are
        </button>
      </div>
    </Card>
  );
}

/**
 * "You have not saved that."
 *
 * Every editor in this product replaces the list in place, so the rail and
 * the section panel sit beside a half-written invoice. One click on Contacts
 * and eight lines of typing were gone — nothing asked, nothing kept, on a
 * product whose whole subject is money somebody is owed.
 *
 * Drawn once, here, rather than per screen: the navigation parks the
 * destination and this is the only thing that reads it, so no screen has to
 * know the guard exists.
 *
 * Deliberately not `window.confirm`. It would be fewer lines and it is the
 * wrong thing twice over: the browser's wording cannot say what is at stake,
 * and a native modal blocks the page so completely that the automated walks
 * hang on it rather than reporting it.
 */
function LeaveGuard() {
  const { pending, leaveAnyway, stayHere } = useNavigation();
  return (
    <Dialog
      title="You have not saved this yet"
      open={pending !== null}
      onClose={stayHere}
    >
      <p className="text-sm">
        Leaving now throws away what you have typed. Nothing has been sent to
        the server.
      </p>
      <div className="mt-4 flex flex-wrap justify-end gap-(--gap-toolbar)">
        {/* Staying is the safe answer, so it is the one the focus lands on
            and the one that reads as ordinary. Leaving is the destructive
            half and says what it destroys. */}
        <Button onClick={stayHere}>Keep editing</Button>
        <Button variant="danger" onClick={leaveAnyway}>
          Discard and leave
        </Button>
      </div>
    </Dialog>
  );
}

/** Initials, for when there is no avatar — which is the normal case. */
function initials(name: string | null | undefined, email: string): string {
  const source = name?.trim() || email;
  const parts = source
    .replace(/@.*/, "")
    .split(/[\s._-]+/)
    .filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0] ?? "");
  return (letters.join("") || source[0] || "?").toUpperCase();
}

function ThemeChoice({
  theme,
  onChange,
}: {
  theme: Theme;
  onChange: (t: Theme) => void;
}) {
  return (
    <div className="flex gap-1 border-t px-3 py-2 border-line">
      {(["light", "dark", "system"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={theme === t}
          className="flex-1 rounded px-2 py-1 text-xs capitalize"
          style={
            theme === t
              ? {
                  background: "var(--brand-on-white-text)",
                  color: "var(--color-neutral-50)",
                }
              : { color: "var(--text-muted)" }
          }
        >
          {t}
        </button>
      ))}
    </div>
  );
}

function ProfileMenu({
  name,
  email,
  onOpenProfile,
  onOpenSettings,
}: {
  name: string | null | undefined;
  email: string;
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const box = useRef<HTMLDivElement>(null);

  // Closing on an outside click and on Escape, because a menu that can only be
  // dismissed by the button that opened it is a menu people get stuck in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        // `true`, not `menu`: what opens is a box of buttons with the
        // person's name above them, and the reasoning is at `RowMenu`.
        aria-haspopup="true"
        aria-expanded={open}
        aria-label="Your account"
        className="flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold"
        style={{
          // The shade dark enough for white text; brand-500 measures 3.77:1.
          background: "var(--brand-on-white-text)",
          color: "var(--color-neutral-50)",
        }}
      >
        {initials(name, email)}
      </button>

      {open ? (
        /*
         * No `role="menu"`, for the reason `RowMenu` records at length: a
         * `menu` may contain only `menuitem`, axe rates the breach critical,
         * and this one broke it twice over — the panel opens with a `<div>`
         * carrying the person's name and address, which no `menu` may hold.
         * Nothing here implements the arrow-key model the role promises
         * either. So it claims nothing, and the three buttons are announced
         * by the words on them.
         */
        <div className="menu-panel">
          <div className="border-b px-3 py-2 border-line">
            <div className="truncate text-sm font-medium">{name || email}</div>
            {name ? (
              <div
                className="truncate text-xs"
                style={{ color: "var(--text-muted)" }}
              >
                {email}
              </div>
            ) : null}
          </div>

          {/* menu-item-ignore: your own profile, which everybody has */}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenProfile();
            }}
          >
            Your profile
          </button>

          {/* menu-item-ignore: goes to a screen that gates itself */}
          <button
            type="button"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>

          <ThemeChoice theme={theme} onChange={setTheme} />

          {/* menu-item-ignore: signing out is nobody's to refuse */}
          <button
            type="button"
            className="menu-item border-t"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-danger)",
            }}
            /*
             * Out, and back to the front door.
             *
             * Signing out left the address bar on whatever screen you were
             * reading, so the sign-in form appeared under `/invoicing` — and
             * the next person to sign in on that machine was sent straight
             * back to a screen chosen by somebody else. A whole navigation
             * rather than a router push: everything React is holding belongs
             * to the session that just ended.
             */
            onClick={async () => {
              await authClient.signOut();
              window.location.assign("/");
            }}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AppShell({
  nav,
  user,
  version,
  children,
}: {
  nav: NavEntry[];
  user: { name?: string | null; email: string };
  /** What this instance is running, for the bar at the bottom. */
  version?: string;
  children: React.ReactNode;
}) {
  const { go } = useNavigation();

  // Settings reaches the sidebar under Configuration and the profile menu both.
  // Two ways to the same screen is not duplication here: one is where you look
  // when configuring the platform, the other where you look when it is your
  // own account you are thinking about.
  const settings = nav.find((n) => n.id === "settings");

  /**
   * The tab says which screen you are on.
   *
   * `index.html` sets `<title>Sentrello</title>` and nothing ever changed it,
   * so all ninety-nine screens shared one title. Axe passes that — its rule
   * asks whether a title exists — and WCAG 2.4.2 asks for one that describes
   * the page, which "Sentrello" does not once there is more than one page.
   *
   * It is announced on navigation, so for somebody using a screen reader it is
   * the sentence that says where they have arrived; hearing "Sentrello" every
   * time is the same as hearing nothing. It is also what a person with six
   * tabs open is reading, and what goes into history and bookmarks.
   *
   * The screen's own name first, because a tab is truncated from the right.
   */
  const { current } = useNavigation();
  const here = nav.find((n) => n.id === current.moduleId);
  /*
   * A name for a screen the sidebar does not list.
   *
   * Profile is reached from the account menu and is in no nav list, so looking
   * the label up returns nothing and it kept the shared title — the one screen
   * in ninety-nine that did. Its own id, tidied, rather than a list of
   * exceptions somebody has to remember to extend.
   */
  const label =
    here?.label ??
    (current.moduleId
      ? current.moduleId
          .split("-")
          .join(" ")
          .replace(/^./, (c) => c.toUpperCase())
      : "");
  useEffect(() => {
    document.title = label ? `${label} · Sentrello` : "Sentrello";
  }, [label]);

  /*
   * Saying, out loud, that the page changed.
   *
   * On a whole-page load a screen reader reads the new document and you
   * know where you are. Nothing here loads a page: a nav item swaps the
   * contents of `main`, focus stays on the link you pressed, and the title
   * changes — which is not announced by any screen reader we can rely on.
   * So somebody working by ear pressed Contacts and heard nothing at all,
   * with no way to tell whether it had worked.
   *
   * A polite live region rather than moving focus. Focus belongs to the
   * person: they may be tabbing through the section panel on their way
   * somewhere else, and hauling them into the page each time they pass a
   * link is worse than saying nothing.
   *
   * Empty on the first render, then filled. A region that already holds
   * its text when it appears announces nothing — the announcement is the
   * *change* — and the first arrival is a real page load, which the
   * browser has already read out.
   */
  const [arrived, setArrived] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setArrived(label), 120);
    return () => clearTimeout(t);
  }, [label]);

  return (
    /*
      A frame the height of the window: bar, body, bar. The screen inside
      it is the thing that scrolls.

      Three arrangements of this have shipped. A plain block where the body
      carried its own "100vh minus the header" — which stopped being true
      the moment there was a bar underneath as well. Then a column the
      page scrolled, with the rail and the panel sticky inside it, which is
      where the arithmetic got expensive: a sticky element is pushed up
      once its container's bottom edge reaches it, so a full-height rail
      slid under the header at the foot of a long page, and the rail short
      enough to avoid that left 45 pixels of nothing between itself and the
      bottom of the window on every screen worth scrolling.

      Neither of those is a thing to tune. The window is a fixed frame, the
      bars are the first and last rows of it, and the screen between them
      scrolls on its own — so the menu is exactly the space between the two
      bars, at every scroll position, and there is no arithmetic left to be
      wrong. Printing is the one place a frame is the wrong idea, and
      `@media print` in `index.css` undoes it.
    */
    <div className="app-shell-frame flex h-dvh flex-col overflow-hidden">
      <div aria-live="polite" className="sr-only">
        {arrived}
      </div>
      <LeaveGuard />
      {/*
       * The way past the furniture, for somebody working without a mouse.
       *
       * The header, the rail and the section panel are the same on every
       * screen, and they are up to eighteen tab stops deep on Accounting.
       * Without this, reaching the first control on the page you asked for
       * means pressing Tab through all of it — again on the next page, and
       * the next. The automated check passes either way: it is satisfied by
       * the `main` landmark, which only helps somebody using a screen reader.
       *
       * Invisible until focused, so it costs nothing to anyone else, and
       * `main` is focusable because a browser will not move focus to an
       * element that cannot hold it.
       */}
      <a className="skip-link" href="#screen">
        Skip to content
      </a>
      {/* Global: who you are, and the way home. The modules are not up here —
          fifteen of them scrolling sideways told you nothing about how they
          relate, which was the whole complaint. */}
      <header className="app-header">
        <div className="flex h-13 items-center gap-3 px-4 py-2">
          {/*
            The name, not a way home. James, 27 September 2026: it is the
            product's name at the top of the product's own window, and there
            is already a way to the dashboard — the first icon on the rail,
            which is where somebody looks for it. A word that moves you when
            you press it and looks exactly like a word that does not is a tab
            stop announced as a button with nothing useful to say.
          */}
          <span className="shrink-0 font-semibold">Sentrello</span>
          {/*
            Search takes the middle of the header rather than sitting as an
            afterthought beside the avatar. It is how somebody reaches one
            invoice out of four thousand, and it was smaller than the button
            that opens a menu.
          */}
          <div className="flex flex-1 justify-end sm:justify-center">
            <FindButton />
          </div>
          <ProfileMenu
            name={user.name}
            email={user.email}
            // No nav entry of its own: your account is not one of the
            // business's modules, and it is reached from here or not at all.
            onOpenProfile={() => go("profile", "Your profile")}
            onOpenSettings={() => settings && go(settings.id, settings.label)}
          />
        </div>
      </header>

      {/*
        Stretching rather than `items-start`: the rail, the panel and the
        screen all take the full height of the row, which is the whole of
        the space between the two bars.

        `min-h-0` and `min-w-0` because a flex item's minimum in either
        direction is its own content. Without the width one this row
        stopped shrinking at whatever the widest thing inside it was — 445
        pixels of settings screen in a 390-pixel phone. Without the height
        one a long screen would push the row past the bottom of the frame
        instead of scrolling inside it, which is the same bug turned
        ninety degrees.

        `relative` for the panel's sake: below 900px it stops taking room
        from the screen and sits over it, and this is what it is measured
        against.
      */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <Sidebar nav={nav} />
        {/* The screen, and the only thing on it that scrolls. A column that
            fills the row, so a module that wants to fill the window — a
            builder, a board, a table with its own scroll — can say
            `flex-1` and get it, without doing viewport arithmetic that
            goes stale the next time a bar is added. */}
        <main
          id="screen"
          /*
           * `0`, not `-1`, because this is the box that scrolls.
           *
           * It was -1: enough for the skip link to land on, and invisible in
           * the tab order, which is what you want for a container that does
           * nothing. Once the screen became the scroller it started doing
           * something — and a region you can scroll with a wheel and not with
           * a keyboard is a screen somebody cannot read. axe says so as
           * `scrollable-region-focusable`, and it found exactly one screen in
           * a hundred and seven: a page of charts, with nothing on it to
           * press. Every other screen has a button or a link inside, which
           * satisfies the rule and hides the problem.
           *
           * The cost is one tab stop at the top of the content, after the
           * skip link. That is the right place for it.
           */
          // biome-ignore lint/a11y/noNoninteractiveTabindex: right about a main that only holds things, wrong about one that scrolls — see above
          tabIndex={0}
          className="app-screen flex min-w-0 flex-1 flex-col overflow-y-auto p-6"
        >
          {/*
           * The screen, and only the screen, when a render throws.
           *
           * React takes the whole tree down for an uncaught render error, so
           * without this one screen's bad afternoon is a white page with no
           * header, no rail and no way back but a reload. Inside `main`, so
           * everything a person needs to leave the broken screen is outside
           * the boundary and still drawn.
           *
           * Keyed on the screen, so moving to another one clears it. A
           * boundary that has caught stays caught until it is remounted, and
           * a person who navigates away and finds the same error waiting is
           * being told something untrue about where they are.
           */}
          <MissingScreen />
          <ErrorBoundary key={current.moduleId} label={label || "This screen"}>
            {children}
          </ErrorBoundary>
        </main>
      </div>

      {/*
        A bar at the bottom, the same weight as the one at the top.
        
        Asked for by James on 26 September 2026, to be filled in later. It
        carries the two things worth having on every screen in the
        meantime: what this is, and which release it is running — the
        first question of every support conversation, and until now
        readable only from `/healthz` or the licence screen.
        
        Outside the row that holds the rail and the panel, so it sits
        under all three. It is the last row of a fixed frame, which is
        what puts it at the foot of the window wherever the screen above
        has been scrolled to — and what lets the rail and the panel run
        all the way down to it.
      */}
      <footer className="app-footer">
        <div className="flex h-11 items-center gap-3 px-4 text-xs">
          {/* Both facts together at the right-hand end, rather than one in
              each corner with the width of the window between them. */}
          <span className="ml-auto" style={muted}>
            Sentrello
          </span>
          {/*
            Not "unknown", which is what an instance built outside the
            release pipeline reports and what a developer's own copy says.
            A version nobody can act on is worse than no version at all.
          */}
          {version && version !== "unknown" ? (
            <span className="tabular-nums" style={muted}>
              {version}
            </span>
          ) : null}
        </div>
      </footer>
    </div>
  );
}
