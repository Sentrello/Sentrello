import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { TaskDialog } from "./tasks";
import { type } from "./typing";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * A task about the customer who sorts last, added from the CRM dashboard.
 *
 * The dashboard's dialog offered a `<select>` filled from the first two
 * hundred contacts by name. At a business with three hundred, Zoe could
 * never be the subject of a task added there. The stand-in pages and
 * searches the way `/api/contacts` does.
 */
const everyone = Array.from({ length: 300 }, (_, i) => ({
  id: `c-${i}`,
  name: `${String(i).padStart(3, "0")} Customer`,
}));
const last = everyone[everyone.length - 1] as { id: string; name: string };

const posted: Record<string, unknown>[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  posted.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    let body: unknown = {};
    if (url.pathname === "/api/tasks" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)));
      body = { task: { id: "t-1" } };
    } else if (url.pathname === "/api/contacts") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const perPage = Math.min(200, Number(url.searchParams.get("perPage")));
      const matched = everyone.filter((c) => c.name.toLowerCase().includes(q));
      body = { contacts: matched.slice(0, perPage), total: matched.length };
    } else if (url.pathname === "/api/crm/managers") {
      body = { managers: [] };
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
}

test("a task from the dashboard can be about the three-hundredth contact", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const point = document.createElement("div");
  document.body.append(point);
  act(() => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <TaskDialog open onClose={() => {}} invalidate={[]} chooseContact />
      </QueryClientProvider>,
    );
  });
  await settle();

  const search = document.querySelector<HTMLInputElement>(
    'input[type="search"]',
  );
  if (!search) throw new Error("the dialog offered no contact search");
  act(() => {
    search.dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  type(search, "299");
  await settle();
  await settle();
  const option = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === last.name,
  );
  if (!option) throw new Error("the search did not offer the last contact");
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  const title = document.querySelector<HTMLInputElement>(
    'input[placeholder="Call about the lease renewal"]',
  );
  if (!title) throw new Error("the dialog drew no description box");
  type(title, "Ring Zoe back");
  const save = [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Save",
  );
  if (!save) throw new Error("the dialog drew no Save");
  act(() => {
    save.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();

  expect(posted).toHaveLength(1);
  expect(posted[0]?.contactId).toBe(last.id);
  expect(posted[0]?.title).toBe("Ring Zoe back");
});
