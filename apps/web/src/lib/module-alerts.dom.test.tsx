import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { ModuleFailures } from "./module-alerts";

afterAll(() => GlobalRegistrator.unregister());

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(node: React.ReactNode): HTMLElement {
  const mountPoint = document.createElement("div");
  document.body.append(mountPoint);
  act(() => {
    createRoot(mountPoint).render(node);
  });
  return mountPoint;
}

/**
 * The signal for a paid module that is not running: named, on screen, and
 * marked as an alert rather than furniture. This is the half a person sees;
 * the server side — which failures make the list, and who is sent it — is
 * proved in `apps/server/src/boot.test.ts`.
 */
test("a missing paid module is named on screen", () => {
  const host = mount(<ModuleFailures names={["pro-accounting"]} />);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("pro-accounting");
  // It says where the explanation lives, because the banner itself only has
  // room to say that something somebody pays for is off.
  expect(alert?.textContent).toContain("Licence");
});

test("nothing wrong draws nothing at all", () => {
  const host = mount(<ModuleFailures names={[]} />);
  expect(host.textContent).toBe("");
});
