import { afterEach, expect, test } from "bun:test";
import { unreachableMessage } from "./unreachable";

/**
 * "Something went wrong. Try again." is the right sentence for a request the
 * instance refused and a poor one for a request that never arrived. This
 * product has both more than most: it is sold to somebody standing in a van,
 * and it runs on a server they restart themselves.
 */
const online = (value: boolean | undefined) => {
  if (value === undefined) {
    // biome-ignore lint/performance/noDelete: restoring the global for the next test
    delete (globalThis as { navigator?: unknown }).navigator;
    return;
  }
  (globalThis as { navigator?: unknown }).navigator = { onLine: value };
};

const had = (globalThis as { navigator?: unknown }).navigator;
afterEach(() => {
  (globalThis as { navigator?: unknown }).navigator = had;
});

test("the device has no connection at all", () => {
  online(false);
  expect(unreachableMessage(new Error("whatever"))).toContain("offline");
});

/**
 * `navigator.onLine` is only trusted when it says no. True means the device
 * has a route, which says nothing about whether the instance is at the end
 * of it — so a rejected fetch is reported as the instance being unreachable.
 */
test("the line is up and the instance is not answering", () => {
  online(true);
  expect(unreachableMessage(new TypeError("Failed to fetch"))).toContain(
    "could not be reached",
  );
  expect(unreachableMessage(new TypeError("Load failed"))).toContain(
    "could not be reached",
  );
});

/**
 * The one this must not swallow: a TypeError from a bug in a screen. Dressed
 * up as a network problem, the defect is never reported.
 */
test("a TypeError from our own code is not a network problem", () => {
  online(true);
  expect(
    unreachableMessage(new TypeError("undefined is not an object")),
  ).toBeUndefined();
});

test("an ordinary refusal is left to the sentence above it", () => {
  online(true);
  expect(unreachableMessage(new Error("GET /api/x failed"))).toBeUndefined();
});
