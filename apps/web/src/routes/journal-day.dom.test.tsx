import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NavigationProvider } from "../lib/navigation";
import { Journal } from "./accounting";

afterAll(() => GlobalRegistrator.unregister());

/**
 * The journal shows the day an entry belongs to, as the server names it.
 *
 * It formatted `postedAt`, the instant, in whatever zone the browser was in.
 * An entry the business closed at ten at night in New York is stamped two in
 * the morning UTC, and the reports file it under the day it was closed; the
 * journal beside them put it on the next one, or the one before, depending on
 * who was looking. The server sends `postedOn`, and that is what is drawn.
 */
const line = {
  id: "entry-1",
  memo: "Late till close",
  source: "pos:close",
  // Noon UTC, so the instant reads as 1 June in any zone this test runs in;
  // only the server's day can put it on the 31st.
  postedAt: "2026-06-01T12:00:00.000Z",
  postedOn: "2026-05-31",
  postedBy: null,
  debitCents: 1000,
  creditCents: 0,
  accountCode: "1000",
  accountName: "Cash",
};
const answers: Record<string, unknown> = {
  "/api/journal": { lines: [line], mayPost: false, total: 1 },
  "/api/accounts": { accounts: [] },
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    new Response(
      JSON.stringify(answers[String(input).split("?")[0] ?? ""] ?? {}),
      { headers: { "content-type": "application/json" } },
    )) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("an entry is dated by its day, not by the instant it was stamped", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <NavigationProvider
          initial={{ moduleId: "accounting", title: "Journal" }}
        >
          <Journal />
        </NavigationProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });

  expect(point.textContent).toContain("Late till close");
  expect(point.textContent).toContain("May 31, 2026");
  expect(point.textContent).not.toContain("Jun 1, 2026");
});
