import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { logMigrationNotice } from "./migration-notices";

let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
});

test("an already-exists notice is swallowed, not dumped", () => {
  logMigrationNotice({
    message: 'schema "drizzle" already exists, skipping',
  } as never);
  expect(logSpy).not.toHaveBeenCalled();
});

test("the same wording is swallowed regardless of what already existed", () => {
  logMigrationNotice({
    message: 'relation "orders" already exists, skipping',
  } as never);
  expect(logSpy).not.toHaveBeenCalled();
});

test("a notice that isn't a known skip is surfaced in full", () => {
  logMigrationNotice({
    message: "identity column requires sequence ownership, ignored",
  } as never);
  expect(logSpy).toHaveBeenCalledTimes(1);
  expect(logSpy.mock.calls[0]?.[0]).toContain(
    "identity column requires sequence ownership, ignored",
  );
});
