/**
 * Pulls the platform's icons from the streamline-freehand set.
 *
 * The map below is the whole of it: our own icon name on the left — the name
 * a module asks for and a route renders — and the artwork's name on the
 * right. Two of ours may point at one drawing; that is deliberate, and the
 * comment beside each pair says why.
 *
 *   node apps/web/scripts/fetch-icons.mjs
 *
 * It writes `src/lib/icon-freehand.ts` and formats it. Re-runnable: the
 * output is sorted, so a second run with no change to the map is a no-op.
 *
 * A name the set does not have comes back missing rather than wrong — the
 * API drops what it cannot find and says nothing — so this stops on the
 * first one it cannot account for.
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Our name -> the name in the streamline-freehand set. */
const ICONS = {
  asterisk: "keyboard-asterisk-1",
  // Connections, not the newsletter: this one is literally the @ symbol.
  "at-sign": "read-email-at-symbol",
  bolt: "connect-flash",
  "book-open": "learning-programming-book",
  boxes: "module-three-boxes",
  briefcase: "job-briefcase-document",
  building: "office-building-glass-window",
  calculator: "accounting-calculator",
  calendar: "calendar-grid",
  "calendar-1": "calendar-date",
  chart: "seo-search-graph",
  "check-square": "form-validation-check-square-1",
  "chevron-down": "keyboard-keypad-pull-down",
  "chevron-right": "navigation-page-right",
  clipboard: "form-edition-clipboard",
  clock: "time-clock-circle",
  // Both names mean a person's record, and a business card is what that is.
  contact: "office-business-card",
  "contact-round": "office-business-card",
  "credit-card": "credit-card-1",
  "file-text": "office-file-text",
  files: "archive-drawer-1",
  filter: "filter",
  gauge: "dashboard-browser-gauge",
  gift: "donation-charity-donate-box",
  handshake: "business-deal-handshake",
  helpdesk: "help-headphones-customer-support-human",
  home: "dashboard-layout",
  "id-badge": "face-id-square",
  kanban: "website-development-code-flowchart-1",
  key: "lock-key-1",
  landmark: "saving-bank",
  layout: "layouts-array-1",
  link: "analytics-board-graph-line",
  list: "lists-bullets",
  mail: "mailbox-full-1",
  marketing: "advertising-ad-browser",
  "more-horizontal": "menu-navigation-horizontal",
  notice: "alerts-warning-triangle",
  package: "archive-box",
  "panel-left": "menu-navigation-2",
  phone: "phone-retro-1",
  plus: "add-sign-bold",
  receipt: "receipt",
  // One drawing for both: a cycle is a cycle, whether it repeats or refreshes.
  "refresh-cw": "flip-rotate-clockwise",
  repeat: "flip-rotate-clockwise",
  search: "search-magnifier",
  settings: "settings-cog-double-1",
  share: "share-forward",
  shield: "security-computer-shield",
  "shopping-bag": "shopping-bag-side",
  // The shop front stands for the whole module, cart or storefront.
  "shopping-cart": "shop",
  sliders: "controls-sliders-vertical",
  store: "shop",
  tag: "tag-sale-price",
  till: "shop-cashier",
  trash: "delete-bin-2",
  "trending-up": "analytics-graph-stock",
  user: "human-resources-businessman",
  users: "composition-man",
  wallet: "money-coin-cash",
};

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "../src/lib/icon-freehand.ts");

const wanted = [...new Set(Object.values(ICONS))].sort();
const bodies = new Map();

for (let i = 0; i < wanted.length; i += 40) {
  const batch = wanted.slice(i, i + 40);
  const url = `https://api.iconify.design/streamline-freehand.json?icons=${batch.join(",")}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  const json = await res.json();
  for (const [name, icon] of Object.entries(json.icons ?? {})) {
    bodies.set(name, icon.body);
  }
}

const missing = wanted.filter((n) => !bodies.get(n)?.trim());
if (missing.length) {
  throw new Error(
    `the set has no icon called ${missing.join(", ")} — the name is wrong, or it has been renamed upstream; nothing was written`,
  );
}

const entries = Object.keys(ICONS)
  .sort()
  .map(
    (ours) =>
      `  ${JSON.stringify(ours)}: ${JSON.stringify(bodies.get(ICONS[ours]))},`,
  )
  .join("\n");

writeFileSync(
  outFile,
  `/**
 * The platform's icons. **Generated — do not edit.**
 *
 * \`apps/web/scripts/fetch-icons.mjs\` writes this file, and the map of which
 * drawing means what lives there. Editing a path here is work the next run
 * throws away.
 *
 * Artwork: the streamline-freehand set by Streamline
 * (https://icon-sets.iconify.design/streamline-freehand/), used under
 * CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The credit is in
 * \`NOTICE\` at the root of this repository, which is where the licence wants
 * it — attribution travels with the distribution, not with the file.
 *
 * Each value is the inner markup of a 24x24 SVG, filled with \`currentColor\`.
 */

export const FREEHAND: Record<string, string> = {
${entries}
};
`,
);

const fmt = spawnSync("bunx", ["biome", "check", "--write", outFile], {
  stdio: "inherit",
});
if (fmt.status !== 0)
  throw new Error("biome could not format the written file");

console.log(
  `wrote ${Object.keys(ICONS).length} icons from ${wanted.length} drawings`,
);
