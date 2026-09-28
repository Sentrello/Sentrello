import { expect, test } from "bun:test";
import { columnIndex } from "./csv";

test("columnIndex — case-insensitive header lookup with fallbacks", () => {
  const header = ["Date", "Description", "Amount"];
  expect(columnIndex(header, "date")).toBe(0);
  expect(columnIndex(header, "posted", "transaction date", "date")).toBe(0);
  expect(columnIndex(header, "reference")).toBe(-1);
});
