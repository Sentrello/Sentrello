import { expect, test } from "bun:test";
import { isMalformedUuid } from "./index";

/**
 * An id that cannot be an id is a 404, not a 500.
 *
 * Postgres answers a malformed uuid with an error rather than an empty
 * result, so a word where an id belongs came back 500 and the screen drew
 * its error boundary — a person who mistyped an address being told the
 * software had broken. Eleven routes answered that way when this was
 * measured.
 *
 * The two a customer's own link points at refuse it before the query. This
 * is the net under the rest, and the thing worth testing about a net is what
 * it does **not** catch: `22P02` is Postgres's "invalid text
 * representation", which it also raises for a bad integer and a bad enum,
 * and turning either of those into a quiet 404 would hide a real fault.
 */
const pg = (code: string, message: string) =>
  Object.assign(new Error(message), { code });

test("a malformed uuid is recognised, however deeply it is wrapped", () => {
  const raw = pg("22P02", 'invalid input syntax for type uuid: "nope"');
  expect(isMalformedUuid(raw)).toBe(true);

  // Drizzle wraps the driver's error, so the chain is what arrives.
  const wrapped = new Error("Failed query", { cause: raw });
  expect(isMalformedUuid(wrapped)).toBe(true);
  expect(isMalformedUuid(new Error("outer", { cause: wrapped }))).toBe(true);
});

test("the same Postgres code about something else is not swallowed", () => {
  expect(
    isMalformedUuid(pg("22P02", 'invalid input syntax for type integer: "x"')),
  ).toBe(false);
  expect(
    isMalformedUuid(pg("22P02", 'invalid input syntax for type json: "x"')),
  ).toBe(false);
});

test("an ordinary failure is left alone", () => {
  expect(isMalformedUuid(new Error("the database is on fire"))).toBe(false);
  expect(isMalformedUuid(pg("23505", "duplicate key value"))).toBe(false);
  expect(isMalformedUuid(null)).toBe(false);
  expect(isMalformedUuid(undefined)).toBe(false);
});

test("a cycle in the cause chain does not hang the handler", () => {
  const a = new Error("a") as Error & { cause?: unknown };
  const b = new Error("b") as Error & { cause?: unknown };
  a.cause = b;
  b.cause = a;
  expect(isMalformedUuid(a)).toBe(false);
});
