import { expect, test } from "bun:test";
import { type View, trailAfterOpening } from "./navigation";

/**
 * The trail is what lets a screen offer the way back, so its bookkeeping is
 * worth checking directly.
 *
 * This file used to hold its own copy of the rule, under a comment saying it
 * mirrored `NavigationProvider.open`. A test shaped that way cannot fail when
 * the component breaks, which is the only thing a test is for — it checks that
 * a copy of the code agrees with itself. `trailAfterOpening` is now exported
 * from `navigation.tsx` and is what `open` actually calls, so these exercise
 * the real rule and there is nothing left to drift.
 *
 * Still a reducer rather than a rendered component: the rules are the thing
 * that matters here, and the component around them is three `useState` calls.
 */

const contact: View = {
  moduleId: "crm",
  recordId: "c1",
  title: "Acme Ltd",
};
const deal: View = {
  moduleId: "deals",
  recordId: "d1",
  title: "Roof repair",
};
const invoice: View = {
  moduleId: "invoicing",
  recordId: "i1",
  title: "INV-004",
};

/** What the provider does: the trail advances, and `current` becomes `next`. */
function open(
  trail: View[],
  current: View,
  next: View,
): { trail: View[]; current: View } {
  return { trail: trailAfterOpening(trail, current, next), current: next };
}

test("following a chain remembers how you got there", () => {
  let s = {
    trail: [] as View[],
    current: { moduleId: "crm", title: "Contacts" },
  };
  s = open(s.trail, s.current, contact);
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, invoice);

  expect(s.current.title).toBe("INV-004");
  expect(s.trail.map((v) => v.title)).toEqual([
    "Contacts",
    "Acme Ltd",
    "Roof repair",
  ]);
});

/**
 * A contact leads to a deal which links back to the same contact. Treating that
 * as going deeper would grow the trail for ever and make the breadcrumb claim a
 * journey nobody took.
 */
test("going back to something already behind you shortens the trail", () => {
  let s = {
    trail: [] as View[],
    current: { moduleId: "crm", title: "Contacts" },
  };
  s = open(s.trail, s.current, contact);
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, contact);

  expect(s.current.title).toBe("Acme Ltd");
  expect(s.trail.map((v) => v.title)).toEqual(["Contacts"]);
});

test("two records in the same module are different places", () => {
  // Same moduleId, different record — going from one deal to another is
  // forward, not back.
  const other: View = {
    moduleId: "deals",
    recordId: "d2",
    title: "Gutter clean",
  };
  let s = {
    trail: [] as View[],
    current: { moduleId: "deals", title: "Deals" },
  };
  s = open(s.trail, s.current, deal);
  s = open(s.trail, s.current, other);

  expect(s.trail.map((v) => v.title)).toEqual(["Deals", "Roof repair"]);
});

test("a module opened without a record is not the same place as one of its records", () => {
  // `/deals` and `/deals/d1` share a moduleId and differ in `recordId`, one of
  // them undefined. The list is a place you can be behind a record.
  const list: View = { moduleId: "deals", title: "Deals" };
  const trail = trailAfterOpening([list], deal, list);

  // Going back to the list from a deal finds the list already behind you and
  // shortens to it, rather than stacking a second copy.
  expect(trail).toEqual([]);
});
