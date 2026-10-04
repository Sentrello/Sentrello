import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real origin, unlike the default `about:blank`: this file asserts on
// `window.location.pathname`, which only means anything under one.
GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { filterIntent, monthRange } from "./drill";
import { useArrivingFilters, useListState } from "./list-ui";
import { installRuntime } from "./module-ui";
import { NavigationProvider, useNavigation } from "./navigation";

afterAll(() => GlobalRegistrator.unregister());

afterEach(() => {
  document.body.innerHTML = "";
  // The runtime is a window global and `open` on it is replaced as a provider
  // mounts; left in place it would hand the next test the previous test's
  // navigation, closed over an unmounted tree.
  window.__sentrello = undefined;
  // And the address bar follows every navigation, so it is put back too.
  window.history.replaceState({}, "", "/");
});

/** What the navigation says is on screen, readable from outside the tree. */
function Probe() {
  const { current } = useNavigation();
  return (
    <span id="probe">
      {current.moduleId}:{current.recordId ?? "-"}:{current.title}
    </span>
  );
}

/**
 * A module's screen calls `window.__sentrello.open` and lands in the
 * application's own navigation — the same door Core's screens use.
 *
 * This is the behavioural half of the contract the runtime declares: the
 * bundle only ever sees the window global, so if `NavigationProvider` stopped
 * publishing its `open` there, every cross-record link in every paid module
 * would quietly degrade to a full page load — or, worse, to the stale `open`
 * of a provider that no longer exists. Nothing at compile time can catch
 * that; this mounts the real provider and watches the call arrive.
 */
test("window.__sentrello.open navigates through the mounted provider", () => {
  const assigned: string[] = [];
  window.location.assign = (url: string | URL) => {
    assigned.push(String(url));
  };

  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(
      <NavigationProvider
        initial={{ moduleId: "dashboard", title: "Dashboard" }}
        known={[{ id: "crm", label: "CRM" }]}
      >
        <Probe />
      </NavigationProvider>,
    );
  });

  const runtime = window.__sentrello;
  expect(runtime).toBeDefined();
  act(() => {
    runtime?.open({ moduleId: "crm", recordId: "42", title: "Ada" });
  });

  // The provider handled it: the tree re-rendered onto the new view and the
  // address bar followed — with no full page load anywhere.
  expect(document.getElementById("probe")?.textContent).toBe("crm:42:Ada");
  expect(window.location.pathname).toBe("/crm/42");
  expect(assigned).toEqual([]);
});

/**
 * Before any provider mounts — or on a host too old to publish one — the
 * runtime's own `open` still gets somebody where they asked to go, the slow
 * way. A bundle built against a newer SDK than its host must degrade to a
 * page load, never to a dead button.
 */
test("without a provider, open falls back to a full page load", () => {
  const assigned: string[] = [];
  window.location.assign = (url: string | URL) => {
    assigned.push(String(url));
  };

  const runtime = installRuntime();
  runtime.open({ moduleId: "shop", recordId: "a b", title: "Order" });
  expect(assigned).toEqual(["/shop/a%20b"]);

  runtime.open({ moduleId: "shop", title: "Shop" });
  expect(assigned[1]).toBe("/shop");
});

/**
 * The other end of a drill-through: a chart presses, and the list arrives
 * narrowed.
 *
 * Three pieces have to meet for that, and each is fine on its own while the
 * chain is broken — the intent has to travel on the view, the provider has to
 * put it in the slot a screen reads, and the list has to apply it. So this
 * drives all three: the module door (`window.__sentrello.open`, which is the
 * one a module's chart has), and the state a real `useListState` ends up in.
 */
function ArrivingList() {
  const state = useListState({ sort: "issueDate", order: "desc" });
  useArrivingFilters(state);
  return (
    <span id="filters">
      {Object.entries(state.filters)
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join("&") || "none"}
    </span>
  );
}

test("a filter intent reaches the list and becomes its filters", () => {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(
      <NavigationProvider
        initial={{ moduleId: "dashboard", title: "Dashboard" }}
        known={[{ id: "invoicing", label: "Invoices" }]}
      >
        <ArrivingList />
      </NavigationProvider>,
    );
  });

  // Nothing pressed yet: the list is the whole list.
  expect(document.querySelector("#filters")?.textContent).toBe("none");

  const runtime = window.__sentrello;
  act(() => {
    runtime?.open?.({
      moduleId: "invoicing",
      title: "Invoices",
      intent: filterIntent(monthRange("2026-09")),
    });
  });

  expect(document.querySelector("#filters")?.textContent).toBe(
    "from=2026-09-01&to=2026-09-30",
  );
});
