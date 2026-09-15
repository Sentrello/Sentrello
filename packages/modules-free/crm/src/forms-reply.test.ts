import { expect, test } from "bun:test";
import { SENTRELLO_CREDIT } from "@sentrello/db/credit";
import { thanksPage } from "./forms-reply";

/**
 * What a visitor is told about the software underneath.
 *
 * A Free instance carries "Powered by Sentrello" at the foot of every
 * thank-you page — that is part of what Free is, and for most people it is the
 * only place they will ever see the product named. Pro is paid for: a paying
 * business puts its own credit there, or none at all.
 */

test("a free instance credits Sentrello, in a tab of its own", () => {
  const html = thanksPage("Contact form", "Halloway & Finch");

  expect(html).toContain("Powered by Sentrello");
  expect(html).toContain('href="https://sentrello.com"');
  // The visitor was in the middle of contacting somebody and this page is the
  // receipt for it — following the credit must not take that away.
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

test("a business can put its own there", () => {
  const html = thanksPage("Contact form", "Halloway & Finch", {
    text: "Built by Pike & Co",
    url: "https://pike.example",
  });

  // Escaped, like everything else a business typed that lands in markup.
  expect(html).toContain("Built by Pike &amp; Co");
  expect(html).toContain('href="https://pike.example"');
  expect(html).not.toContain("Powered by Sentrello");
});

test("a credit with no link is text, not a dead anchor", () => {
  const html = thanksPage("Contact form", "Halloway & Finch", {
    text: "Pike & Co",
    url: null,
  });

  expect(html).toContain("Pike &amp; Co");
  expect(html).not.toContain("<a href");
});

/** No credit at all, which is what a paying business gets by saying nothing. */
test("no credit leaves the page without one", () => {
  const html = thanksPage("Contact form", "Halloway & Finch", null);

  expect(html).not.toContain("Powered by Sentrello");
  // The stylesheet always carries a `.credit` rule; what must be absent is the
  // element, not the word.
  expect(html).not.toContain('<p class="credit">');
});

/**
 * The credit is drawn on a page a visitor sees, from text a business typed.
 *
 * Everything else on this page is escaped; this is the newest thing on it and
 * the one most likely to be forgotten.
 */
test("a credit cannot inject markup", () => {
  const html = thanksPage("Contact form", "A shop", {
    text: '<img src=x onerror="alert(1)">',
    url: 'javascript:alert(1)"',
  });

  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img");
  expect(html).not.toContain('onerror="alert(1)"');
});

/** The default is ours, so a caller that forgets does not white-label Free. */
test("the default credit is Sentrello's", () => {
  expect(SENTRELLO_CREDIT.text).toBe("Powered by Sentrello");
  expect(SENTRELLO_CREDIT.url).toBe("https://sentrello.com");
});
