import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useColumns, useListQuery, useListState } from "./list-ui";

afterAll(() => GlobalRegistrator.unregister());

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/**
 * A screen whose every call fails has to say so, including the call that asks
 * which columns somebody wants.
 *
 * The shape under test is one real screen's, and the reason this file exists is
 * that the screen shipped broken: the release walk fails every API call a page
 * makes and checks that the page says something went wrong rather than spinning.
 * A list that had just gained column choice spun — the only change to it was
 * `useColumns`, which is here rather than there because it is Core's hook and
 * this is where it can be rendered in a DOM at all.
 */
function Screen() {
  const state = useListState({ sort: "createdAt", order: "desc" });
  const { rows, isLoading, error } = useListQuery<{ id: string }>(
    "shop/stock-moves",
    state,
  );
  const columns = useColumns("probe-broken", [
    { field: "when", label: "When", fixed: true },
    { field: "note", label: "Note" },
  ]);

  return (
    <main>
      {isLoading ? (
        <p>Loading…</p>
      ) : error ? (
        <p>something went wrong</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>When</th>
              {columns.shown("note") ? <th>Note</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.id}</td>
                {columns.shown("note") ? <td /> : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}

/** Every call fails, the way the release walk breaks a screen. */
function everythingFails() {
  const asked: string[] = [];
  const failing = (input: RequestInfo | URL) => {
    asked.push(String(input));
    return Promise.resolve(
      new Response(JSON.stringify({ error: "something went wrong" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  // `preconnect` is on the real `fetch` and nothing here calls it; assigning a
  // bare function would not typecheck, and inventing one would be a lie about
  // what this stub does.
  globalThis.fetch = Object.assign(failing, {
    preconnect: globalThis.fetch.preconnect,
  }) as typeof globalThis.fetch;
  return asked;
}

const settle = async (ms: number) => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
};

test("a list with column choice says what went wrong rather than spinning", async () => {
  const asked = everythingFails();
  // `retry: 1` is what the application itself uses, and the walk's two-second
  // wait is written against it: the one retry fires at about a second.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 1 } },
  });

  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Screen />
      </QueryClientProvider>,
    );
  });

  // Longer than the walk waits, so a pass here is not a pass by a hair.
  await settle(2_500);

  const text = host.textContent ?? "";
  expect(asked.some((url) => url.includes("/api/profile/columns"))).toBe(true);
  expect(
    text,
    `the screen still said "Loading…" after every call had failed and the retries had run`,
  ).not.toContain("Loading");
  expect(text).toContain("something went wrong");

  client.clear();
});
