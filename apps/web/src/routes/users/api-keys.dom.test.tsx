import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/user-api-keys" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { setGrants } from "../../lib/api";
import { NavigationProvider } from "../../lib/navigation";
import { ApiKeys } from "./api-keys";

afterAll(() => GlobalRegistrator.unregister());

/**
 * A key's grid offers only what its maker holds.
 *
 * The server has always refused a key wider than the person making it, and
 * says which permission it was. The screen offered every box anyway, so
 * somebody holding the Users console and the CRM could tick the till, press
 * Make the key, and be told no. The refusal is the server's; saying it before
 * the press is the screen's.
 */
const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (!url.startsWith("/api/users/api-keys")) {
      throw new Error(`the keys screen asked for ${url}, which nothing serves`);
    }
    return new Response(JSON.stringify({ keys: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setGrants(undefined);
});

function draw() {
  const node = document.createElement("div");
  document.body.append(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(["user-api-keys"], { keys: [] });
  const root = createRoot(node);
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <NavigationProvider initial={{ moduleId: "users", title: "API keys" }}>
          <ApiKeys />
        </NavigationProvider>
      </QueryClientProvider>,
    ),
  );
  return { node, stop: () => act(() => root.unmount()) };
}

const box = (node: HTMLElement, label: string) =>
  node.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);

test("a box the maker does not hold is off, and says why", () => {
  setGrants(
    { dashboard: ["read"], settings: ["read", "update"], crm: ["read"] },
    ["dashboard", "settings", "crm", "pos"],
  );
  const { node, stop } = draw();

  const held = box(node, "read on crm");
  expect(held).not.toBeNull();
  expect(held?.disabled).toBe(false);

  for (const label of ["update on crm", "read on pos"]) {
    const refused = box(node, label);
    expect(refused).not.toBeNull();
    expect(refused?.disabled).toBe(true);
    expect(refused?.title).toContain("a key you make cannot either");
  }
  stop();
});

test("somebody who holds it all may tick it all", () => {
  setGrants({}, []);
  const { node, stop } = draw();
  expect(box(node, "read on pos")?.disabled).toBe(false);
  stop();
});
