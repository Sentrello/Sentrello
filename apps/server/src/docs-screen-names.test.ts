import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import account from "@sentrello/module-account";
import archive from "@sentrello/module-archive";
import crm from "@sentrello/module-crm";
import dashboard from "@sentrello/module-dashboard";
import money from "@sentrello/module-money";
import profile from "@sentrello/module-profile";
import { registerForTest } from "@sentrello/module-sdk";
import settings from "@sentrello/module-settings";
import users from "@sentrello/module-users";

/**
 * A screen the documentation sends somebody to, by the name the sidebar gives it.
 *
 * The getting-started pages are written as **Settings → Your business**, and on
 * 2026-09-29 six of those names were wrong: `Settings → Business`,
 * `Settings → Money`, `Settings → Payments`, `Settings → Licence`,
 * `Settings → Updates`, and a `Settings → Email` that has never existed at all —
 * along with a **Send a test message** button on it, described twice. A customer
 * on their first morning, following the third page of the manual, looking for
 * five screens of which one is real.
 *
 * Nothing could have caught it. The labels are registered in TypeScript, the
 * pages are prose, and the documentation is served live from this repository —
 * so a screen renamed here is a wrong instruction in front of a customer inside
 * the minute.
 *
 * The labels come from the modules themselves rather than a list written down
 * beside them: a second copy of the sidebar would go stale in exactly the way
 * this exists to stop.
 *
 * **Only this repository's own screens.** A page naming a Pro or module screen —
 * `Projects → Time`, say — is not checked here, because the label lives in
 * another repository. The parents below are the Free tier's, which is where the
 * getting-started pages live.
 */
const root = join(import.meta.dir, "..", "..", "..");
const site = join(root, "docs", "site");

/** Section headings this repository owns, as the sidebar prints them. */
const OURS = new Set(["Settings", "Money", "Users", "CRM", "Invoicing"]);

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** Every nav entry the Free modules register, as `{id, label, parent}`. */
function registered(): { id: string; label: string; parent?: string }[] {
  const entries: { id: string; label: string; parent?: string }[] = [];
  /*
   * The same list `apps/server/src/index.ts` boots with. Written out rather
   * than imported from there, because importing that file starts a server.
   */
  const free = [
    dashboard,
    crm,
    money,
    settings,
    profile,
    users,
    archive,
    account,
  ];
  for (const mod of free) {
    registerForTest(mod, undefined, () => true, {
      registerNav: (entry) =>
        entries.push(entry as { id: string; label: string; parent?: string }),
    });
  }
  return entries;
}

/** "Settings → Your business", for every parent and child that really exist. */
function realPairs(): Set<string> {
  const entries = registered();
  const labelOf = new Map(entries.map((e) => [e.id, e.label]));
  const pairs = new Set<string>();
  for (const entry of entries) {
    const parent = entry.parent ? labelOf.get(entry.parent) : undefined;
    if (parent) pairs.add(`${parent} → ${entry.label}`);
  }
  return pairs;
}

/** `**Settings → Your business**`, and only the sections this repo owns. */
const MENTION = /\*\*([A-Z][A-Za-z ]*?) → ([A-Za-z][A-Za-z '-]*?)\*\*/g;

test("the modules register some screens at all", () => {
  // Without this every assertion below passes against an empty set, which is
  // the failure this repository keeps finding in its own guards.
  expect(realPairs().size).toBeGreaterThan(8);
});

test("every screen the documentation names is a screen the sidebar has", () => {
  const real = realPairs();
  const wrong: string[] = [];
  for (const page of pages(site)) {
    const text = readFileSync(page, "utf8");
    for (const [, section, screen] of text.matchAll(MENTION)) {
      if (!OURS.has(section as string)) continue;
      const pair = `${section} → ${screen}`;
      if (!real.has(pair))
        wrong.push(`${page.slice(root.length + 1)}: ${pair}`);
    }
  }
  expect([...new Set(wrong)]).toEqual([]);
});
