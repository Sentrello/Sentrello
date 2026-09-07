import { expect, test } from "bun:test";
import { LAYOUTS } from "./share";
import { validColour, validateTemplate } from "./templates";

/**
 * The colour is written straight into a stylesheet on a page strangers open,
 * so what it refuses matters more than what it accepts.
 */

test("a colour is a hex colour or it is nothing", () => {
  expect(validColour("#1d4ed8")).toBe("#1d4ed8");
  expect(validColour("#abc")).toBe("#abc");
  expect(validColour("  #ABCDEF  ")).toBe("#ABCDEF");

  // Each of these is a perfectly ordinary-looking string that would rewrite
  // the page if it reached the stylesheet.
  expect(validColour("red;}body{display:none}")).toBeNull();
  expect(validColour("#fff;}@import url(//evil.test/x.css);a{")).toBeNull();
  expect(validColour("url(//evil.test/pixel)")).toBeNull();
  expect(validColour("expression(alert(1))")).toBeNull();
  expect(validColour("")).toBeNull();
  expect(validColour(123)).toBeNull();
});

test("a template that carries a bad colour is refused, not cleaned up", () => {
  // Silently dropping it would leave somebody staring at a colour picker that
  // does nothing and no idea why.
  const bad = validateTemplate({ name: "Ours", accentColor: "rebeccapurple" });
  expect(bad.error).toBeTruthy();
  expect(bad.values).toBeUndefined();
});

test("a template needs a name", () => {
  expect(validateTemplate({ name: "   " }).error).toBeTruthy();
  expect(validateTemplate({}).error).toBeTruthy();
});

test("paper is one of the two sizes anybody in these markets prints on", () => {
  expect(
    validateTemplate({ name: "US", paperSize: "a4" }).values?.paperSize,
  ).toBe("a4");
  // Not "legal", not "8.5x11 sort of" — the page rule is generated from it.
  expect(
    validateTemplate({ name: "US", paperSize: "poster" }).values?.paperSize,
  ).toBe("letter");
});

test("empty wording is stored as nothing rather than as blanks", () => {
  const { values } = validateTemplate({
    name: "Ours",
    headerNote: "   ",
    footerNote: "Thank you for your business.",
  });
  expect(values?.headerNote).toBeNull();
  expect(values?.footerNote).toBe("Thank you for your business.");
});

test("a layout is one of the three we ship, or it is the plain one", () => {
  expect(
    validateTemplate({ name: "Ours", layout: "modern" }).values?.layout,
  ).toBe("modern");
  // A name with no stylesheet behind it would render plain, and a business
  // would have no way of seeing why its letterhead did nothing.
  expect(
    validateTemplate({ name: "Ours", layout: "handwritten" }).values?.layout,
  ).toBe("classic");
  expect(validateTemplate({ name: "Ours" }).values?.layout).toBe("classic");
});

test("every layout the validator accepts has a stylesheet behind it", () => {
  // The two lists are in different files by necessity — the validator cannot
  // import the renderer's CSS without dragging the share page into it — so
  // this is what keeps them honest.
  for (const layout of ["classic", "modern", "compact"]) {
    expect(validateTemplate({ name: "Ours", layout }).values?.layout).toBe(
      layout,
    );
    expect(LAYOUTS[layout]).toBeDefined();
  }
});
