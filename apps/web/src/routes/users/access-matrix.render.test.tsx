import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessMatrix } from "./access-matrix";

/**
 * The Access tab, actually rendered.
 *
 * Everything else about Phase 3 is tested by pulling the decision out of the
 * component and exercising it on its own (Ruling 39), which is right and is
 * not enough by itself: a rule can be correct while the markup around it
 * never draws, and until this file existed nothing in the repository had seen
 * a screen of this console render at all. The browser check the plan asks for
 * could not be run — the Chrome extension is not connected here — so this is
 * what stands in for it.
 *
 * `react-dom/server` rather than a DOM testing library: it is already a
 * dependency of this app, it needs no jsdom and no renderer to install, and
 * for a component whose whole job is turning props into markup it answers the
 * question. What it does not answer is what the markup *looks* like — colour,
 * spacing and layout still need eyes. This catches the component crashing,
 * the wrong text, and an absence rendering as nothing.
 */

const grants = [
  {
    resource: "crm",
    action: "read",
    sources: [
      { kind: "policy" as const, name: "staff" },
      { kind: "group" as const, name: "Accounting" },
    ],
  },
  {
    resource: "invoicing",
    action: "send",
    sources: [{ kind: "group" as const, name: "Accounting" }],
  },
];

test("a granted action is drawn with every source that carries it", () => {
  const html = renderToStaticMarkup(<AccessMatrix grants={grants} />);

  expect(html).toContain("crm");
  expect(html).toContain("read");
  // Both routes to the same grant, which is the whole point of the tab: an
  // administrator who cannot see the second source removes the wrong one.
  expect(html).toContain("policy &quot;staff&quot;");
  expect(html).toContain("group &quot;Accounting&quot;");
});

test("a resource nobody granted says so, rather than being left off the screen", () => {
  const html = renderToStaticMarkup(<AccessMatrix grants={grants} />);

  // `settings` is in RESOURCES and is granted by neither fixture above, so
  // the screen has to say "no" where it would otherwise say nothing at all —
  // the absence is the answer to "why can't they do X".
  expect(html).toContain("settings");
  expect(html).toContain("not granted");
});

test("no grants at all still draws the whole list", () => {
  // The state a brand-new member is in. A blank panel here reads as a broken
  // screen; a full list of "not granted" reads as the truth.
  const html = renderToStaticMarkup(<AccessMatrix grants={[]} />);

  expect(html).toContain("not granted");
  expect(html).toContain("crm");
  expect(html).not.toContain("policy &quot;");
});
