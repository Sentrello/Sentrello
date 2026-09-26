import { expect, test } from "bun:test";
import { CUSTOMER_THEME_CSS } from "./customer-theme";

/**
 * What a customer's invoice looks like coming out of a printer.
 *
 * Every public page this product serves — the bill, the account page, the
 * booking diary, the subscriptions portal, the storefront — is built on this
 * one palette, and its dark rules applied to paper as well as to screens.
 * They also out-specify a plain `:root`, because `:not([data-theme="light"])`
 * adds a class's worth, so the print block below them could not undo what
 * they had done.
 *
 * A customer whose browser is in dark mode therefore printed near-white text
 * on near-black. Either it swallows a cartridge, or — with background
 * graphics off, which is how every browser ships — the sheet comes out of the
 * tray looking blank. On an invoice. Found on 26 September by emulating print
 * media, which nothing had ever done.
 *
 * Asserted against the stylesheet rather than a rendered page because that is
 * where the mistake lives: a rule that forgets to say `screen`.
 */
test("every dark rule is a screen rule", () => {
  const dark = [
    ...CUSTOMER_THEME_CSS.matchAll(/^@media[^{]*\{[^{]*\{[^}]*--bg:#0c0c0d/gm),
  ].map((m) => m[0]);
  // Both ways of being dark: the system's preference, and a choice this
  // person made on one of these pages.
  expect(dark.length).toBeGreaterThanOrEqual(2);
  for (const rule of dark) {
    expect([rule.slice(0, 40), rule.includes("screen")]).toEqual([
      rule.slice(0, 40),
      true,
    ]);
  }
});

/** And paper gets ink on white, said outright rather than left to a default. */
test("print says white paper and black ink", () => {
  const print =
    /@media print\{([\s\S]*?)\n\}/.exec(CUSTOMER_THEME_CSS)?.[1] ?? "";
  expect(print).toContain("--bg:#fff");
  expect(print).toContain("--ink:#000");
  // Nothing to press on a sheet of paper.
  expect(print).toContain(".theme-switch{display:none}");
});
