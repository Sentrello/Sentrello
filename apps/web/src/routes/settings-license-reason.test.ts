import { expect, test } from "bun:test";
import { friendlyLicenseReason } from "./settings";

/**
 * `/api/license` carries whatever `jose` said while verifying the token —
 * exactly right for a log line, useless to the business owner it was shown to
 * verbatim (see `packages/licensing-client/src/index.ts`,
 * `verifyLicenseToken`). This is the translation, matched by substring since
 * the library's own wording is not something this screen can pin to a
 * release.
 */
test("no reason is no reason", () => {
  expect(friendlyLicenseReason(null)).toBeNull();
});

test("an expired token reads as expired", () => {
  expect(friendlyLicenseReason('"exp" claim timestamp check failed')).toBe(
    "this licence has expired",
  );
});

test("a signature failure does not name jose", () => {
  const friendly = friendlyLicenseReason("signature verification failed");
  expect(friendly).not.toContain("signature verification failed");
  expect(friendly).toContain("does not check out");
});

test("a wrong issuer says so in plain words", () => {
  expect(friendlyLicenseReason('unexpected "iss" claim value')).toBe(
    "this token was not issued by sentrello.com",
  );
});

test("garbage input still gets a sentence, never the raw library error", () => {
  const friendly = friendlyLicenseReason("Invalid Compact JWS");
  expect(friendly).not.toContain("Compact JWS");
  expect(typeof friendly).toBe("string");
});
