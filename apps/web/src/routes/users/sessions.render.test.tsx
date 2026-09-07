import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Sessions } from "./sessions";

/**
 * The org-wide Sessions screen, rendered rather than only reasoned about
 * (Ruling 43). The state worth getting wrong here is the IP column: this is
 * the exact bug the browser check found — `person.tsx`'s own Sessions tab
 * showed a blank cell for a live session because Better Auth writes an empty
 * string, not null, when nothing set the trusted header, and `s.ipAddress ??
 * "—"` never catches an empty string. This screen uses `||` instead, and this
 * test is what proves it — `??` would pass this test with a blank cell and
 * nothing here would notice unless it looks at the actual markup.
 */

function renderWith(sessions: unknown[]): string {
  const qc = new QueryClient();
  qc.setQueryData(["users-sessions"], { sessions });
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Sessions />
    </QueryClientProvider>,
  );
}

test("a session with no resolved address shows the placeholder, not a blank cell", () => {
  const html = renderWith([
    {
      id: "s1",
      userId: "u1",
      name: "Dana Reyes",
      email: "dana@example.test",
      device: "a Mac, in Safari",
      ipAddress: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      current: false,
    },
  ]);
  expect(html).toContain("Dana Reyes");
  expect(html).toContain("a Mac, in Safari");
  // The placeholder must actually be there — an empty string rendered raw
  // would leave no "—" for this test to find.
  expect(html).toContain("—");
});

test("a session with a resolved address shows it", () => {
  const html = renderWith([
    {
      id: "s1",
      userId: "u1",
      name: "Dana Reyes",
      email: "dana@example.test",
      device: "a Windows PC, in Chrome",
      ipAddress: "203.0.113.7",
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      current: true,
    },
  ]);
  expect(html).toContain("203.0.113.7");
  expect(html).toContain("this device");
});

test("nobody signed in says so, rather than an empty table", () => {
  const html = renderWith([]);
  expect(html).toContain("Nobody is signed in");
});
