import { expect, test } from "bun:test";
import { tidy, withBlank } from "./labelled-list";

/**
 * The editor always shows one empty row, which is how another number gets
 * added without a button. That row must never become a stored contact method.
 */
test("blank rows are dropped on save", () => {
  expect(
    tidy([
      { label: "mobile", value: "07700 900000" },
      { label: "", value: "" },
    ]),
  ).toEqual([{ label: "mobile", value: "07700 900000" }]);
});

test("a value with no label still gets one", () => {
  // Otherwise the contact screen renders a number with nothing beside it and
  // it looks like a rendering bug rather than a missing label.
  expect(tidy([{ label: "", value: "0117 496 0000" }])).toEqual([
    { label: "other", value: "0117 496 0000" },
  ]);
});

test("whitespace is not a phone number", () => {
  expect(tidy([{ label: "work", value: "   " }])).toEqual([]);
});

test("surrounding spaces are trimmed rather than stored", () => {
  expect(tidy([{ label: " work ", value: " 0117 496 0000 " }])).toEqual([
    { label: "work", value: "0117 496 0000" },
  ]);
});

test("a contact with nothing recorded still gets a row to type into", () => {
  expect(withBlank(null)).toEqual([{ label: "", value: "" }]);
  expect(withBlank([{ label: "work", value: "x" }])).toHaveLength(2);
});
