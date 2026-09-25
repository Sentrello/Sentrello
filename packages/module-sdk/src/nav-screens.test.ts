import { expect, test } from "bun:test";
import { navAsked, screensDrawn } from "./nav-screens";

/**
 * The regex is the whole reason this lives in one place, so it is the thing
 * worth testing. The three hand-written copies it replaces matched a string
 * literal only, and reported six doors onto nothing in a module that has
 * none — it registers a family of settings pages in a loop.
 */
test("a screen registered in a loop counts as drawn", () => {
  const { draws, named } = screensDrawn(
    'registerScreen("shop", Home);\n' +
      "registerScreen(`shop-settings-${id}`, Panel);",
  );
  expect(named.has("shop")).toBe(true);
  // The family: named nowhere, drawn all the same.
  expect(draws("shop-settings-tax")).toBe(true);
  expect(draws("shop-settings-anything")).toBe(true);
  // And it does not swallow the rest: a prefix is not a wildcard.
  expect(draws("invoices")).toBe(false);
});

/**
 * An empty prefix would make every id count as drawn, which is a guard that
 * passes for a bundle with no screens at all.
 */
test("a template with no fixed prefix draws nothing extra", () => {
  const { draws } = screensDrawn("registerScreen(`${id}`, Panel);");
  expect(draws("anything")).toBe(false);
});

test("a heading in the rail is not a page, but is still an id", () => {
  const { all, pages } = navAsked((spy) => {
    spy({ id: "shop" });
    spy({ id: "shop-orders", parent: "shop" });
    spy({ id: "shop-products", parent: "shop" });
  });
  expect(all).toEqual(["shop", "shop-orders", "shop-products"]);
  expect(pages).toEqual(["shop-orders", "shop-products"]);
});
