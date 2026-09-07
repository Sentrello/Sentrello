import { useEffect, useRef, useState } from "react";
import { authClient } from "./auth";
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
  /** Set on a module's own pages: the id of the entry they sit under. */
  parent?: string;
  icon?: string;
}

/**
 * Sections, in the order a business works through them rather than
 * alphabetically: find the customer, agree the price, take the money, do the
 * job. A section the host has never heard of sorts to the end rather than
 * being dropped — a module may name its own.
 */
const GROUP_ORDER = [
  "Sales",
  "Money",
  "Work",
  "People",
  // Only ever present on sentrello.com's own instance, where it runs the
  // business that sells this. Above Configure because it is where the day's
  // work happens there, and settings are settings wherever you are.
  "Master",
  "Configure",
];

/** Whatever the rail should draw for a section that named no icon of its own. */
const GROUP_ICONS: Record<string, IconName> = {
  // A handshake, not a contact card: the section is where a deal gets agreed,
  // and the card belongs to Contacts, which is one screen inside it.
  Sales: "handshake",
  Money: "receipt",
  Work: "briefcase",
  People: "users",
  Master: "boxes",
  Configure: "settings",
};

/** One module, as the rail draws it and the panel opens it. */
export interface RailModule {
  moduleId: string;
  label: string;
  icon: IconName;
  items: NavEntry[];
}

/**
 * The rail, one icon per module.
 *
 * It used to be one icon per *section* — Sales, Money, Work — with the modules
 * inside. That answered "what part of the business is this" and left the
 * question people actually arrive with, which is "where is Invoicing",
 * needing two clicks and knowing which section somebody had filed it under.
 *
 * So the rail is the modules themselves and the panel beside it is that
 * module's own pages. The sections survive as the *order*: find the customer,
 * agree the price, take the money, do the job. A module the host has never
 * heard of sorts to the end rather than being dropped.
 */
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

  const position = (name: string | undefined) => {
    if (!name) return -1;
    const known = GROUP_ORDER.indexOf(name);
    return known === -1 ? 99 : known;
  };

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

/** A module's own pages, in the order it registered them. */
export function childrenOf(nav: NavEntry[], parentId: string): NavEntry[] {
  return nav.filter((n) => n.parent === parentId);
}

/**
 * Whether the second level of the sidebar has anything to say.
 *
 * A module with one entry and no pages of its own only repeats the icon the
 * rail already showed. The Dashboard is exactly that, and always will be.
 * Fifteen rem of panel to restate one word is fifteen rem taken off the screen
 * somebody is trying to work in.
 */
export function panelWorthShowing(
  nav: NavEntry[],
  module: RailModule | undefined,
): boolean {
  if (!module) return false;
  const only = module.items.length === 1 ? module.items[0] : undefined;
  return !(only && childrenOf(nav, only.id).length === 0);
}

/**
 * The sidebar, in two levels.
 *
 * A rail of sections on the left, and the section you are in opened beside it.
 * One flat list of every screen said nothing about what belongs with what —
 * fifteen equal items, with the CRM's five pages burying the Shop. The rail
 * says "these are the parts of the business"; the panel says "this is what is
 * in this part"; and a module with several screens opens into them.
 */
