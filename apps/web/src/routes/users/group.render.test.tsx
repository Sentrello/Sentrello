import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { NavigationProvider } from "../../lib/navigation";
import { GroupDetail } from "./group";

/**
 * The group record, rendered rather than only reasoned about (Ruling 43).
 *
 * `group.test.ts` covers `grantsForRoles` — the extracted decision — and
 * nothing covered the markup. The branch's finishing review proved the cost
 * by inverting the members empty-state condition, so an empty group listed
 * members and a full one said "Nobody yet", with the whole suite still green.
 * A group's membership is what its access follows from, so a screen that
 * swaps those two is telling an administrator the opposite of who holds it.
 */

function withLocation() {
  (globalThis as { window?: unknown }).window = {
    location: { pathname: "/user-groups/g1", search: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    removeEventListener() {},
  };
}

function render(members: { userId: string; name: string }[]): string {
  withLocation();
  const qc = new QueryClient();
  qc.setQueryData(["user-groups"], {
    groups: [
      {
        id: "g1",
        name: "The office",
        description: "Everybody in the office",
        roles: ["accounting"],
        members,
      },
    ],
  });
  qc.setQueryData(["users", "for-groups"], { people: [] });
  qc.setQueryData(["users-policies"], { roles: [] });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <NavigationProvider
        initial={{
          moduleId: "user-groups",
          recordId: "g1",
          title: "The office",
        }}
      >
        <GroupDetail />
      </NavigationProvider>
    </QueryClientProvider>,
  );
}

test("a group with members lists them, and does not claim to be empty", () => {
  const html = render([
    { userId: "u1", name: "Dana Reyes" },
    { userId: "u2", name: "Pat Buyer" },
  ]);
  expect(html).toContain("Dana Reyes");
  expect(html).toContain("Pat Buyer");
  expect(html).not.toContain("Nobody yet");
});

test("a group nobody is in says so, rather than rendering an empty list", () => {
  // The absence is the answer: a blank panel here reads as a screen that
  // failed to load, which is the state an administrator would act on wrongly.
  const html = render([]);
  expect(html).toContain("Nobody yet");
  expect(html).not.toContain("Dana Reyes");
});
