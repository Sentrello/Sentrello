import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { FindButton } from "./find";

afterAll(() => GlobalRegistrator.unregister());

/**
 * The one control that has to be visible on every screen in both themes.
 *
 * It was drawn as `opacity: 0.75` over a transparent background: fine on
 * white, close to invisible in the dark, where the panel behind it is already
 * dim and a faint border on a dim ground is an outline nobody can find. It
 * was also the smallest thing in the header — smaller than the avatar — while
 * being how somebody reaches one invoice out of four thousand.
 *
 * Opacity is the part worth guarding. `theme-contrast.test.ts` measures pairs
 * of declared tokens and cannot see a multiplier, so a control dimmed this
 * way passes every check the product has while failing the only one that
 * matters, which is whether you can see it.
 */
function draw() {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() =>
    root.render(
      <QueryClientProvider client={client}>
        <FindButton />
      </QueryClientProvider>,
    ),
  );
  const button = node.querySelector("button");
  if (!button) throw new Error("the find button did not render");
  return { button, stop: () => act(() => root.unmount()) };
}

test("it is drawn on a surface of its own, not dimmed onto the header", () => {
  const { button, stop } = draw();
  const style = button.getAttribute("style") ?? "";
  expect(style).toContain("--surface-sunken");
  expect(style).toContain("--text");
  // The failure mode itself. Nothing here may be faded, because a faded
  // control is invisible in the dark and invisible to the contrast test.
  expect(style).not.toContain("opacity");
  stop();
});

/**
 * And big enough to be a target and to read as the field it opens. 36px is
 * comfortably past WCAG 2.2's 24px minimum, and the same height as the other
 * controls in the header.
 */
test("it is a control somebody can hit, at every width", () => {
  const { button, stop } = draw();
  const classes = button.className;
  expect(classes).toContain("h-9");
  // Square on a phone, a field from `sm` up — never hidden, which is what it
  // used to be at phone width.
  expect(classes).toContain("w-9");
  expect(classes).toContain("sm:flex-1");
  expect(classes).not.toContain("hidden");
  stop();
});
