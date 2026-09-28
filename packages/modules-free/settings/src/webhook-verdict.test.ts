import { expect, test } from "bun:test";
import { webhookVerdict } from "./payments";

/**
 * "Connected" while every payment goes somewhere that no longer exists.
 *
 * A stored signing secret proves an endpoint was set up once. It does not
 * prove the endpoint still exists, or still points here — and this product's
 * webhook address moved from one module's path to the platform's. The
 * endpoint registered under the old one stayed enabled at Stripe and answered
 * 404 to every delivery: money taken, orders never confirmed, nothing on
 * either side saying so.
 *
 * Found on the demo, 21 September, by a sandbox purchase that succeeded at
 * Stripe while the order sat unpaid.
 */

const OURS = "https://example.test/api/payments/webhook/stripe";

test("events arriving here is the answer nobody needs to act on", () => {
  const verdict = webhookVerdict(OURS, [{ url: OURS, status: "enabled" }]);
  expect(verdict.ok).toBe(true);
  expect(verdict.detail).toBeUndefined();
});

test("an endpoint that is disabled is not an endpoint", () => {
  const verdict = webhookVerdict(OURS, [{ url: OURS, status: "disabled" }]);
  expect(verdict.ok).toBe(false);
});

test("a stale address is named, because the fix is otherwise a guess", () => {
  const stale = "https://example.test/api/shop/webhook/stripe";
  const verdict = webhookVerdict(OURS, [{ url: stale, status: "enabled" }]);
  expect(verdict.ok).toBe(false);
  // The two things somebody needs: where they are going, and what to do.
  expect(verdict.detail).toContain(stale);
  expect(verdict.detail).toContain("connect again");
});

test("no endpoint at all says what will happen, not what is missing", () => {
  const verdict = webhookVerdict(OURS, []);
  expect(verdict.ok).toBe(false);
  expect(verdict.detail).toContain("taken and never confirmed");
});
