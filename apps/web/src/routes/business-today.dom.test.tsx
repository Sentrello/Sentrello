import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import {
  afterAll,
  afterEach,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { NavigationProvider } from "../lib/navigation";
import { businessToday, setFormats } from "../lib/ui";
import { Summary } from "./accounting";

afterAll(() => GlobalRegistrator.unregister());

/**
 * A date box opens on the business's today, not the UTC one.
 *
 * Nine in the evening on New Year's Eve in New York is two in the morning on
 * 1 January in UTC. The reports opened on "1 January to 1 January" of a year
 * the business had not started — an empty profit and loss on the one evening
 * somebody looks at the whole of the year just gone.
 */
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async () =>
    new Response("{}", {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
  setSystemTime(new Date("2027-01-01T02:00:00Z"));
  setFormats({ businessTimezone: "America/New_York" });
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
  setFormats({ businessTimezone: "" });
});

test("businessToday is the business's day, and moves on the calendar", () => {
  expect(businessToday()).toBe("2026-12-31");
  expect(businessToday({ days: 30 })).toBe("2027-01-30");
  expect(businessToday({ months: -12 })).toBe("2025-12-31");
  expect(businessToday({ months: -1 })).toBe("2026-11-30");
  // No zone on the business is UTC, never the reader's clock.
  setFormats({ businessTimezone: "" });
  expect(businessToday()).toBe("2027-01-01");
});

test("the reports open on the business's year and day", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <NavigationProvider
          initial={{ moduleId: "accounting", title: "Reports" }}
        >
          <Summary />
        </NavigationProvider>
      </QueryClientProvider>,
    );
  });

  const days = [...point.querySelectorAll('input[type="date"]')].map(
    (i) => (i as HTMLInputElement).value,
  );
  expect(days).toEqual(["2026-01-01", "2026-12-31"]);
});
