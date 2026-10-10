/**
 * Fetches a licence token immediately, then exits.
 *
 * The scheduled refresh is what keeps a token fresh, but it does nothing for
 * the gap between paying and its first run after that — a customer would
 * install Pro and watch it behave as Free for up to an hour. The installer
 * runs this once, and it is also the thing to run by hand after adding a
 * module.
 */
import { refreshLicenseToken } from "./license-refresh";

const result = await refreshLicenseToken();

if (result.refreshed) {
  console.log("license activated");
  process.exit(0);
}

/**
 * The licence is valid but already in use elsewhere.
 *
 * Almost always a customer who moved to a new server, so the message names that
 * case first rather than accusing them of sharing a key — and now names the page
 * that fixes it. It used to say "ask support to release the old one", which was
 * wrong in the way that costs a customer their evening: the licence server has
 * had a page for listing your own installs and releasing one since it was
 * written, and nothing in the product had ever mentioned it.
 */
if (result.error === "instance_limit") {
  const server = (process.env.SENTRELLO_LICENSE_SERVER_URL ?? "").replace(
    /\/+$/,
    "",
  );
  const where = `${server || "https://sentrello.com"}/license`;
  console.error(
    `this license is already active on another server.
If you have moved to a new machine, release the old install at ${where} —
your key lists them — then run \`sentrello activate\` again.`,
  );
  process.exit(1);
}

if (result.error === "not_entitled") {
  console.error(
    "this license is not active — check the subscription is paid and current.",
  );
  process.exit(1);
}

if (result.error === "invalid_license") {
  console.error("that license key was not recognized.");
  process.exit(1);
}

/**
 * The key is set and is not the right shape.
 *
 * This used to be indistinguishable from an unreachable server, which sends
 * somebody to check a firewall that was never the problem. An instance of
 * ours sat in
 * exactly this state for four days: a key written by hand with six groups
 * instead of four, a nightly refresh that did nothing, and a token that then
 * expired.
 */
if (result.error === "malformed_key") {
  console.error(
    "SENTRELLO_LICENSE_KEY is set but is not a license key.\n" +
      "It should read SENT-XXXX-XXXX-XXXX-XXXX — five groups, four characters each.",
  );
  process.exit(1);
}

/**
 * The licence server is shedding load from this address.
 *
 * Not a refusal: the token already here keeps working, and the hourly refresh
 * asks again on its own. Said apart from "unreachable" so nobody goes looking
 * for a firewall problem.
 */
if (result.error === "rate_limited") {
  console.error(
    "the license server is busy and asked this server to wait — the license already here keeps working, and the hourly refresh will try again.",
  );
  process.exit(1);
}

console.error(
  "could not activate the license: the server could not be reached.",
);
process.exit(1);
