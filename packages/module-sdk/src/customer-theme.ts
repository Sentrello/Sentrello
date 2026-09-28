/**
 * Light or dark on the pages a customer sees, chosen once and kept.
 *
 * A business's customer meets several pages across several modules — their
 * account, an invoice, a subscription, a booking, a plan for a job — and each
 * is a standalone HTML page served to somebody with no login and no bundle.
 * The choice has to survive the walk between them, which means one cookie,
 * one name, one path, read on the server so the page arrives in the right
 * colours rather than correcting itself in front of the reader.
 *
 * A link rather than a script, deliberately: these pages are opened from
 * email, on trains, with scripts blocked, and a toggle that needs JavaScript
 * is a toggle that sometimes is not there. Every page that offers it links to
 * itself with `?theme=` and the server does the rest.
 *
 * Set by James, 21 September, after the account page had a toggle and the
 * pages it links to did not.
 */

export type CustomerTheme = "light" | "dark";

/** The cookie every customer-facing page reads. Path `/`, because they span modules. */
export const CUSTOMER_THEME_COOKIE = "sentrello_theme";

/** What they chose last time, or nothing, in which case the machine decides. */
export function readCustomerTheme(
  cookie: string | undefined,
): CustomerTheme | undefined {
  const found = new RegExp(`${CUSTOMER_THEME_COOKIE}=(light|dark)`).exec(
    cookie ?? "",
  );
  return (found?.[1] as CustomerTheme | undefined) ?? undefined;
}

/**
 * The cookie to set when somebody asks for a theme, for a year.
 *
 * `HttpOnly`, because nothing but the server drawing the page reads it, and
 * `SameSite=Lax` so it survives arriving from an email without travelling on
 * cross-site requests.
 */
export function customerThemeCookie(theme: CustomerTheme): string {
  return `${CUSTOMER_THEME_COOKIE}=${theme}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax`;
}

/**
 * The theme this request should draw in, and the cookie to set if it changed.
 *
 * One call per page: it reads `?theme=` first, the cookie second, and returns
 * nothing at all when neither says — which is the state where the reader's own
 * machine decides, and the one most pages are in.
 */
export function customerThemeFor(request: {
  query: (name: string) => string | undefined;
  header: (name: string) => string | undefined;
}): { theme?: CustomerTheme; setCookie?: string } {
  const asked = request.query("theme");
  if (asked === "light" || asked === "dark") {
    return { theme: asked, setCookie: customerThemeCookie(asked) };
  }
  return { theme: readCustomerTheme(request.header("cookie")) };
}

/**
 * The CSS every customer page shares, so light and dark mean the same thing
 * on all of them.
 *
 * Three states rather than two: the customer's choice wins, and where they
 * have not made one the machine's preference does. Each module keeps its own
 * layout; this is only the palette and the switch.
 */
export const CUSTOMER_THEME_CSS = `
:root{color-scheme:light dark;--ink:#18181b;--muted:#71717a;--line:#e4e4e7;--bg:#fafafa;--card:#fff}
/* Dark is a screen thing, and saying so is the whole of the fix below.

   Both of these used to apply to paper as well. They out-specify a plain
   :root — :not([data-theme="light"]) adds a class's worth — so the
   print block further down could not undo them, and a customer whose
   browser is in dark mode printed their invoice as near-white text on
   near-black. Either it swallows a cartridge, or, with background graphics
   off as every browser ships them, it comes out of the tray looking blank.
   On the one document this product exists to produce. */
@media screen and (prefers-color-scheme: dark){:root:not([data-theme="light"]){--ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#0c0c0d;--card:#161618}}
@media screen{:root[data-theme="dark"]{color-scheme:dark;--ink:#f4f4f5;--muted:#a1a1aa;--line:#27272a;--bg:#0c0c0d;--card:#161618}}
:root[data-theme="light"]{color-scheme:light}
.theme-switch{display:inline-flex;align-items:center;justify-content:center;width:2.25rem;height:2.25rem;border:1px solid var(--line);border-radius:.6rem;color:var(--muted);text-decoration:none}
.theme-switch:hover{color:var(--ink)}
.theme-switch svg{width:1.125rem;height:1.125rem}
.theme-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
/* Ink on white, whatever the screen was doing, and no switch to press on a
   sheet of paper. */
@media print{
  :root{color-scheme:light;--ink:#000;--muted:#3f3f46;--line:#bbb;--bg:#fff;--card:#fff}
  .theme-switch{display:none}
}
`;

const SUN =
  '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const MOON =
  '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>';

/**
 * The switch itself: a link back to this page asking for the other theme.
 *
 * `path` is the page's own address. It carries the icon for what pressing it
 * gives you — a moon to go dark — and the words for a reader who cannot see
 * the icon, because a `title` is a tooltip and not a label.
 */
export function customerThemeSwitch(
  path: string,
  theme: CustomerTheme | undefined,
): string {
  const wanted: CustomerTheme = theme === "dark" ? "light" : "dark";
  const label = wanted === "dark" ? "Switch to dark" : "Switch to light";
  const join = path.includes("?") ? "&" : "?";
  return `<a class="theme-switch" href="${path}${join}theme=${wanted}" title="${label}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
    wanted === "dark" ? MOON : SUN
  }</svg><span class="theme-sr">${label}</span></a>`;
}

/** `data-theme="dark"` when they chose, and nothing when they have not. */
export function themeAttribute(theme: CustomerTheme | undefined): string {
  return theme ? ` data-theme="${theme}"` : "";
}
