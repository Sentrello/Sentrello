import { expect, test } from "bun:test";
import {
  CUSTOMER_THEME_COOKIE,
  customerThemeFor,
  customerThemeSwitch,
  readCustomerTheme,
  themeAttribute,
} from "./customer-theme";

/**
 * One choice, across every page a customer meets.
 *
 * The account page had a toggle and the pages it links to did not, so a
 * customer who picked dark met a white invoice one click later. The cookie is
 * the whole mechanism, so what it is named and where it applies is the thing
 * worth pinning.
 */

const req = (query: Record<string, string>, cookie?: string) => ({
  query: (name: string) => query[name],
  header: (name: string) => (name === "cookie" ? cookie : undefined),
});

test("asking for a theme sets it, for every page and not just this one", () => {
  const { theme, setCookie } = customerThemeFor(req({ theme: "dark" }));
  expect(theme).toBe("dark");
  expect(setCookie).toContain(`${CUSTOMER_THEME_COOKIE}=dark`);
  // Path=/ is what makes it one choice rather than one per module.
  expect(setCookie).toContain("Path=/");
  expect(setCookie).toContain("HttpOnly");
});

test("a choice already made needs no query string", () => {
  const { theme, setCookie } = customerThemeFor(
    req({}, `${CUSTOMER_THEME_COOKIE}=light; other=1`),
  );
  expect(theme).toBe("light");
  // Nothing changed, so nothing is re-sent.
  expect(setCookie).toBeUndefined();
});

test("no choice is no attribute, so the machine's own preference stands", () => {
  expect(customerThemeFor(req({})).theme).toBeUndefined();
  expect(themeAttribute(undefined)).toBe("");
  expect(themeAttribute("dark")).toBe(' data-theme="dark"');
  expect(readCustomerTheme("sentrello_theme=purple")).toBeUndefined();
});

test("the switch offers the other one, and says which in words", () => {
  const toDark = customerThemeSwitch("/account/abc", "light");
  expect(toDark).toContain("theme=dark");
  expect(toDark).toContain("Switch to dark");

  const toLight = customerThemeSwitch("/account/abc", "dark");
  expect(toLight).toContain("theme=light");

  // A page that already carries a query keeps it.
  expect(customerThemeSwitch("/p/abc?from=email", undefined)).toContain(
    "?from=email&theme=dark",
  );
});
