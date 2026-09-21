import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
import { FindButton } from "./find";
import { Icon, type IconName } from "./icons";
import { useNavigation } from "./navigation";
import { type Theme, useTheme } from "./theme";

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
  "Sales",
  "Money",
  "Work",
  // Everything that brings somebody in before there is a sale to make. It was
  // missing from this list entirely, which is not a small thing: an unlisted
  // group scores 99 and sorts below `Configuration`, so Links, Search and
  // Documentation rendered *under* Settings and Users. Nobody chose that — it
  // was the absence of two lines, and the order this list exists to state was
  // not the order anybody saw.
  "Marketing",
  // Nothing registers this yet; HR will. Kept so the day it arrives it lands
  // where it belongs rather than at the end with the unranked.
  "People",
  // Only ever present on sentrello.com's own instance, where it runs the
  // business that sells this. Above Configuration because it is where the day's
  // work happens there, and settings are settings wherever you are.
  "Master",
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
  // Growth rather than a megaphone, which this set does not have. Unused by any
  // module, which matters: a group and a module drawing the same glyph is two
  // different things wearing one face.
  Marketing: "trending-up",
  People: "users",
  Master: "boxes",
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
  return sectionsOf(pages).flatMap((part) =>
    part.heading
      ? [
          {
            id: `${prefix}/${part.heading}`,
            label: part.heading,
            children: part.items.map(leafNode),
          },
        ]
      : part.items.map(leafNode),
  );
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
              className={`nav-link nav-parent${depth > 0 ? " nav-child" : ""}`}
              aria-current={node.entry?.id === currentId ? "page" : undefined}
              aria-expanded={node.children.length ? open : undefined}
              onClick={() => {
                if (node.children.length) onToggle(node);
                else if (node.entry) onGo(node.entry);
              }}
            >
              {node.icon ? <Icon name={node.icon} size={16} /> : null}
              <span className="flex-1 text-left">{node.label}</span>
              {node.children.length ? (
                // A drawn chevron, not "▸" at 0.6rem. The glyph renders at
                // whatever weight the font has for it, which on the stack this
                // app uses is barely a mark on the screen.
                <span className="nav-caret" data-open={open}>
                  <Icon name="chevron-right" size={16} />
                </span>
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

  /** Rows opened out. Whatever holds the screen you are on starts open. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (node: NavNode) =>
    expanded[node.id] ?? holds(node, current.moduleId);

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

  return (
    <div className="flex items-stretch" data-shell>
      <nav className="app-rail" aria-label="Modules">
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
              <Icon name={item.icon} size={20} />
            </button>
          );
        })}
        {showPanel ? (
          /**
           * Hide and show the panel without re-rendering what it frames.
           *
           * One attribute on the shell, flipped in the DOM: the panel is a
           * frame around whatever screen is open, and collapsing a frame
           * should not re-render the thing inside it, nor stop working when
           * a module screen throws — both of which React state here would.
           *
           * This was a visually-hidden checkbox driven by a label, which is
           * the same trick with no JavaScript. It was also a control a
           * keyboard user could tab to and see nothing at all: focus sat on
           * an element clipped to a pixel, with the icon on a label that
           * cannot take focus. A button is focusable, says whether the panel
           * is open, and shows where the focus is.
           */
          <button
            type="button"
            className="rail-button mt-auto"
            aria-expanded="true"
            aria-controls="section-panel"
            aria-label="Hide or show the section panel"
            title="Hide or show the section panel"
            onClick={(e) => {
              const shell = e.currentTarget.closest("[data-shell]");
              const hidden = shell?.toggleAttribute("data-panel-hidden");
              e.currentTarget.setAttribute(
                "aria-expanded",
                hidden ? "false" : "true",
              );
            }}
          >
            <Icon name="panel-left" size={20} />
          </button>
        ) : null}
      </nav>

      {showPanel && group ? (
        <>
          <aside
            id="section-panel"
            className="app-sidebar p-2"
            aria-label="Screens"
          >
            <p className="panel-title">{group.label}</p>
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
    <div
      className="flex gap-1 border-t px-3 py-2"
      style={{ borderColor: "var(--border)" }}
    >
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
        aria-haspopup="menu"
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
        <div className="menu-panel" role="menu">
          <div
            className="border-b px-3 py-2"
            style={{ borderColor: "var(--border)" }}
          >
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

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenProfile();
            }}
          >
            Your profile
          </button>

          <button
            type="button"
            role="menuitem"
            className="menu-item"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            Settings
          </button>

          <ThemeChoice theme={theme} onChange={setTheme} />

          <button
            type="button"
            role="menuitem"
            className="menu-item border-t"
            style={{
              borderColor: "var(--border)",
              color: "var(--text-danger)",
            }}
            onClick={() => authClient.signOut()}
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
  children,
}: {
  nav: NavEntry[];
  user: { name?: string | null; email: string };
  children: React.ReactNode;
}) {
  const { go } = useNavigation();

  // Settings reaches the sidebar under Configuration and the profile menu both.
  // Two ways to the same screen is not duplication here: one is where you look
  // when configuring the platform, the other where you look when it is your
  // own account you are thinking about.
  const settings = nav.find((n) => n.id === "settings");
  const first = nav.find((n) => n.id !== "settings") ?? nav[0];

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

  return (
    <div className="min-h-screen">
      {/* Global: who you are, and the way home. The modules are not up here —
          fifteen of them scrolling sideways told you nothing about how they
          relate, which was the whole complaint. */}
      <header className="app-header">
        <div className="flex h-13 items-center gap-3 px-4 py-2">
          <button
            type="button"
            onClick={() => first && go(first.id, first.label)}
            className="shrink-0 font-semibold"
          >
            Sentrello
          </button>
          <div className="flex-1" />
          <FindButton />
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

      <div className="flex items-start">
        <Sidebar nav={nav} />
        {/* The body is at least the height of the screen below the header, and
            a column, so a module that wants to fill the window — a builder, a
            board, a table with its own scroll — can say `flex-1` and get it.
            Without this the body was only as tall as its content and every
            such screen stopped halfway down an empty page. 3.25rem is the
            header, the same figure the rail and the panel are cut to. */}
        <main className="flex min-h-[calc(100vh-3.25rem)] min-w-0 flex-1 flex-col p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
