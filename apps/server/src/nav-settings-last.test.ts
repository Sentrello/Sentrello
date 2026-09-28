import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import account from "@sentrello/module-account";
import archive from "@sentrello/module-archive";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import money from "@sentrello/module-money";
import profile from "@sentrello/module-profile";
import type { SentrelloEnv } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";
import { Hono } from "hono";
import { loadModules } from "./loader";

/**
 * The rules the sidebar has to keep, read off the menu a customer reads.
 *
 * Two of them so far. Settings last, which James set for the whole product;
 * and a page that leads the panel meaning to lead it, which is the trap at
 * the bottom of this file.
 *
 * Settings are the last thing in a menu, wherever you are.
 *
 * A rule for the whole product, set by James on 26 September 2026 after
 * reading the Money panel: "settings should always be the last sidebar
 * item". The top level had followed it for months without anybody writing
 * it down — `Configuration` is the last entry in `GROUP_ORDER` — and inside
 * a module's own panel nothing did. Invoice settings sat third of four
 * under "Getting paid", between the invoices and the tax returns, so the
 * screen a business opens twice a year was in the middle of the ones it
 * opens twice a day.
 *
 * It is the kind of rule that holds until somebody adds a page. A module
 * author picks the next number after the last one they can see, and a
 * settings entry three rows up is exactly the thing not seen — which is why
 * this is a test rather than a note in a file.
 *
 * Loaded through the production loader with everything entitled, so it reads
 * the menu a customer reads and not a list written down twice.
 */
const { nav } = loadModules(new Hono<SentrelloEnv>(), () => true, [
  dashboard,
  crm,
  money,
  settings,
  profile,
  users,
  archive,
  account,
]);

interface Entry {
  id: string;
  label: string;
  parent?: string;
  section?: string;
  order?: number;
  group?: string;
}

const entries = nav as Entry[];

/**
 * What counts as settings.
 *
 * The id, because that is the part an author chooses deliberately and the
 * part that cannot be translated away; the section, because a page can be
 * configuration without saying so in its id — the paid half's "Tax and
 * currency" is rates and defaults, and reads as a fifth tax return until it
 * is under the right heading.
 *
 * Deliberately not the icon. Three screens in the product draw the cog
 * without being settings pages, and a guard that decides what a page *is*
 * from what it *looks like* is a guard that gets argued with rather than
 * fixed.
 */
function isSettings(entry: Entry): boolean {
  return (
    entry.id === "settings" ||
    entry.id.endsWith("-settings") ||
    entry.section === "Settings"
  );
}

const byOrder = (a: Entry, b: Entry) => (a.order ?? 0) - (b.order ?? 0);

/**
 * The rail's own order of groups, read as text.
 *
 * `GROUP_ORDER` lives in `app-shell.tsx`, and a server test cannot import a
 * browser component — `tsc` refuses the `.tsx` without `--jsx`, and the file
 * pulls in every screen in the product behind it. `nav-screens.test.ts` reads
 * `App.tsx` the same way and for the same reason.
 */
function groupOrder(): string[] {
  const source = readFileSync(
    join(import.meta.dir, "../../web/src/lib/app-shell.tsx"),
    "utf8",
  );
  const list = /export const GROUP_ORDER = \[([\s\S]*?)\];/.exec(source);
  if (!list) throw new Error("GROUP_ORDER is no longer a literal array");
  return [...(list[1] as string).matchAll(/"([^"]+)"/g)].map(
    (m) => m[1] as string,
  );
}

test("the last group in the rail is the one settings live in", () => {
  const groups = groupOrder();
  expect(groups.length, "read no groups at all").toBeGreaterThan(1);
  expect(groups[groups.length - 1]).toBe("Configuration");

  const configured = entries.filter((e) => !e.parent && isSettings(e));
  expect(
    configured.length,
    "no top-level settings entry at all, so this checked nothing",
  ).toBeGreaterThan(0);
  for (const entry of configured) {
    expect(
      entry.group,
      `${entry.id} is a settings entry in the ${entry.group} group, and settings belong in Configuration`,
    ).toBe("Configuration");
  }
});

