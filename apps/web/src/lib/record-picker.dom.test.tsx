import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { danglingAriaRefs } from "./accessible-dom";
import { RecordPicker, useRecordSearch } from "./record-picker";

afterAll(() => GlobalRegistrator.unregister());
afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * More customers than an unpaged list will return.
 *
 * `/api/contacts` is capped at a thousand rows and says `truncated: true` when
 * it has cut. Nothing on any screen read that flag: five pickers fetched the
 * list, filtered it in the browser, and a business with four thousand
 * customers found that some of them — always the same ones, the ones that
 * sort last — were simply not in the dropdown. No message, no count. The
 * conclusion anybody draws is that the customer was never added.
 *
 * The stand-in below is the real route's behaviour: the same cap, the same
 * silence about it, and the same search the route has always supported.
 */
const CAP = 1000;
const everyone = Array.from({ length: 1200 }, (_, i) => ({
  id: `c-${i}`,
  name: `${String(i).padStart(4, "0")} Customer`,
}));
/** The one that sorts last, and therefore the one that used to be missing. */
const last = everyone[everyone.length - 1] as { id: string; name: string };

let asked: string[] = [];

function serve(url: string) {
  asked.push(url);
  const params = new URL(url, "http://localhost").searchParams;
  const q = params.get("q") ?? "";
  const matched = everyone.filter((c) =>
    c.name.toLowerCase().includes(q.toLowerCase()),
  );
  const perPage = Number(params.get("perPage") ?? 0);
  // No paging asked for is the capped, silent answer the screens used to take.
  const rows = perPage ? matched.slice(0, perPage) : matched.slice(0, CAP);
  return {
    contacts: rows,
    total: matched.length,
    ...(perPage ? {} : { truncated: matched.length > CAP }),
  };
}

globalThis.fetch = (async (input: RequestInfo | URL) =>
  new Response(JSON.stringify(serve(String(input))), {
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

function mount(node: React.ReactNode): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const point = document.createElement("div");
  document.body.append(point);
  act(() => {
    createRoot(point).render(
      <QueryClientProvider client={client}>{node}</QueryClientProvider>,
    );
  });
  return point;
}

/** The debounce, then whatever the query does with the answer. */
async function settle() {
  await act(async () => {
    await new Promise((done) => setTimeout(done, 300));
  });
}

/** What the picker does with what somebody has typed, on its own. */
function Search({ term }: { term: string }) {
  const found = useRecordSearch<{ id: string; name: string }>(
    "/api/contacts",
    "contacts",
    term,
    true,
  );
  return (
    <ul>
      {(found.data?.rows ?? []).map((row) => (
        <li key={row.id}>{row.name}</li>
      ))}
    </ul>
  );
}

test("a customer past the thousandth is still reachable", async () => {
  asked = [];
  const host = mount(<Search term="1199" />);
  await settle();

  // Found, though it sorts twelve hundredth: the search happens where the
  // rows are, so the cap on the unpaged list never comes into it.
  expect(host.textContent).toContain(last.name);
  // And never by asking for the table. Every request is a page of a search.
  expect(asked.length).toBeGreaterThan(0);
  for (const url of asked) {
    expect(url).toContain("perPage=20");
  }
  expect(asked.at(-1)).toContain("q=1199");
});

test("the picker offers what it found and says how much it did not", async () => {
  asked = [];
  const picked: { id: string; name: string }[] = [];
  const host = mount(
    <RecordPicker
      path="/api/contacts"
      resource="contacts"
      value={null}
      onChange={(row) => {
        if (row) picked.push(row);
      }}
      noun="customer"
    />,
  );

  const input = host.querySelector("input");
  if (!input) throw new Error("the picker drew no input");
  act(() => {
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  await settle();

  // Twenty of twelve hundred, said in words somebody can act on — not a
  // `truncated` flag nothing reads and a list that simply stops.
  expect(host.textContent).toContain("Showing 20 of 1200");
  expect(host.textContent).toContain("type more of the name");

  const first = everyone[0] as { id: string; name: string };
  const option = [...host.querySelectorAll("button")].find(
    (b) => b.textContent === first.name,
  );
  if (!option) throw new Error("the picker offered nothing to choose");
  act(() => {
    option.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(picked).toEqual([first]);
});

/**
 * The picker points at its results only while it has results.
 *
 * `aria-controls` named the results list whether or not the results list was
 * in the document, and it is rendered only while the picker is open. Every
 * screen carrying a picker therefore sat at rest with an ARIA reference to an
 * id nothing had — `aria-valid-attr-value`, which axe rates critical, and
 * which the browser suite caught on the one screen of several that it happened
 * to open.
 */
test("the picker's aria-controls points at something that exists", async () => {
  const host = mount(
    <RecordPicker
      path="/api/contacts"
      resource="contacts"
      value={null}
      onChange={() => {}}
      noun="customer"
    />,
  );

  const input = host.querySelector("input");
  if (!input) throw new Error("the picker drew no input");

  // Closed: no list, and so nothing claiming to control one.
  expect(danglingAriaRefs(host)).toEqual([]);
  expect(input.hasAttribute("aria-controls")).toBe(false);

  act(() => {
    input.dispatchEvent(new Event("focusin", { bubbles: true }));
  });
  await settle();

  // Open: the reference is back, and it resolves.
  expect(input.getAttribute("aria-controls")).toBeTruthy();
  expect(danglingAriaRefs(host)).toEqual([]);
});
