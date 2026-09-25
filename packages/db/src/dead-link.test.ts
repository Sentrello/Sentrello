import { expect, test } from "bun:test";
import { deadLinkPage } from "./portal";

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