test("inside a panel, a settings page comes after every page that is not one", () => {
  const parents = new Set(
    entries.map((e) => e.parent).filter((p): p is string => Boolean(p)),
  );

  for (const parent of parents) {
    const pages = entries.filter((e) => e.parent === parent).sort(byOrder);
    const last = pages.findLastIndex((p) => !isSettings(p));
    const early = pages.slice(0, last).filter(isSettings);

    expect(
      early.map((p) => p.label),
      `under ${parent}, ${early.map((p) => p.label).join(" and ")} ${
        early.length === 1 ? "is a settings page" : "are settings pages"
      } drawn above ${pages[last]?.label}`,
    ).toEqual([]);
  }
});

test("and the heading they sit under is the last heading", () => {
  const parents = new Set(
    entries.map((e) => e.parent).filter((p): p is string => Boolean(p)),
  );

  for (const parent of parents) {
    const pages = entries.filter((e) => e.parent === parent).sort(byOrder);
    // The headings in the order the panel draws them, first appearance
    // deciding — which is how the panel itself groups a sorted list.
    const headings: string[] = [];
    for (const page of pages) {
      if (page.section && !headings.includes(page.section))
        headings.push(page.section);
    }
    if (!headings.includes("Settings")) continue;

    expect(
      headings[headings.length - 1],
      `under ${parent} the headings run ${headings.join(" / ")}, and Settings is not the last of them`,
    ).toBe("Settings");
  }
});

/**
 * And the one it was written for, spelled out.
 *
 * The rules above are general and would pass on a Money panel that had no
 * settings page at all. This one fails if the page stops being there.
 */
test("Money ends with its settings", () => {
  const pages = entries.filter((e) => e.parent === "money").sort(byOrder);
  expect(
    pages.length,
    "nothing is under Money, so the two rules above checked nothing here",
  ).toBeGreaterThan(0);
  expect(pages[pages.length - 1]?.id).toBe("invoicing-settings");
});

/**
 * A page with no heading leads the panel — so it had better mean to.
 *
 * `sectionsOf` puts unsectioned pages first, deliberately: a page nobody has
 * filed should be visible rather than lost among headings. Every module's
 * own dashboard relies on it.
 *
 * The trap is that leaving the section off is silent, and the `order` then
 * says one thing while the panel does another. The CRM's Forms page was
 * numbered 4.5 — after Deals, with a comment saying it sits with the records
 * it feeds — and drew at the very top of the panel, above the "Records"
 * heading and beside the dashboard. A lead-capture screen outranking
 * Contacts in a CRM, for a missing line.
 *
 * So: an unsectioned page may lead, but it may not be numbered as though it
 * were in the middle of the filed ones. Anything between two sectioned
 * siblings is a page whose author meant it to sit there.
 */
test("a page that leads the panel is numbered as though it leads", () => {
  const parents = new Set(
    entries.map((e) => e.parent).filter((p): p is string => Boolean(p)),
  );

  for (const parent of parents) {
    const pages = entries.filter((e) => e.parent === parent).sort(byOrder);
    const filed = pages.filter((p) => p.section);
    if (filed.length === 0) continue; // A panel with no headings at all.

    const firstFiled = filed[0]?.order ?? 0;
    const hoisted = pages.filter(
      (p) => !p.section && (p.order ?? 0) > firstFiled,
    );

    expect(
      hoisted.map((p) => `${p.label} (${p.order})`),
      `under ${parent}, ${hoisted
        .map((p) => p.label)
        .join(
          " and ",
        )} sits below a heading by its number and above every heading on screen — give it a section, or number it before the first one`,
    ).toEqual([]);
  }
});
