import { expect, test } from "bun:test";
import { isUuid } from "./chart";

test("isUuid — the shape check before a query, not after", () => {
  expect(isUuid("0b8f3b6e-6e2b-4b8a-9b0a-5a6b7c8d9e0f")).toBe(true);
  expect(isUuid("not-a-uuid")).toBe(false);
  expect(isUuid("")).toBe(false);
});
