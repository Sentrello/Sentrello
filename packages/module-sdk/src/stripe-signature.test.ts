import { expect, test } from "bun:test";
import { verifyStripeSignature } from "./stripe-signature";

const SECRET = "whsec_test_secret";

/** Signs exactly as Stripe does, so the test proves the check, not itself. */
async function sign(raw: string, timestamp: number, secret = SECRET) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${raw}`),
  );
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
}

const body = JSON.stringify({
  id: "evt_1",
  type: "customer.subscription.created",
});
const now = 1_800_000_000_000;
const at = Math.floor(now / 1000);

test("a signature Stripe made is accepted", async () => {
  const header = await sign(body, at);
  expect(await verifyStripeSignature(body, header, SECRET, 300, now)).toBe(
    true,
  );
});

test("a body changed after signing is refused", async () => {
  const header = await sign(body, at);
  const tampered = JSON.stringify({
    id: "evt_1",
    type: "customer.subscription.deleted",
  });
  expect(await verifyStripeSignature(tampered, header, SECRET, 300, now)).toBe(
    false,
  );
});

test("a signature from a different secret is refused", async () => {
  const header = await sign(body, at, "whsec_someone_elses");
  expect(await verifyStripeSignature(body, header, SECRET, 300, now)).toBe(
    false,
  );
});

/**
 * The replay guard. Without it a request captured once can be posted again
 * forever, and it would verify perfectly every time.
 */
test("a valid signature from an hour ago is refused", async () => {
  const header = await sign(body, at - 3600);
  expect(await verifyStripeSignature(body, header, SECRET, 300, now)).toBe(
    false,
  );
  // And a timestamp in the future is no better, which is what a clock skewed
  // the other way looks like.
  const ahead = await sign(body, at + 3600);
  expect(await verifyStripeSignature(body, ahead, SECRET, 300, now)).toBe(
    false,
  );
});

test("nonsense headers are refused rather than throwing", async () => {
  for (const header of ["", "t=,v1=", "v1=abc", "garbage", "t=abc,v1=def"]) {
    expect(await verifyStripeSignature(body, header, SECRET, 300, now)).toBe(
      false,
    );
  }
  expect(await verifyStripeSignature(body, null, SECRET, 300, now)).toBe(false);
  // No secret configured must fail closed, never open.
  expect(await verifyStripeSignature(body, await sign(body, at), "")).toBe(
    false,
  );
});
