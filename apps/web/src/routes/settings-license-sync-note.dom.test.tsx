import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { LicenseSyncNote } from "./settings";

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
 * Entering a key only ever asks the host to fetch a token when an update
 * agent is listening — see `POST /api/settings/license` in
 * `packages/modules-free/settings/src/index.ts`. Before this note existed,
 * a business with no agent installed pressed Activate, watched the input
 * clear, and had nothing else on the screen saying why nothing else happened.
 */
test("an agent is present: told to wait, not left guessing", () => {
  const host = mount(<LicenseSyncNote syncing={true} />);
  expect(host.textContent).toContain("Checking your subscription");
});

test("no agent: told the exact command that unblocks them", () => {
  const host = mount(<LicenseSyncNote syncing={false} />);
  expect(host.textContent).toContain("sentrello activate");
  expect(host.textContent).toContain("no update agent");
});
