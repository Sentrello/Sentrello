import { expect, test } from "bun:test";
import { weakPasswordReason } from "./weak-passwords";

/**
 * The case a length rule cannot see.
 *
 * Twelve characters is a real improvement and it lets through the passwords
 * somebody types when they are in a hurry and the box says twelve.
 */
test("a long password that is one character repeated is refused", () => {
  expect(weakPasswordReason("aaaaaaaaaaaa")).toBeTruthy();
  expect(weakPasswordReason("111111111111")).toBeTruthy();
});

test("a walk along the keyboard or the alphabet is refused, either way round", () => {
  expect(weakPasswordReason("abcdefghijkl")).toBeTruthy();
  expect(weakPasswordReason("0123456789012")).toBeTruthy();
  expect(weakPasswordReason("zyxwvutsrqpo")).toBeTruthy();
});

test("a short pattern repeated to reach the length is refused", () => {
  expect(weakPasswordReason("abcabcabcabc")).toBeTruthy();
  expect(weakPasswordReason("12341234123412")).toBeTruthy();
});

test("the product's own name is refused, because it is on the screen", () => {
  expect(weakPasswordReason("Sentrello2026")).toBeTruthy();
});

/**
 * And a real one is allowed, which matters as much.
 *
 * A check that refuses good passwords teaches people to work around it, and
 * what they work around it with is worse than what they started with.
 */
test("a passphrase somebody would actually use is allowed", () => {
  expect(weakPasswordReason("correct-horse-battery-staple")).toBeNull();
  expect(weakPasswordReason("thistlefield-marmalade-92")).toBeNull();
  // Long, mixed, no pattern — the sort of thing a manager generates.
  expect(weakPasswordReason("Xk7#mQ2vLp9$wR4t")).toBeNull();
});
