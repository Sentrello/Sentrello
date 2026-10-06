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

/**
 * Section headings this repository owns, as the sidebar prints them.
 *
 * Written down rather than derived, and that is deliberate for the *product*
 * check further down, which greps source for these words. The documentation
 * check no longer uses it: a hand-written list of heads is a list of the heads
 * somebody remembered, and a path whose head was **removed from the product**
 * falls outside it and is never looked at. That is how the manual kept sending
 * people to `Accounting → Journal` for weeks after Accounting stopped being a
 * place in the rail — the guard existed, read the page, and skipped the line.
 */
const OURS = new Set(["Settings", "Money", "Users", "CRM", "Invoicing"]);

/**
 * Heads that belong to the commercial repositories, which this one cannot read.
 *
 * Pinned from both ends: an entry no page uses any more fails, so the list
 * cannot quietly grow into the thing that spares everything.
 */
const HEADS_ELSEWHERE = [
  "Booking",
  "Documentation",
  "Point of sale",
  "Search",
  "Shop",
];

/** An arrow in prose is not a path through the product. */
const NOT_A_PATH = new Set([
  // A route through these pages rather than through the sidebar.
  "Running it",
  // Screens of this repository, named as a parent in their own right.
  "Contacts",
  "Invoice settings",
]);

/**
 * The head, out of however much of the sentence came with it.
 *
 * The match is deliberately loose on the left — "the timezone set under
 * Settings → Modules" is one capture — so the head is the shortest run of words
 * at the end of it that the sidebar actually has. Taking the whole capture
 * reported five real paths as menus nothing registers, which is the sort of
 * noise that gets a guard switched off.
 */
function headOf(captured: string, known: Set<string>): string | null {
  const words = captured.trim().split(/\s+/);
  for (let from = 0; from < words.length; from++) {
    const candidate = words.slice(from).join(" ");
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) pages(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** Every head the sidebar has: a nav entry with nothing above it. */
function realHeads(): Set<string> {
  return new Set(
    registered()
      .filter((e) => !e.parent)
      .map((e) => e.label),
  );
}

/** Every nav entry the Free modules register, as `{id, label, parent}`. */
function registered(): {
  id: string;
  label: string;
  parent?: string;
  section?: string;
}[] {
  const entries: {
    id: string;
    label: string;
    parent?: string;
    section?: string;
  }[] = [];
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
        entries.push(
          entry as {
            id: string;
            label: string;
            parent?: string;
            section?: string;
          },
        ),
    });
  }
  return entries;
}

/**
 * "Settings → Your business", for every parent and child that really exist.
 *
 * **And the heading in between, where there is one.** Money files its pages
 * under sections — The books, Tax, Getting paid, Spending — and the sidebar
 * prints all three levels, so the manual writes `Money → The books → Journal`.
 * This read two segments and compared the first two, which made the section
 * look like a screen that does not exist: four correct paths reported as wrong
 * the day the manual was fixed to match the product. Both shapes are real now,
 * and a page may name either.
 */
function realPairs(): Set<string> {
  const entries = registered();
  const labelOf = new Map(entries.map((e) => [e.id, e.label]));
  const pairs = new Set<string>();
  for (const entry of entries) {
    const parent = entry.parent ? labelOf.get(entry.parent) : undefined;
    if (!parent) continue;
    pairs.add(`${parent} → ${entry.label}`);
    if (entry.section) {
      pairs.add(`${parent} → ${entry.section}`);
      pairs.add(`${parent} → ${entry.section} → ${entry.label}`);
    }
  }
  return pairs;
}

/**
 * `Settings → Your business`, bold or not.
 *
 * It matched only the bold spelling, and the documentation writes these both
 * ways — so `Settings → Licence` in a sentence went unread while the same words
 * in bold were checked, in the same file. The one that survived was wrong: the
 * screen is called Licence and updates.
 *
 * Prose runs on past the name — "Settings → Connections has a processor in it" —
 * so a mention is matched loosely here and compared by prefix below, the same
 * rule the product-side check uses.
 */
const MENTION =
  /(?:\*\*)?([A-Z][A-Za-z ]*?) → ([A-Z][A-Za-z '-]*[A-Za-z])(?: → ([A-Z][A-Za-z '-]*[A-Za-z]))?/g;

test("the modules register some screens at all", () => {
  // Without this every assertion below passes against an empty set, which is
  // the failure this repository keeps finding in its own guards.
  expect(realPairs().size).toBeGreaterThan(8);
});

