import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "./ui";

afterAll(() => GlobalRegistrator.unregister());

/**
 * A filled button keeps its shape when the system takes its colours away.
 *
 * In forced colours — Windows High Contrast, and the same switch in Firefox
 * — every colour the page chose is replaced. A button that was a solid brand
 * fill with no border keeps its words and loses its outline, so it stops
 * looking like a button: on the invoices screen "New invoice" was the only
 * control that had stopped looking like one, beside two secondary buttons
 * that kept theirs.
 *
 * A border declared transparent is forced to a system colour there and
 * drawn. Everywhere else it is invisible and costs nothing — the box is the
 * same 126x36 either way, measured both ways before this was believed.
 *
 * Asserted on the style rather than on a rendering, because no headless DOM
 * emulates the mode: what can rot is somebody removing the declaration
 * because it looks like it does nothing.
 */
function styleOf(element: React.ReactElement): string {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  act(() => root.render(element));
  const style = node.querySelector("button")?.getAttribute("style") ?? "";
  act(() => root.unmount());
  return style;
}

test("a filled button carries a border nobody can see", () => {
  for (const variant of ["primary", "danger"] as const) {
    const style = styleOf(<Button variant={variant}>Do it</Button>);
    expect([variant, /border:\s*1px solid transparent/.test(style)]).toEqual([
      variant,
      true,
    ]);
  }
});

/** The outlined one already had a real border and does not need a second. */
test("the secondary is left alone", () => {
  const style = styleOf(<Button variant="secondary">Cancel</Button>);
  expect(style).not.toContain("1px solid transparent");
});
