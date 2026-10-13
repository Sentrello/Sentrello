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
  // Blank is unset. A secret of spaces — an environment line with nothing
  // after the equals sign but the editor's padding — is one anybody can sign
  // with, so it refuses exactly as a missing one does.
  if (!header || !secret.trim()) return false;

  const pairs = header.split(",").map((p) => {
    const [k, ...rest] = p.split("=");
    return [k?.trim() ?? "", rest.join("=")] as const;
  });
  const timestamp = Number(Object.fromEntries(pairs).t);
  /*
   * Every `v1`, not the last one.
   *
   * While a signing secret is being rolled Stripe signs with each secret
   * still active and sends one `v1` per secret. Keeping only the last refused
   * every delivery for the length of the roll whenever the last one belonged
   * to the other secret.
   */
  const signatures = pairs
    .filter(([k, v]) => k === "v1" && v)
    .map(([, v]) => v);
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
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
  // Each one is compared in full and the answers are combined after, so the
  // time says pass or fail and never which of them matched.
  let matched = 0;
  for (const signature of signatures) {
    let diff = expected.length ^ signature.length;
    for (let i = 0; i < expected.length; i += 1) {
      diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
    }
    matched |= diff === 0 ? 1 : 0;
  }
  return matched === 1;
}