/**
 * Screens the documentation may name that this repository cannot see.
 *
 * `registered()` above walks *this* repository's modules, and Pro and the
 * optional modules are private repositories that are not here. A pair naming one
 * of their screens is not a fault and cannot be verified from inside Core, so it
 * is named — with where it comes from, so the next person can check it there.
 *
 * Kept short on purpose. Anything Core registers belongs in the check, not here.
 */
const ELSEWHERE = new Set([
  // `pro-core/src/workflows.ts`, parent: "crm".
  "CRM → Automations",
]);

test("every screen the documentation names is a screen the sidebar has", () => {
  const real = realPairs();
  const heads = realHeads();
  const wrong: string[] = [];
  const usedElsewhere = new Set<string>();

  for (const page of pages(site)) {
    const text = readFileSync(page, "utf8");
    for (const [, section, screen, deeper] of text.matchAll(MENTION)) {
      const captured = section as string;

      const elsewhere = headOf(captured, new Set(HEADS_ELSEWHERE));
      if (elsewhere) {
        usedElsewhere.add(elsewhere);
        continue;
      }
      if (headOf(captured, NOT_A_PATH)) continue;

      /*
       * A head the sidebar does not have at all. Checked before the pair,
       * because this is the fault the old spelling of this test could not see:
       * it only looked at heads it already knew about.
       */
      const head = headOf(captured, heads);
      if (!head) {
        wrong.push(
          `${page.slice(root.length + 1)}: "${captured.split(/\s+/).slice(-3).join(" ")}" → … — nothing registers a menu called that`,
        );
        continue;
      }

      const pair = deeper
        ? `${head} → ${screen} → ${deeper}`
        : `${head} → ${screen}`;
      // Any real screen whose name this mention begins with, so a sentence that
      // carries on past the name is not a fault.
      if (ELSEWHERE.has(pair)) continue;
      if (![...real].some((r) => pair.startsWith(r))) {
        wrong.push(`${page.slice(root.length + 1)}: ${pair}`);
      }
    }
  }

  expect([...new Set(wrong)]).toEqual([]);

  const stale = HEADS_ELSEWHERE.filter((h) => !usedElsewhere.has(h));
  expect(
    stale,
    `these are excused as another repository's menus and no page names them any more:\n    ${stale.join("\n    ")}`,
  ).toEqual([]);
});

/**
 * And the same for a screen the *product* names out loud.
 *
 * An error message that sends somebody to "Settings → Licence" when the sidebar
 * says "Licence and updates" is the documentation fault one layer in, and it
 * reaches the reader at exactly the moment something has gone wrong. Five
 * messages told a customer with no mail server to "connect one under
 * Settings → Connections" — a screen that reports whether mail works and cannot
 * set it, because mail lives in the environment file.
 *
 * Only this repository's own strings, for the same reason as above: a Pro or
 * module screen's label lives elsewhere. A module naming its *own* settings
 * tabs — the newsletter's "Settings → Bounces" — is not this, which is why the
 * sections checked are the Free tier's own headings.
 */
const SOURCES = join(root, "packages", "modules-free");
const WEB = join(root, "apps", "web", "src");

function code(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) code(path, out);
    else if (/\.tsx?$/.test(name) && !name.includes(".test.")) out.push(path);
  }
  return out;
}

test("every screen the product names is a screen the sidebar has", () => {
  const real = realPairs();
  const wrong: string[] = [];
  let seen = 0;
  for (const file of [...code(SOURCES), ...code(WEB)]) {
    const text = readFileSync(file, "utf8");
    for (const [, section, screen] of text.matchAll(
      /\b(Settings|Money|Users|CRM|Invoicing) → ([A-Z][A-Za-z '-]*[A-Za-z])/g,
    )) {
      if (!OURS.has(section as string)) continue;
      seen += 1;
      const pair = `${section} → ${screen}`;
      /*
       * Prose runs on past the name — "Settings → Connections says which
       * account that is" — so a mention counts when the sidebar has any screen
       * whose label the mention starts with.
       */
      const known = [...real].some((r) => pair.startsWith(r));
      if (!known) wrong.push(`${file.slice(root.length + 1)}: ${pair}`);
    }
  }
  expect(seen).toBeGreaterThan(3);
  expect([...new Set(wrong)]).toEqual([]);
});
