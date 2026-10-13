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
import { Money } from "./accounting";

afterAll(() => GlobalRegistrator.unregister());

/**
 * A row recorded against an account the business has since archived.
 *
 * `/api/accounts` leaves archived accounts out unless asked, and the money
 * screen used that list to put a name to every row. So everything filed
 * under a retired category read "—", the way an uncategorised row does. The
 * stand-in answers the way the route does: archived accounts only with
 * `?archived=1`.
 */
const live = {
  id: "acc-live",
  code: "6100",
  name: "Supplies",
  type: "expense",
};
const retired = {
  id: "acc-old",
  code: "6150",
  name: "Old stationery",
  type: "expense",
  archivedAt: "2026-03-01T00:00:00.000Z",
};
const row = {
  id: "t-1",
  kind: "expense",
  accountId: retired.id,
  paidThroughAccountId: null,
  amountCents: 1250,
  occurredAt: "2026-02-10T12:00:00.000Z",
  description: "Envelopes",
  reference: null,
  method: null,
  receiptFileKey: null,
  reversedAt: null,
};

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    let body: unknown = {};
    if (url.pathname === "/api/accounts") {
      body = {
        accounts:
          url.searchParams.get("archived") === "1" ? [live, retired] : [live],
      };
    } else if (url.pathname === "/api/transactions") {
      body = {
        transactions: [row],
        totals: { inCents: 0, outCents: 1250, netCents: -1250 },
      };
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a row filed under an archived account still names it", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <NavigationProvider
          initial={{ moduleId: "accounting", title: "Money" }}
        >
          <Money />
        </NavigationProvider>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });

  const envelopes = [...point.querySelectorAll("tr")].find((tr) =>
    tr.textContent?.includes("Envelopes"),
  );
  expect(envelopes?.textContent).toContain("Old stationery");
  // And it is not offered for new money: the category box lists live
  // accounts only.
  const offered = [...point.querySelectorAll("option")].map(
    (o) => o.textContent,
  );
  expect(offered).toContain("6100 Supplies");
  expect(offered).not.toContain("6150 Old stationery");
});
