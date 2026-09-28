import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PageActions, PageSubtitle } from "./page-header";

afterAll(() => GlobalRegistrator.unregister());

// Each test's slots are unused DOM left over from the last: getElementById
// returns the first match in document order, so a prior test's empty
// #page-actions or #page-subtitle would otherwise catch the next test's
// portal before its own slot — or, for a test that expects no slot at all,
// before it ever gets to ask.
afterEach(() => {
  document.body.innerHTML = "";
});

/**
 * A screen's primary action belongs on the title line, in the same place on
 * every screen.
 *
 * It stays inside the screen's own tree and is drawn into the header through a
 * portal, rather than handed to the shell as a stored node: a stored node is
 * captured once and goes stale the moment the screen re-renders, which for a
 * button means a handler closing over last render's state.
 */
function mount(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML =
    '<div id="page-actions"></div><div id="page-subtitle"></div>';
  document.body.append(host);
  const mountPoint = document.createElement("div");
  host.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(node);
  });
  return host;
}

test("an action rendered by a screen lands in the shell's header slot", () => {
  const host = mount(
    <PageActions>
      <button type="button">New order</button>
    </PageActions>,
  );
  expect(host.querySelector("#page-actions")?.textContent).toBe("New order");
});

test("a subtitle lands in the header, not in the screen", () => {
  const host = mount(<PageSubtitle>12 unpaid</PageSubtitle>);
  expect(host.querySelector("#page-subtitle")?.textContent).toBe("12 unpaid");
});

/**
 * A screen rendered with no shell around it — a test, or a screen mounted
 * somewhere unusual — draws nothing rather than throwing.
 */
test("no header slot means nothing drawn, not an exception", () => {
  // The precondition the test's name claims: no slot in the document at all,
  // not merely one this test didn't put there itself.
  expect(document.getElementById("page-actions")).toBeNull();
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(<PageActions>x</PageActions>);
  });
  expect(mountPoint.textContent).toBe("");
});
