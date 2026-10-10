import { expect, test } from "bun:test";
import { addressBucket } from "./caller";

test("IPv4 is counted per address", () => {
  expect(addressBucket("203.0.113.7")).toBe("203.0.113.7");
  expect(addressBucket("::ffff:203.0.113.7")).toBe("203.0.113.7");
  expect(addressBucket("anon")).toBe("anon");
});

test("IPv6 is counted per /64, however it is written", () => {
  const one = addressBucket("2001:db8:abcd:12::1");
  expect(one).toBe("2001:db8:abcd:12::/64");
  // Every address in the block is one caller.
  expect(addressBucket("2001:0db8:abcd:0012:ffff:ffff:ffff:fffe")).toBe(one);
  expect(addressBucket("2001:DB8:ABCD:12:0:0:0:9")).toBe(one);
  expect(addressBucket("fe80::1%en0")).toBe("fe80:0:0:0::/64");
  expect(addressBucket("::1")).toBe("0:0:0:0::/64");
  // The next block over is somebody else.
  expect(addressBucket("2001:db8:abcd:13::1")).not.toBe(one);
});

test("an address it cannot read is kept as it came", () => {
  expect(addressBucket("1::2::3")).toBe("1::2::3");
  expect(addressBucket("1:2:3")).toBe("1:2:3");
  expect(addressBucket("zz:1::")).toBe("zz:1::");
});
