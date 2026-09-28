import { expect, test } from "bun:test";
import { MONEY_MARKETS } from "@sentrello/module-sdk/money-locale";
import { deadLinkPage, moneyLocale } from "./portal";

/**
 * What a customer meets when their link does not work.
 *
 * It was Hono's bare `404 Not Found` — no title, no sentence, no link — on a
 * page somebody reached by following a bill their supplier sent them. A dead
 * link is ordinary: an email wraps a long URL and breaks it, a token is
 * replaced, a bookmark goes stale. The person meeting one could not tell
 * whether they still owed money, whether the business existed, or what to do.
 *
 * The page is a constant, so what is worth holding is what it says and what
 * it does not.
 */

test("it says what happened and what to do about it", () => {
  const page = deadLinkPage();
  expect(page).toContain("<title>This link does not work</title>");
  // The next step, which is the only thing the reader can act on: the token
  // is the whole credential and we cannot mint them a new one.
  expect(page).toContain("Ask whoever sent it for a new one");
});

/**
 * It names no business, and it is the same page for every bad token.
 *
 * Which token was once real is not a customer's question and is not a
 * stranger's either. A page that said "that link has been replaced" for a
 * token that used to work, and something else for one that never did, would
 * tell somebody guessing at links when they had guessed close.
 */
test("it gives nothing away", () => {
  expect(deadLinkPage()).toBe(deadLinkPage());
  const page = deadLinkPage().toLowerCase();
  for (const leak of ["expired", "replaced link", "invoice", "customer"]) {
    expect([leak, page.includes(leak)]).toEqual([leak, false]);
  }
});

/**
 * Not indexed. It is reached from a link in somebody's email and has no
 * business in a search result, the same as every other page on this token.
 */
test("no crawler is invited", () => {
  expect(deadLinkPage()).toContain('name="robots" content="noindex"');
});

/** Readable on the phone it will usually be opened on, and in the dark. */
test("it is drawn for the device it lands on", () => {
  const page = deadLinkPage();
  expect(page).toContain("width=device-width");
  expect(page).toContain("prefers-color-scheme: dark");
});

/**
 * How a business writes a number, which is not how every business does.
 *
 * `en-US` for everybody was the American way of writing a European figure:
 * Germany reads `1.279,97 €` and France `1 279,97 €`. A Canadian invoicing
 * in dollars was shown `CA$1,279.97` — the form you use when you are *not*
 * in Canada, on an invoice going to somebody who is.
 *
 * The country is enough on its own, which is why this is one field and not a
 * table of locales. It is asked for on the business settings screen, under
 * the postcode, and is the second thing the onboarding checklist points at.
 */
const written = (country: string | null | undefined, currency: string) =>
  new Intl.NumberFormat(moneyLocale(country), {
    style: "currency",
    currency,
  })
    .format(1279.97)
    // `Intl` separates a symbol from its number with a non-breaking space,
    // which is right on the page and invisible in a failure message: the
    // first version of this test compared two strings that looked identical.
    .replace(/\p{Zs}/gu, " ");

test("each market reads its own money", () => {
  expect(written("DE", "EUR")).toBe("1.279,97 €");
  expect(written("CA", "CAD")).toBe("$1,279.97");
  expect(written("GB", "GBP")).toBe("£1,279.97");
  expect(written("US", "USD")).toBe("$1,279.97");
});

/**
 * And nothing changes for the two markets that were already right, which is
 * what makes this safe to land six days before anybody is using it.
 */
test("a business that has not said keeps what it had", () => {
  expect(moneyLocale(undefined)).toBe("en-US");
  expect(moneyLocale("")).toBe("en-US");
  expect(written(null, "USD")).toBe("$1,279.97");
});

/** A country typed as nonsense is not a reason to throw while drawing an
 * invoice. */
test("rubbish in the field is not an exception", () => {
  expect(moneyLocale("Germany")).toBe("en-US");
  expect(moneyLocale("!!")).toBe("en-US");
  expect(moneyLocale("de")).toBe("de-DE");
});

/**
 * The tag itself, because the string above hid a bug for a day.
 *
 * It was `en-${country}` — `en-DE`, `en-FR` — which on macOS gives Germany's
 * separators and on Linux gives America's, silently, because number symbols
 * are inherited from the language and only a recent CLDR adds the European
 * branch under `en`. Nothing threw; `supportedLocalesOf` even said `en-DE`
 * was supported. Every assertion above passed on the machine it was written
 * on and failed in the container this product ships in.
 *
 * So: no market outside the English-speaking ones may resolve to an `en` tag.
 */
test("a market that does not speak English is not given an English locale", () => {
  for (const country of ["DE", "FR", "IT", "ES", "NL", "SE", "PL"]) {
    expect([country, moneyLocale(country).startsWith("en")]).toEqual([
      country,
      false,
    ]);
  }
  // And the four that do keep theirs.
  expect(moneyLocale("US")).toBe("en-US");
  expect(moneyLocale("CA")).toBe("en-CA");
  expect(moneyLocale("GB")).toBe("en-GB");
  expect(moneyLocale("IE")).toBe("en-IE");
});

/**
 * Every market this product sells into resolves to the locale it was given.
 *
 * This is the failure mode itself. `en-DE` is a structurally valid tag that
 * `Intl` accepts, reports as supported, and then quietly resolves to plain
 * `en` on any build whose CLDR predates the European `en-150` branch — which
 * is the build in the container. A locale that resolves to something other
 * than what was asked for is a market reading somebody else's numbers.
 */
test("no market falls back to a locale nobody chose", () => {
  for (const country of MONEY_MARKETS) {
    const asked = moneyLocale(country);
    const got = new Intl.NumberFormat(asked, {
      style: "currency",
      currency: "EUR",
    }).resolvedOptions().locale;
    expect([country, got]).toEqual([country, asked]);
  }
});
