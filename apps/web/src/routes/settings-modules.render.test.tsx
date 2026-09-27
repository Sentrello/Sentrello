import { expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { Modules } from "./settings";

/**
 * The difference between "you own nothing" and "I could not ask".
 *
 * `/api/_meta` is where this screen learns what the licence includes, and it
 * read the answer as `meta.data?.modules ?? []` — so a call that failed came
 * out as an empty list and the screen said, in as many words, that the
 * licence includes no modules yet. That is a statement, and on a Pro
 * instance it is a false one, told to somebody who has very likely opened
 * this screen *because* a module they paid for is missing.
 */
function renderWith(seed: (qc: QueryClient) => void): string {
  // `retryOnMount: false` and an infinite stale time, or the observer starts
  // its own fetch the moment it mounts and the seeded state reads as loading.
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        retryOnMount: false,
        staleTime: Number.POSITIVE_INFINITY,
      },
    },
  });
  seed(qc);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Modules />
    </QueryClientProvider>,
  );
}

test("a licence with no modules says so", () => {
  const html = renderWith((qc) => qc.setQueryData(["meta"], { modules: [] }));
  expect(html).toContain("no modules yet");
});

test("a call that failed does not say the licence includes nothing", () => {
  const html = renderWith((qc) => {
    qc.getQueryCache()
      .build(qc, { queryKey: ["meta"] })
      .setState({
        status: "error",
        error: new Error("something went wrong"),
        fetchStatus: "idle",
      });
  });
  expect(html).not.toContain("no modules yet");
  expect(html).toContain("Try again");
});
