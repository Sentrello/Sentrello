import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { isPrivateAddress, mayCall, signOutbound } from "./outbound";

/**
 * The guard is the difference between "calls a URL the business typed" and
 * "reads the cloud metadata service with the server's own credentials", so
 * every range it claims to refuse is asserted by name.
 */
describe("isPrivateAddress", () => {
  test("refuses every private, loopback, link-local and carrier range", () => {
    for (const address of [
      "127.0.0.1",
      "127.8.8.8",
      "10.0.0.5",
      "0.0.0.0",
      "169.254.169.254", // the metadata service itself
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "100.64.0.1", // carrier-grade NAT
      "100.127.255.254",
      "::",
      "::1",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:127.0.0.1", // IPv4 loopback wearing an IPv6 hat
      "::ffff:7f00:1", // the same address after a URL parser normalises it
      "::ffff:c0a8:101", // 192.168.1.1, hex form
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
  });

  test("allows the public internet", () => {
    for (const address of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1", // one past the private range
      "100.128.0.1", // one past carrier NAT
      "2607:f8b0::1",
      "::ffff:808:808", // 8.8.8.8 in the hex form
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

describe("mayCall", () => {
  test("refuses what is not a URL, and schemes that are not the web", async () => {
    expect((await mayCall("not a url")).ok).toBe(false);
    expect((await mayCall("ftp://example.com/x")).ok).toBe(false);
    expect((await mayCall("file:///etc/passwd")).ok).toBe(false);
  });

  test("refuses plain http unless the business said it knows", async () => {
    const refused = await mayCall("http://93.184.216.34/hook");
    expect(refused.ok).toBe(false);
    const allowed = await mayCall("http://93.184.216.34/hook", {
      allowInsecure: true,
    });
    expect(allowed.ok).toBe(true);
  });

  test("refuses a literal private address, in both versions", async () => {
    for (const url of [
      "https://127.0.0.1/hook",
      "https://10.1.2.3/hook",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]/hook",
      "https://[fd00::1]/hook",
    ]) {
      const verdict = await mayCall(url);
      expect(verdict.ok).toBe(false);
    }
  });

  test("resolves a name and judges the address, not the spelling", async () => {
    // localhost is the classic honest-check bypass: the string looks like a
    // name, the address is loopback.
    const verdict = await mayCall("https://localhost/hook");
    expect(verdict.ok).toBe(false);
  });

  test("allows a public address", async () => {
    const verdict = await mayCall("https://93.184.216.34/hook");
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.address).toBe("93.184.216.34");
  });
});

describe("signOutbound", () => {
  test("covers the timestamp and the body, verifiably", () => {
    const header = signOutbound("whsec_test", 1_700_000_000, '{"a":1}');
    expect(header).toBe(
      `t=1700000000,v1=${createHmac("sha256", "whsec_test")
        .update('1700000000.{"a":1}')
        .digest("hex")}`,
    );
  });

  test("a different body is a different signature", () => {
    expect(signOutbound("s", 1, "x")).not.toBe(signOutbound("s", 1, "y"));
    expect(signOutbound("s", 1, "x")).not.toBe(signOutbound("s", 2, "x"));
  });
});
