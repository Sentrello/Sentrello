import { expect, test } from "bun:test";
import { isNotInstalled, missingEntitledBundles } from "./optional-modules";

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

/**
 * The third way to lose a paid module, and the quietest: the bundle is not
 * broken, it is simply not there, on an instance whose licence pays for it.
 * Absence used to be read as "not bought" no matter what the licence said —
 * and since the paid half of Bookkeeping moved into `pro-accounting`, that
 * silence is recurring invoices not going out.
 */

const proClaims = (modules: string[] = []) => ({
  valid: true,
  claims: { tier: "pro", modules },
});

/** Everything a healthy Pro instance would have found. */
const allPresent = [
  "dashboard",
  "crm",
  "money",
  "settings",
  "profile",
  "users",
  "pro-core",
  "pro-accounting",
  "pro-projects",
];

test("a Pro licence with every bundle present raises nothing", () => {
  expect(missingEntitledBundles(proClaims(), allPresent)).toEqual([]);
});

test("a Pro licence with its accounting bundle absent says so by name", () => {
  const missing = missingEntitledBundles(
    proClaims(),
    allPresent.filter((id) => id !== "pro-accounting"),
  );
  expect(missing.map((m) => m.name)).toEqual(["pro-accounting"]);
  // The reason is a sentence with the remedy in it, not an error code.
  expect(missing[0]?.reason).toContain("sentrello update");
});

test("a bought optional module that never arrived is a fault too", () => {
  const missing = missingEntitledBundles(proClaims(["shop"]), allPresent);
  expect(missing.map((m) => m.name)).toEqual(["shop"]);
  // And once it is present — loaded or merely discovered — it is not.
  expect(
    missingEntitledBundles(proClaims(["shop"]), [...allPresent, "shop"]),
  ).toEqual([]);
});

test("a Free instance expects no bundles and stays silent", () => {
  // The overwhelmingly common case: nothing bought, nothing installed,
  // nothing to say. A Free instance's health check must not fill up with
  // modules it never paid for.
  expect(
    missingEntitledBundles({ valid: false, claims: null }, [
      "dashboard",
      "crm",
      "money",
      "settings",
      "profile",
      "users",
    ]),
  ).toEqual([]);
});

test("an invalid Pro token is a licence fault, not a missing bundle", () => {
  // Fail safe to Free: the instance runs as Free and the licence screen says
  // why. A missing-bundle alarm on top would misdiagnose an expired token as
  // an installation problem.
  expect(
    missingEntitledBundles(
      { valid: false, claims: { tier: "pro", modules: ["shop"] } },
      ["dashboard"],
    ),
  ).toEqual([]);
});
