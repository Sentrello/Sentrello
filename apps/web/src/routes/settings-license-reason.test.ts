import { expect, test } from "bun:test";
import { friendlyLicenseReason, refreshRefusal } from "./settings";

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

/**
 * And the other half: what the licence *server* said, which is a different
 * question from what the token looked like.
 *
 * Written because a business moving to a new server is the ordinary case this
 * product must handle without us, and it was the one case nothing mentioned.
 * The server has answered "already in use on 1 of 1 permitted installs" since
 * it was written, and there has been a page for releasing an install for just
 * as long; the instance showed neither.
 */
test("an instance limit names the case and offers the page", () => {
  const refusal = refreshRefusal("instance_limit");
  expect(refusal?.text).toContain("another install");
  expect(refusal?.text).toContain("moved to a new server");
  expect(refusal?.offerManage).toBe(true);
});

test("a lapsed subscription is not described as a missing key", () => {
  const refusal = refreshRefusal("not_entitled");
  expect(refusal?.text).toContain("not active");
  expect(refusal?.text).not.toContain("recognise");
});

test("a key of the wrong shape says what the shape is", () => {
  expect(refreshRefusal("malformed_key")?.text).toContain("SENT-");
});

test("an unreachable server is not a warning", () => {
  // A renewal that could not reach the licence server is normal and harmless —
  // there is a grace period, and the panel already says so. Warning about it
  // would cry wolf every time a network blinked.
  expect(refreshRefusal("unreachable")).toBeNull();
  expect(refreshRefusal(undefined)).toBeNull();
});
