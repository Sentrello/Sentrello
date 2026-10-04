import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Bars, PairedBars } from "./charts";

afterAll(() => GlobalRegistrator.unregister());

const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function draw(node: React.ReactNode): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => root.render(node));
  return host;
}

/**
 * Pressing a bar opens the rows behind it.
 *
 * The chart's bars have been buttons for a while — added so the readout answers
 * a keyboard — and pressing one did nothing at all. This is the assertion that
 * the button now goes somewhere, made by pressing it rather than by reading the
 * props: a handler passed and never wired to `onClick` looks identical in a
 * diff and does nothing on the screen.
 */
test("a bar with somewhere to go opens it when pressed", () => {
  const opened: string[] = [];
  const host = draw(
    <Bars
      points={[
        {
          label: "Sep",
          value: 400,
          display: "$4.00",
          goLabel: "open the invoices for Sep",
          go: () => opened.push("Sep"),
        },
        { label: "Oct", value: 900, display: "$9.00" },
      ]}
    />,
  );

  const bars = [...host.querySelectorAll("button")];
  expect(bars).toHaveLength(2);

  /*
   * The name says what it does, not only what it is.
   *
   * Somebody who cannot see the cursor change has no other way to know a bar is
   * a door, and a control that acts unannounced is the complaint this product
   * has already had about rows of identical buttons.
   */
  expect(bars[0]?.getAttribute("aria-label")).toBe(
    "Sep: $4.00 — open the invoices for Sep",
  );
  expect(bars[1]?.getAttribute("aria-label")).toBe("Oct: $9.00");

  // And the one with nowhere to go does not pretend otherwise.
  expect(bars[0]?.className).toContain("cursor-pointer");
  expect(bars[1]?.className).toContain("cursor-default");

  act(() => {
    bars[0]?.click();
  });
  expect(opened).toEqual(["Sep"]);

  // Pressing the other one does nothing rather than throwing.
  act(() => {
    bars[1]?.click();
  });
  expect(opened).toEqual(["Sep"]);
});

/** The same for the paired chart, which is a different component. */
test("a paired bar with somewhere to go opens it too", () => {
  const opened: string[] = [];
  const host = draw(
    <PairedBars
      upLabel="Won"
      downLabel="Lost"
      points={[
        {
          label: "Sep",
          up: 10,
          down: 4,
          display: "10 won, 4 lost",
          goLabel: "open September's deals",
          go: () => opened.push("Sep"),
        },
      ]}
    />,
  );

  /*
   * Not the first button on the card: the legend above the chart is two of
   * them, one per series, and each switches a series off. The bar is the one
   * whose name says what it is a picture of.
   */
  const bar = [...host.querySelectorAll("button")].find((b) =>
    b.getAttribute("aria-label")?.startsWith("Sep:"),
  );
  expect(bar?.getAttribute("aria-label")).toBe(
    "Sep: 10 won, 4 lost — open September's deals",
  );
  act(() => {
    bar?.click();
  });
  expect(opened).toEqual(["Sep"]);
});
