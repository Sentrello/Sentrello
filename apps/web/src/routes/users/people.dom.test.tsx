import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/users" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NavigationProvider } from "../../lib/navigation";
import { People } from "./people";

afterAll(() => GlobalRegistrator.unregister());

/**
 * What the row menu on the People screen holds, by opening it.
 *
 * The three actions used to be text buttons sitting in the row, so a static
 * render could read them. They are behind a menu now — which is the point,
 * because they wrapped onto two lines at every width — and a closed menu
 * renders none of its items. So this opens it.
 *
 * Worth the file. This is the screen that hands access around: issuing a
 * password, signing somebody out everywhere and removing them from the
 * business are the three most consequential things on it, and a menu that
 * quietly lost one would look exactly like a menu that never had it.
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

function draw(people: unknown[]) {
  const node = document.createElement("div");
  document.body.append(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The same seeded keys `people.render.test.tsx` uses. A key that has fallen
  // behind the screen's renders an empty table, which satisfies every
  // assertion about an absence below.
  client.setQueryData(["users", "staff", "", 1], {
    people,
    total: people.length,
    otherTotal: 0,
    perPage: 50,
    invitations: [],
    history: [],
  });
  client.setQueryData(["users-policies"], {
    roles: [
      { role: "admins", kind: "user" },
      { role: "staff", kind: "user" },
      { role: "sales", kind: "group" },
    ],
  });
  const root = createRoot(node);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NavigationProvider initial={{ moduleId: "users", title: "People" }}>
          <People />
        </NavigationProvider>
      </QueryClientProvider>,
    ),
  );
  return { node, stop: () => act(() => root.unmount()) };
}

test("opening a row's menu offers all three, and one of them is the danger", () => {
  const { node, stop } = draw([PERSON]);
  const trigger = node.querySelector<HTMLButtonElement>(
    '[aria-label="More for Dana Reyes"]',
  );
  expect(trigger).not.toBeNull();
  act(() => trigger?.click());

  const text = document.body.textContent ?? "";
  for (const label of ["Reset password", "Sign out", "Remove"]) {
    expect([label, text.includes(label)]).toEqual([label, true]);
  }
  stop();
});

/** And your own row offers neither signing yourself out nor removing you. */
test("your own row's menu holds only what you may do to yourself", () => {
  const { node, stop } = draw([{ ...PERSON, you: true }]);
  const trigger = node.querySelector<HTMLButtonElement>(
    '[aria-label="More for Dana Reyes"]',
  );
  act(() => trigger?.click());

  const text = document.body.textContent ?? "";
  expect(text).toContain("Reset password");
  expect(text).not.toContain("Sign out");
  expect(text).not.toContain("Remove");
  stop();
});
