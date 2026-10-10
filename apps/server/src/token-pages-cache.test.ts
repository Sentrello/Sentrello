import { expect, test } from "bun:test";

/**
 * A page opened by a link that is the whole credential is never kept.
 *
 * `/share/…`, `/portal/…` and `/account/…` carry somebody's bill, address and
 * what they owe, and the token in the address is all it takes to read them.
 * They went out with no `cache-control` at all, which leaves the decision to
 * every cache between the business and its customer: a CDN rule that caches
 * HTML, a proxy in an office, the shared computer's history. Found 10 October
 * 2026.
 */
test("token pages and API answers say not to keep them", async () => {
  process.env.SENTRELLO_LICENSE_TOKEN_PATH = "secrets/does-not-exist.jwt";
  const server = (await import("./index")).default;
  const token = "x".repeat(43);
  for (const path of [
    `/share/invoice/${token}`,
    `/share/quote/${token}`,
    `/portal/${token}`,
    `/account/${token}`,
    "/api/invitations/not-a-real-invitation-token",
  ]) {
    const res = await server.fetch(new Request(`http://localhost${path}`));
    expect(`${path} ${res.headers.get("cache-control")}`).toBe(
      `${path} private, no-store`,
    );
  }
});
