/**
 * Verifying that a Stripe webhook really came from Stripe.
 *
 * Lives here because three separate things need it — the Pro invoicing
 * webhook, the Shop's orders, and subscription billing on the control plane —
 * and a second implementation of a signature check is a second set of
 * mistakes, in the one place where a mistake means an attacker can post events
 * that move money.
 */

/**
 * Stripe signs `t=<timestamp>,v1=<hmac>` over `<timestamp>.<raw body>`.
 *
 * The timestamp is inside the signed payload so a captured request cannot be
 * replayed later, which makes the age check as load-bearing as the hash.
 *
 * `raw` must be the exact bytes received. Parsing the JSON and re-serialising
 * it changes key order and whitespace, and the signature will never match
 * again — a failure that looks like a wrong secret and is not.
 */
export async function verifyStripeSignature(
  raw: string,
  header: string | null,
  secret: string,
  toleranceSeconds = 300,
  now = Date.now(),
): Promise<boolean> {
  if (!header || !secret) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, ...rest] = p.split("=");
      return [k?.trim() ?? "", rest.join("=")];
    }),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return false;
  if (Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;

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
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant time: a comparison that returns early leaks how much of a forged
  // signature was right, and that is enough to build the rest a byte at a time.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}
