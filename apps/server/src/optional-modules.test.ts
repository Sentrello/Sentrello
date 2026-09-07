import { expect, test } from "bun:test";
import { isNotInstalled } from "./optional-modules";

/**
 * A bundle that is absent and a bundle that is broken used to look identical,
 * and the difference is a customer either not owning a feature or having paid
 * for one that silently does nothing.
 */

test("a module nobody installed is not a failure", () => {
  for (const message of [
    "Cannot find module '@sentrello/mod-scheduling' from '/srv/Sentrello/apps/server/src/index.ts'",
    "Cannot find package '@sentrello/mod-scheduling' from '/srv/Sentrello'",
  ]) {
    expect(isNotInstalled("@sentrello/mod-scheduling", message)).toBe(true);
  }
});

test("a module that cannot find what it needs is a failure", () => {
  // This exact one: Pro was linked into our own instance and could not resolve
  // `@sentrello/email`, so it was skipped as though it had never been bought.
  expect(
    isNotInstalled(
      "@sentrello/pro-core",
      "Cannot find module '@sentrello/email' from '/srv/Pro/packages/pro-core/src/invoicing.ts'",
    ),
  ).toBe(false);

  expect(
    isNotInstalled("@sentrello/pro-core", "SyntaxError: Unexpected token"),
  ).toBe(false);
});
