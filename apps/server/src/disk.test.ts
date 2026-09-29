import { expect, test } from "bun:test";
import { DISK_WARN_PERCENT, diskState, diskWarning } from "./disk";

/**
 * A full disk is not a slow instance: PostgreSQL refuses writes, so the business
 * cannot raise an invoice or record a payment. `/healthz` has reported the
 * retention sweep since it was written and said nothing about the disk that
 * sweep exists to protect.
 */
test("the disk answers for a real directory", () => {
  const here = diskState(import.meta.dir);
  if (!here) throw new Error("statfs answered nothing for a real directory");
  expect(here.percentUsed).toBeGreaterThanOrEqual(0);
  expect(here.percentUsed).toBeLessThanOrEqual(100);
  expect(here.freeBytes).toBeGreaterThan(0);
});

test("a path that is not there is not known, and never an error", () => {
  expect(diskState("/no/such/volume/here")).toBeNull();
  // And nothing is said about a disk nobody could measure, which is the
  // difference between "not known" and "in trouble".
  expect(diskWarning(null)).toBeNull();
});

test("nothing is said until it is worth interrupting somebody", () => {
  const under = { percentUsed: DISK_WARN_PERCENT - 1, freeBytes: 1_000 };
  const over = { percentUsed: DISK_WARN_PERCENT, freeBytes: 1_000 };
  expect(diskWarning(under)).toBeNull();
  expect(diskWarning(over)).toEqual(over);
});
