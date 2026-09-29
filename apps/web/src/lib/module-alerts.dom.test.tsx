import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import {
  BillingWarning,
  DiskWarning,
  ModuleFailures,
  PublicPagesOff,
} from "./module-alerts";

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

/**
 * The fourteen days a failed payment buys are only worth having if somebody
 * hears about them. A business that never opens the licence screen used to
 * learn about a declined card by losing Pro.
 */
test("a failed payment says so, with the day it stops", () => {
  const host = mount(<BillingWarning until="2026-10-14T00:00:00Z" />);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("A payment did not go through");
  expect(alert?.textContent).toContain("Paid features stop on");
  expect(alert?.textContent).toContain(
    new Date("2026-10-14T00:00:00Z").toLocaleDateString(),
  );
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    "/settings-licence",
  );
});

test("a business whose billing is fine sees nothing", () => {
  expect(mount(<BillingWarning until={null} />).innerHTML).toBe("");
  // And a date nobody can read is not a banner saying "Invalid Date".
  expect(mount(<BillingWarning until="not a date" />).innerHTML).toBe("");
});

test("a nearly full disk says so, with somewhere to act", () => {
  const host = mount(<DiskWarning percentUsed={94} />);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("94% full");
  expect(alert?.textContent).toContain("stops accepting writes");
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    "/settings-archive",
  );
});

test("a disk with room, or one nobody could measure, draws nothing", () => {
  expect(mount(<DiskWarning percentUsed={undefined} />).innerHTML).toBe("");
});

test("a second business says what it switched off", () => {
  const host = mount(<PublicPagesOff organizations={2} />);
  const alert = host.querySelector('[role="alert"]');
  expect(alert?.textContent).toContain("holds 2 businesses");
  expect(alert?.textContent).toContain("public pages are switched off");
  expect(host.querySelector("a")?.getAttribute("href")).toBe(
    "mailto:support@sentrello.com",
  );
});

test("one business, or a count nobody could take, draws nothing", () => {
  expect(mount(<PublicPagesOff organizations={1} />).innerHTML).toBe("");
  expect(mount(<PublicPagesOff organizations={undefined} />).innerHTML).toBe(
    "",
  );
});
