import { expect, test } from "bun:test";
import {
  isNotInstalled,
  missingEntitledBundles,
  newlyMissingEntitledBundles,
} from "./optional-modules";

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

/**
 * What the control plane mints: `with_tier` is what comes with Pro,
 * `modules` is what was bought. The core reads both and remembers neither.
 */
const proClaims = (
  modules: string[] = [],
  with_tier: unknown = ["pro-core", "pro-accounting"],
) => ({
  valid: true,
  claims: { tier: "pro", modules, with_tier } as {
    tier: string;
    modules: string[];
    with_tier?: string[];
  },
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

test("a module sold separately is not expected of the bare tier", () => {
  // `pro-projects` is bought, not part of Pro — and it was on the tier list,
  // so every Pro instance that had not bought it wore a permanent banner
  // about a module it never owned.
  const without = allPresent.filter((id) => id !== "pro-projects");
  expect(missingEntitledBundles(proClaims(), without)).toEqual([]);
  // Bought and absent, it is named like any other purchase.
  expect(
    missingEntitledBundles(proClaims(["pro-projects"]), without).map(
      (m) => m.name,
    ),
  ).toEqual(["pro-projects"]);
});

test("a bought optional module that never arrived is a fault too", () => {
  const missing = missingEntitledBundles(proClaims(["shop"]), allPresent);
  expect(missing.map((m) => m.name)).toEqual(["shop"]);
  // And once it is present — loaded or merely discovered — it is not.
  expect(
    missingEntitledBundles(proClaims(["shop"]), [...allPresent, "shop"]),
  ).toEqual([]);
});

test("a token from before the claim existed expects only what it names", () => {
  // Tokens are refreshed daily; until the fresh one arrives, the safe error
  // is a short silence about tier bundles, never a false alarm about them.
  const older = {
    valid: true,
    claims: { tier: "pro", modules: ["shop"] },
  };
  expect(missingEntitledBundles(older, [...allPresent, "shop"])).toEqual([]);
  expect(
    missingEntitledBundles(older, ["dashboard"]).map((m) => m.name),
  ).toEqual(["shop"]);
});

test("a claim of a shape this core never imagined expects nothing extra", () => {
  // A newer control plane may mint shapes this core predates. Whatever
  // arrives, the answer degrades to expecting less — spreading a string
  // into an entitlement set would alarm about bundles named "p" and "r".
  for (const junk of ["pro-core", 7, { bundles: ["pro-core"] }, null]) {
    expect(missingEntitledBundles(proClaims([], junk), allPresent)).toEqual([]);
  }
  expect(
    missingEntitledBundles(proClaims([], [42, "pro-core"]), []).map(
      (m) => m.name,
    ),
  ).toEqual(["pro-core"]);
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

/**
 * `newlyMissingEntitledBundles` — what drives automatic acquisition
 * (`apps/server/src/module-acquisition.ts`). It is `missingEntitledBundles`
 * called twice and diffed, so a gap that was already there is not "new" and
 * a gap that closes is not reported either way.
 */

test("a fresh purchase is the whole of what is newly missing", () => {
  const before = proClaims([]);
  const after = proClaims(["shop"]);
  expect(newlyMissingEntitledBundles(before, after, allPresent)).toEqual([
    "shop",
  ]);
});

test("a gap already there before this refresh does not count again", () => {
  // Bought last week, still not installed: `before` already reports it
  // missing, so it is not new — the standing licence-screen alarm covers it,
  // not a fresh request every time the token happens to be re-verified.
  const before = proClaims(["shop"]);
  const after = proClaims(["shop"]);
  expect(newlyMissingEntitledBundles(before, after, allPresent)).toEqual([]);
});

test("a refresh that changes nothing reports nothing", () => {
  const state = proClaims(["shop"]);
  expect(newlyMissingEntitledBundles(state, state, allPresent)).toEqual([]);
});

test("losing an entitlement is not a gain", () => {
  const before = proClaims(["shop"]);
  const after = proClaims([]);
  expect(newlyMissingEntitledBundles(before, after, allPresent)).toEqual([]);
});

test("a bundle that was already present is never reported as gained", () => {
  const before = proClaims([]);
  const after = proClaims(["shop"]);
  expect(
    newlyMissingEntitledBundles(before, after, [...allPresent, "shop"]),
  ).toEqual([]);
});

test("Free gaining nothing (no licence at all) reports nothing", () => {
  const free = { valid: false, claims: null };
  expect(newlyMissingEntitledBundles(free, free, allPresent)).toEqual([]);
});
