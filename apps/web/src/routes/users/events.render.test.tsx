import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Events } from "./events";

/**
 * The Events screen, actually rendered (Ruling 43). The state worth getting
 * wrong here is the empty result — a filter that matches nothing has to say
 * so, not draw a blank table — and that a row's human sentence and its
 * subject both actually reach the markup.
 *
 * `Events` fetches three things with `useQuery` (people, groups, and the
 * events page itself), so the cache is seeded for all three ahead of the
 * render, the same technique `policies.render.test.tsx` uses for one. The
 * events key includes the filter object the component's own `useState`
 * starts with — the empty filter, page 1 — since that is what the first
 * render actually asks for.
 */

const EMPTY_FILTER = {
  actor: "",
  subject: "",
  action: "",
  from: "",
  to: "",
  page: 1,
};

function renderWith(events: unknown[], total: number): string {
  const qc = new QueryClient();
  qc.setQueryData(["users", "for-events"], {
    people: [{ userId: "u1", name: "Dana Reyes", email: "dana@example.test" }],
  });
  qc.setQueryData(["user-groups"], {
    groups: [{ id: "g1", name: "The office" }],
  });
  qc.setQueryData(["users-events", EMPTY_FILTER], {
    events,
    total,
    perPage: 25,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Events />
    </QueryClientProvider>,
  );
}

test("a matching event shows who did what, and to whom", () => {
  const html = renderWith(
    [
      {
        id: "e1",
        at: "2026-08-01T00:00:00.000Z",
        actorId: "u1",
        actor: "Dana Reyes",
        subjectId: "u2",
        subject: "Sam Patel",
        action: "role.changed",
        says: "changed the role of",
      },
    ],
    1,
  );
  expect(html).toContain("Dana Reyes");
  expect(html).toContain("changed the role of");
  expect(html).toContain("Sam Patel");
  expect(html).toContain("1 event");
});

test("no events matching the filter says so, rather than an empty table", () => {
  const html = renderWith([], 0);
  expect(html).toContain("Nothing recorded");
  expect(html).toContain("matches this filter");
});

test("the actor and subject pickers are built from real people and groups", () => {
  const html = renderWith([], 0);
  expect(html).toContain("Dana Reyes");
  expect(html).toContain("The office");
});
