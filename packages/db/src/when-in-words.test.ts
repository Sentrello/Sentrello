import { expect, test } from "bun:test";
import { whenInWords } from "./timezone";

/**
 * The formatter that exists because an ISO timestamp reached a customer's
 * timeline. Three things it has to get right, and each one was a bug somewhere.
 */
const when = new Date("2026-10-06T21:00:00.000Z");

test("a moment reads as a person would say it, in the business's zone", () => {
  // Denver is six hours behind in October, so this is an afternoon booking.
  const said = whenInWords(when, "America/Denver", "en-US");
  expect(said).toContain("October 6, 2026");
  expect(said).toMatch(/3:00/);
  expect(said).not.toContain("T21");
});

test("the seller's convention decides the clock", () => {
  const american = whenInWords(when, "America/Denver", "en-US");
  const british = whenInWords(when, "Europe/London", "en-GB");
  expect(american).toMatch(/pm|PM/);
  // 22:00 in London, written the way a British business writes it.
  expect(british).toContain("22:00");
});

test("no zone is UTC, never the server's clock", () => {
  expect(whenInWords(when, null, "en-GB")).toContain("21:00");
});
