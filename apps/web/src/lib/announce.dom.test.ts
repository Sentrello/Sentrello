import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });

import { afterAll, afterEach, expect, test } from "bun:test";
import { announce, resetAnnouncer } from "./announce";

afterEach(() => resetAnnouncer());
afterAll(() => GlobalRegistrator.unregister());

test("the region is polite, invisible, and made only when it is needed", () => {
  expect(document.querySelector("[aria-live]")).toBeNull();
  announce("No results");
  const region = document.querySelector("[aria-live]");
  expect(region?.getAttribute("aria-live")).toBe("polite");
  expect(region?.className).toBe("sr-only");
  expect(region?.textContent).toBe("No results");
});

/**
 * The same words twice are silence, and twice is a real sequence: filter to
 * three, clear it, filter to three again. A screen reader speaks the change,
 * so the second one has to be a different string and read the same aloud.
 */
test("saying the same thing twice says it twice", () => {
  announce("3 results");
  const first = document.querySelector("[aria-live]")?.textContent;
  announce("3 results");
  const second = document.querySelector("[aria-live]")?.textContent;
  expect(second).not.toBe(first);
  expect(second?.trim()).toBe("3 results");
  expect(document.querySelectorAll("[aria-live]").length).toBe(1);
});
