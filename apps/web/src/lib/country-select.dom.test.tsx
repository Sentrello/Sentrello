import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { SERVED, countryName } from "./country-data";
import { CountrySelect } from "./ui";

afterAll(() => GlobalRegistrator.unregister());

/**
 * The country somebody is in, chosen rather than typed.
 *
 * The field was a text box hinted `Two letters — "US", "CA", "GB"`, and it is
 * the one that decides how every figure on every document a business sends is
 * written, which tax label its receipts carry, and whether a sale into the EU
 * is a reverse charge. `UK` passed the server's two-letter check and resolved
 * to plain `en`, so a British business kept the American conventions and
 * nothing anywhere said so.
 */
function draw(node: HTMLElement, element: React.ReactElement) {
  const root = createRoot(node);
  act(() => root.render(element));
  return () => act(() => root.unmount());
}

const options = (node: HTMLElement) =>
  [...node.querySelectorAll("option")].map((o) => ({
    value: o.getAttribute("value") ?? "",
    label: o.textContent ?? "",
  }));

test("the business's own country offers the markets and nothing else", () => {
  const node = document.createElement("div");
  document.body.append(node);
  const stop = draw(node, <CountrySelect value="US" onChange={() => {}} />);

  const values = options(node)
    .map((o) => o.value)
    .filter(Boolean);
  expect(values.toSorted()).toEqual([...SERVED].toSorted());
  // Anywhere we do not sell into is a misconfiguration here, not a choice:
  // which tax regimes exist at all is scoped to these four markets.
  expect(values).not.toContain("JP");
  stop();
  node.remove();
});

test("a customer can be anywhere, because a customer is not our market", () => {
  const node = document.createElement("div");
  document.body.append(node);
  const stop = draw(
    node,
    <CountrySelect value="" onChange={() => {}} anywhere />,
  );

  const values = options(node).map((o) => o.value);
  // A business in Boston invoicing Tokyo is a zero-rated export, not a typo.
  expect(values).toContain("JP");
  expect(values).toContain("DE");
  expect(node.querySelectorAll("optgroup")).toHaveLength(2);
  stop();
  node.remove();
});

/**
 * A record typed before there was a list keeps what it has. Silently turning
 * `Germany` into the first option in the list would be the picker deciding
 * somebody's VAT treatment for them.
 */
test("a value the list does not hold is kept, not swallowed", () => {
  const node = document.createElement("div");
  document.body.append(node);
  const stop = draw(node, <CountrySelect value="QQ" onChange={() => {}} />);
  expect(options(node).map((o) => o.value)).toContain("QQ");
  stop();
  node.remove();
});

/** The names come from `Intl`, so nobody maintains 250 strings by hand. */
test("a code is shown as the name somebody would recognise", () => {
  expect(countryName("DE")).toBe("Germany");
  expect(countryName("GB")).toBe("United Kingdom");
  // And a code Intl cannot name is shown as itself rather than as a blank
  // option somebody cannot tell apart from the next one.
  expect(countryName("QQ")).toBe("QQ");
});
