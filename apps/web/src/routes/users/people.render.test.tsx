import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider } from "../../lib/navigation";
import { People } from "./people";

/**
 * The People screen, rendered rather than only reasoned about.
 *
 * It is the main screen of the Users console — the one that hands access
 * around — and at 488 lines it had no render test at all. Replacing every
 * `window.confirm` on it with a real dialog broke nothing, which sounds
 * reassuring and was not: nothing was watching.
 *
 * The state worth getting wrong here is what a policy is *called*. Policies are
 * stored lowercase (`staff`, `customer service`) and read title-cased
 * everywhere else in the console. This screen showed the stored form in three
 * places — the invite picker, every row's picker, and the line describing what
 * a group adds — so the one screen an administrator spends their time on was
 * the one disagreeing with the rest.
 */

const PERSON = {
  userId: "u1",
  memberId: "m1",
  name: "Dana Reyes",
  email: "dana@example.test",
  role: "staff,sales",
  baseRole: "staff",
  groups: ["Sales"],
  twoFactorEnabled: false,
  twoFactorRequired: false,
  lastSeenAt: null,
  you: false,
};

/**
 * `renderToStaticMarkup` needs no DOM, but `NavigationProvider` reads
 * `window.location` for the view it starts on. Two strings, stubbed here
 * rather than pulling in jsdom for them — the same shape `person.render.test`
 * uses.
 */
function renderWith(
  people: unknown[],
  extra: Record<string, unknown> = {},
): string {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/users", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
  const qc = new QueryClient();
  // The key carries the audience: staff and customers are two lists, and a
  // seeded key that has fallen behind the screen's renders an empty table,
  // which passes anything asserting an absence.
  qc.setQueryData(["users", "staff", "", 1], {
    people,
    total: people.length,
    otherTotal: 0,
    perPage: 50,
    invitations: [],
    history: [],
    ...extra,
  });
  qc.setQueryData(["users-policies"], {
    roles: [
      { role: "admins", kind: "user" },
      { role: "staff", kind: "user" },
      { role: "customer service", kind: "user" },
      { role: "sales", kind: "group" },
    ],
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NavigationProvider initial={{ moduleId: "users", title: "People" }}>
        <People />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

test("a policy is named the way the rest of the console names it", () => {
  const html = renderWith([PERSON]);

  expect(html).toContain("Dana Reyes");
  // Title-cased for reading, including the two-word one.
  expect(html).toContain("Staff");
  expect(html).toContain("Customer Service");
  // The stored form is still the value, because that is what the route wants.
  expect(html).toContain('value="staff"');
});

test("what a group adds is named the same way", () => {
  const html = renderWith([PERSON]);
  // `role` carries everything they hold; the line lists what the group adds on
  // top of their own policy, and used to print the stored form.
  expect(html).toContain("Sales");
  expect(html).not.toContain("nothing extra");
});

/**
 * A group that grants nothing beyond what the person already has.
 *
 * Worth its own case because the empty result is a string rather than an empty
 * list, and a change that dropped it would leave a sentence ending in a colon.
 */
test("a group granting nothing extra says so", () => {
  const html = renderWith([{ ...PERSON, role: "staff", groups: ["Sales"] }]);
  expect(html).toContain("nothing extra");
});

/**
 * Destructive actions ask first, and say what will happen.
 *
 * The dialog is closed on first render, so what this proves is the button that
 * opens it — the browser's own `confirm` left no button of its own, and a
 * regression back to it would leave the row with an onClick and nothing here
 * to find.
 */
test("every destructive action on a row is offered, and none of them is the browser's dialog", () => {
  const html = renderWith([PERSON]);

  for (const label of ["Reset password", "Sign out", "Remove"]) {
    expect(html).toContain(label);
  }
  // The dialog renders nothing until it is opened, so its copy must not be in
  // the markup — if it is, it is on screen when nobody asked for it.
  expect(html).not.toContain("Remove them from the business?");
});

/** You cannot change your own policy, and the screen does not offer to. */
test("your own row offers no policy picker and no way to remove yourself", () => {
  const html = renderWith([{ ...PERSON, you: true }]);

  expect(html).toContain("you");
  // The table must actually have drawn: an empty one satisfies every
  // assertion below by having nothing in it.
  expect(html).toContain("Dana Reyes");
  // One select on the page would be the invite picker; a second would be this
  // row's, which must not exist.
  expect(html.match(/<select/g)?.length ?? 0).toBe(1);
  expect(html).not.toContain("Remove");
});

/**
 * A change nobody was signed in for still names who did it.
 *
 * `sentrello reset-password`, `sentrello unlock` and the scheduled prune all
 * record with no actor, and the line came out as "issued a new password for
 * Owner" — a sentence with no subject. Sign-in attempts, where an absent actor
 * would instead mean an unknown person, are excluded from this list, so naming
 * the server here is accurate rather than a guess.
 *
 * Found by looking at the screen. Nothing here could have caught it before,
 * because nothing here rendered the history at all.
 */
test("a change made on the server says so, rather than starting mid-sentence", () => {
  const html = renderWith([PERSON], {
    history: [
      {
        at: "2026-09-12T10:00:00.000Z",
        actor: null,
        subject: "Owner",
        says: "issued a new password for",
        detail: null,
      },
      {
        at: "2026-09-11T10:00:00.000Z",
        actor: "Owner",
        subject: "Dana Reyes",
        says: "unlocked the account of",
        detail: null,
      },
    ],
  });

  expect(html).toContain("The server</strong> issued a new password for");
  // And a real person is still named as themselves.
  expect(html).toContain("Owner</strong> unlocked the account of");
});

/** The console calls them policies; this table called them roles. */
test("the column is the word the rest of the console uses", () => {
  const html = renderWith([PERSON]);
  expect(html).toContain("Policy");
  expect(html).not.toContain(">Role<");
});

/**
 * The two lists, and the switch between them.
 *
 * A shop's customers are members of the organization, so they were in the list
 * of people who work here — a curiosity at twenty-five people and the whole
 * screen at five hundred.
 */
test("the staff list offers the customers list, with its count", () => {
  const html = renderWith([PERSON], { otherTotal: 412 });

  expect(html).toContain("People who work here");
  expect(html).toContain("Customers (412)");
  // Inviting is for people who work here; a customer account is made by the
  // customer, in the shop.
  expect(html).toContain("Invite somebody");
});