function Sidebar({ nav }: { nav: NavEntry[] }) {
  const { current, go } = useNavigation();
  const modules = railModules(nav);

  /** Which entry is on screen, so the rail and the panel can both mark it. */
  const activeEntry = nav.find((n) => n.id === current.moduleId);
  const parentEntry = activeEntry?.parent
    ? nav.find((n) => n.id === activeEntry.parent)
    : undefined;
  const activeModule =
    (parentEntry ?? activeEntry)?.moduleId ??
    (parentEntry ?? activeEntry)?.id ??
    "";

  /**
   * The module the panel is showing.
   *
   * It follows wherever you are by default, so arriving on a screen opens the
   * module it belongs to. Clicking the rail pins a different one — somebody
   * looking for the next thing to do should be able to browse without leaving
   * the screen they are on.
   */
  const [pinned, setPinned] = useState<string | null>(null);
  const shown = pinned ?? activeModule;
  const section = modules.find((m) => m.moduleId === shown) ?? modules[0];

  /** Modules opened out into their pages. Expanded where you are working. */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isOpen = (entry: NavEntry) =>
    expanded[entry.id] ??
    (current.moduleId === entry.id || activeEntry?.parent === entry.id);

  const showPanel = panelWorthShowing(nav, section);

  /** A parent is not a screen: opening one opens the first page under it. */
  const openEntry = (entry: NavEntry) => {
    const pages = childrenOf(nav, entry.id);
    const first = pages[0];
    if (first) {
      setExpanded((e) => ({ ...e, [entry.id]: true }));
      go(first.id, first.label);
      return;
    }
    go(entry.id, entry.label);
  };

  return (
    <div className="flex items-stretch">
      <nav className="app-rail" aria-label="Modules">
        {modules.map((module) => {
          const here = shown === module.moduleId;
          return (
            <button
              key={module.moduleId}
              type="button"
              className="rail-button"
              aria-label={module.label}
              title={module.label}
              aria-current={here ? "true" : undefined}
              onClick={() => {
                setPinned(module.moduleId);
                /**
                 * A rail click goes somewhere.
                 *
                 * An icon that only ever highlights is a dead end — and with
                 * one icon per module rather than per section, every click has
                 * an obvious destination: the module's first page.
                 */
                const first = module.items[0];
                if (first) openEntry(first);
              }}
            >
              <Icon name={module.icon} size={20} />
            </button>
          );
        })}
        {showPanel ? (
          /**
           * Hide and show the panel with no JavaScript at all.
           *
           * A checkbox and a sibling selector, rather than React state: the
           * panel is a frame around whatever screen is open, and collapsing a
           * frame should not re-render the thing inside it. It also survives
           * a module screen throwing, which state in this component does not.
           */
          <label className="rail-button mt-auto" htmlFor="sidebar-collapse">
            <Icon name="panel-left" size={20} />
            <span className="sr-only">Hide or show the section panel</span>
          </label>
        ) : null}
      </nav>

      {showPanel && section ? (
        <>
          <input id="sidebar-collapse" type="checkbox" className="sr-only" />
          <aside className="app-sidebar p-2" aria-label="Screens">
            <p className="panel-title">{section.label}</p>
            {section.items.map((entry) => {
              const pages = childrenOf(nav, entry.id);
              const open = isOpen(entry);
              const activeHere =
                current.moduleId === entry.id ||
                pages.some((p) => p.id === current.moduleId);

              return (
                <div key={entry.id}>
                  <button
                    type="button"
                    className="nav-link nav-parent"
                    aria-current={
                      activeHere && pages.length === 0 ? "page" : undefined
                    }
                    aria-expanded={pages.length ? open : undefined}
                    onClick={() => {
                      if (pages.length) {
                        // Already looking at one of its pages: fold it away
                        // rather than reopening what is already open.
                        setExpanded((e) => ({ ...e, [entry.id]: !open }));
                        if (!open) openEntry(entry);
                      } else {
                        openEntry(entry);
                      }
                    }}
                  >
                    <Icon
                      name={(entry.icon ?? "layout") as IconName}
                      size={16}
                    />
                    <span className="flex-1 text-left">{entry.label}</span>
                    {pages.length ? (
                      // A drawn chevron, not "▸" at 0.6rem. The glyph renders
                      // at whatever weight the font has for it, which on the
                      // stack this app uses is barely a mark on the screen.
                      <span className="nav-caret" data-open={open}>
                        <Icon name="chevron-right" size={16} />
                      </span>
                    ) : null}
                  </button>

                  {pages.length && open ? (
                    <div className="nav-children">
                      {pages.map((page) => (
                        <button
                          key={page.id}
                          type="button"
                          className="nav-link nav-child"
                          aria-current={
                            current.moduleId === page.id ? "page" : undefined
                          }
                          onClick={() => go(page.id, page.label)}
                        >
                          {page.label}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
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
                  background: "var(--color-brand-500)",
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
          background: "var(--color-brand-500)",
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
              color: "var(--color-danger)",
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

  // Settings reaches the sidebar under Configure and the profile menu both.
  // Two ways to the same screen is not duplication here: one is where you look
  // when configuring the platform, the other where you look when it is your
  // own account you are thinking about.
  const settings = nav.find((n) => n.id === "settings");
  const first = nav.find((n) => n.id !== "settings") ?? nav[0];

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
