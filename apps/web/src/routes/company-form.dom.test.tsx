import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Company } from "../lib/api";
import type { CrmSettings } from "../lib/crm-settings";
import { CompanyForm } from "./company-form";

afterAll(() => GlobalRegistrator.unregister());

/**
 * A company can be deleted, and a refusal says why.
 *
 * `DELETE /api/companies/:id` was there, guarded, and refusing a company that
 * people or deals still name — and no screen called it, so a company entered
 * twice sat in the list for good. The refusal is the half worth pinning: a
 * button that swallowed the 409 would look exactly like one that worked.
 */
const REFUSAL =
  "This company has 2 contacts on it. Move or delete those first.";

const asked: { method: string; path: string }[] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  asked.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input).split("?")[0] ?? "";
    const method = init?.method ?? "GET";
    asked.push({ method, path });
    if (method === "DELETE") {
      return new Response(JSON.stringify({ error: REFUSAL }), {
        status: 409,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ managers: [] }), {
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  document.body.innerHTML = "";
});

const company = { id: "co-1", name: "Ellesmere Dental" } as Company;
const settings = {
  customFields: [],
  companySectors: [],
} as unknown as CrmSettings;

function press(label: string) {
  const button = [...document.querySelectorAll("button")].find(
    (b) => b.textContent?.trim() === label,
  );
  if (!button) throw new Error(`no "${label}" button on the screen`);
  button.click();
}

test("a company can be deleted from its form, and a refusal is shown", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  let deleted = false;

  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <CompanyForm
          company={company}
          settings={settings}
          onDone={() => {}}
          onDeleted={() => {
            deleted = true;
          }}
        />
      </QueryClientProvider>,
    );
  });

  await act(async () => press("Delete"));
  await act(async () => press("Delete it"));
  await act(async () => {
    await new Promise((done) => setTimeout(done, 50));
  });

  expect(asked).toContainEqual({
    method: "DELETE",
    path: "/api/companies/co-1",
  });
  // The server's own sentence, not "something went wrong", and the screen
  // stays where it is rather than leaving for a list the company is still in.
  expect(document.body.textContent).toContain(REFUSAL);
  expect(deleted).toBe(false);
});

test("a company being created has nothing to delete", async () => {
  const point = document.createElement("div");
  document.body.append(point);
  const client = new QueryClient();

  await act(async () => {
    createRoot(point).render(
      <QueryClientProvider client={client}>
        <CompanyForm settings={settings} onDone={() => {}} />
      </QueryClientProvider>,
    );
  });

  expect(
    [...point.querySelectorAll("button")].some(
      (b) => b.textContent?.trim() === "Delete",
    ),
  ).toBe(false);
});
