import { expect, test } from "bun:test";
import { filterIntent, filtersFromIntent, monthRange } from "./drill";

/**
 * What a chart hands to a list when somebody presses a bar.
 *
 * The round trip is the whole of it: the names that go in are the names the list
 * sends the server, so anything that survives the trip is something the list can
 * apply without translating it.
 */
test("the filters a bar asks for arrive as the list's own names", () => {
  const intent = filterIntent({ status: "paid", from: "2026-09-01" });
  expect(filtersFromIntent(intent)).toEqual({
    status: "paid",
    from: "2026-09-01",
  });
});

/**
 * Null and empty are different instructions.
 *
 * "This intent is not about filters" must not be read as "clear the filters", or
 * arriving with the new-contact form up would wipe what somebody had set.
 */
test("an intent about something else is not an empty filter set", () => {
  expect(filtersFromIntent("new")).toBeNull();
  expect(filtersFromIntent(null)).toBeNull();
  expect(filtersFromIntent("")).toBeNull();
  expect(filtersFromIntent(filterIntent({}))).toEqual({});
});

/** Built by our own screens, so anything outside that shape is a bug. */
test("a name the list would not send is dropped", () => {
  expect(filtersFromIntent("filter:status=paid&../etc=x&ok_1=y")).toEqual({
    status: "paid",
    ok_1: "y",
  });
  expect(
    filtersFromIntent(`filter:note=${"x".repeat(300)}&status=paid`),
  ).toEqual({ status: "paid" });
});

/**
 * The last day of a month, which is the part nobody should write twice.
 *
 * February is the test that matters, in both kinds of year.
 */
test("a month becomes the first and last day of it", () => {
  expect(monthRange("2026-09")).toEqual({
    from: "2026-09-01",
    to: "2026-09-30",
  });
  expect(monthRange("2026-02")).toEqual({
    from: "2026-02-01",
    to: "2026-02-28",
  });
  expect(monthRange("2028-02")).toEqual({
    from: "2028-02-01",
    to: "2028-02-29",
  });
  expect(monthRange("2026-12")).toEqual({
    from: "2026-12-01",
    to: "2026-12-31",
  });
  // Nonsense in, nothing out — never a range that silently means "all of time".
  expect(monthRange("not-a-month")).toEqual({ from: "", to: "" });
});
