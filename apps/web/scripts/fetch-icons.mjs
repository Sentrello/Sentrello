/**
 * Pulls the platform's icons from the streamline-flex set.
 *
 * The map below is the whole of it: our own icon name on the left — the name
 * a module asks for and a route renders — and the artwork's name on the
 * right. Two of ours may point at one drawing; that is deliberate, and the
 * comment beside each pair says why.
 *
 *   node apps/web/scripts/fetch-icons.mjs
 *
 * It writes `src/lib/icon-flex.ts` and formats it. Re-runnable: the
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

/**
 * Our name -> the name in the streamline-flex set.
 *
 * Nineteen module drawings are James's own choices, made against the set
 * rather than against a search result, and they are the reason the swap
 * happened at all — the previous set drew every module in the same
 * good-natured scribble and none of them looked like the thing they opened.
 * The rest are matched to the nearest drawing in the same hand, so the
 * application speaks in one voice instead of two.
 *
 * `-remix` and `-solid` variants exist upstream for most of these. We take
 * the base name every time: the outline is the one that reads at 18px, which
 * is the size the rail draws.
 */
const ICONS = {
  // ---- The modules, as James chose them, 24 September 2026 ----------------
  "calendar-1": "calendar-mark", // Booking
  settings: "cog", // the Configuration group
  sliders: "screwdriver-wrench", // the Settings module inside it
  "contact-round": "user-identifier-card", // CRM
  home: "home-2", // Dashboard
  "book-open": "dictionary-language-book", // Documentation
  helpdesk: "customer-support-7",
  store: "shopping-cart-2", // Shop
  till: "coin-share", // POS
  "at-sign": "sign-at", // Newsletter
  wallet: "wallet", // Money
  marketing: "target", // the Marketing group
  seo: "rocket",
  handshake: "decent-work-and-economic-growth", // the Sales group
  link: "link-chain", // Links
  files: "safe-vault", // Storage
  "id-badge": "user-circle-single", // Users
  "refresh-cw": "subscription-cashflow", // Subscriptions
  kanban: "hierarchy-16", // Projects
  social: "chat-bubble-text-square",
  hr: "office-building-1",
  inventory: "warehouse-1",

  // ---- Everything else, matched to the nearest drawing -------------------
  bolt: "flash-3",
  boxes: "module-puzzle-2",
  briefcase: "bag-suitcase-4", // the Work group
  building: "building-1",
  calculator: "calculator-1",
  calendar: "blank-calendar",
  chart: "graph-bar-increase-square",
  "check-square": "check-square",
  clipboard: "empty-clipboard",
  clock: "stopwatch",
  // Both names mean a person's record, and this is the card that record sits on.
  contact: "user-identifier-card",
  "credit-card": "credit-card-4",
  "file-text": "text-file",
  filter: "filter-2",
  gauge: "dashboard-gauge-1",
  key: "padlock-square-1",
  landmark: "investing-and-banking", // a bank account, not a monument
  layout: "layout-window-1",
  list: "notepad-text",
  mail: "mail-send-envelope",
  // Chosen for want of a better, like chevron-right above: no ellipsis exists.
  "more-horizontal": "dial-pad-finger-2",
  notice: "warning-diamond",
  package: "shipping-box-2",
  "panel-left": "layout-right-sidebar",
  phone: "phone",
  // Chosen for want of a better: the set has no bare plus.
  plus: "application-add",
  receipt: "receipt",
  // A cycle, where `refresh-cw` now means a subscription specifically.
  repeat: "rotate-right-circle",
  search: "magnifying-glass",
  share: "share-link",
  shield: "shield-1",
  "shopping-bag": "bag",
  // The cart stands for the whole module, bag or storefront.
  "shopping-cart": "shopping-cart-2",
  tag: "tag",
  trash: "recycle-bin",
  "trending-up": "dollar-increase", // a deal going the right way
  user: "user-full-body",
  users: "user-collaborate-group", // the People group
};

const here = dirname(fileURLToPath(import.meta.url));
const outFile = join(here, "../src/lib/icon-flex.ts");

const wanted = [...new Set(Object.values(ICONS))].sort();
const bodies = new Map();

for (let i = 0; i < wanted.length; i += 40) {
  const batch = wanted.slice(i, i + 40);
  const url = `https://api.iconify.design/streamline-flex.json?icons=${batch.join(",")}`;
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
 * Artwork: the streamline-flex set by Streamline
 * (https://icon-sets.iconify.design/streamline-flex/), used under
 * CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/). The credit is in
 * \`NOTICE\` at the root of this repository, which is where the licence wants
 * it — attribution travels with the distribution, not with the file.
 *
 * Each value is the inner markup of a 24x24 SVG, filled with \`currentColor\`.
 */

export const FLEX: Record<string, string> = {
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
