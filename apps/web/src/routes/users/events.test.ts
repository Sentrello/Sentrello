import { expect, test } from "bun:test";
import { eventsQuery } from "./events";

/**
 * The query string `GET /api/users/events` reads, built from the filter
 * state — pulled out of the component and tested against the real function
 * (Ruling 39). A filter left blank has to be left out of the request
 * entirely, not sent as the literal empty string: the server route treats a
 * present-but-empty `actor` param the same as an absent one after
 * `.trim() || undefined`, but a test that only checked the happy path would
 * not catch a version of this that sent `actor=` and silently filtered on
 * nothing.
 */

const EMPTY = { actor: "", subject: "", action: "", from: "", to: "", page: 1 };

test("no filters at all asks only for the page", () => {
  expect(eventsQuery(EMPTY)).toBe("page=1");
});

test("each filter is included only when it is set", () => {
  expect(eventsQuery({ ...EMPTY, actor: "u1" })).toBe("page=1&actor=u1");
  expect(eventsQuery({ ...EMPTY, subject: "g1" })).toBe("page=1&subject=g1");
  expect(eventsQuery({ ...EMPTY, action: "sign-in.failed" })).toBe(
    "page=1&action=sign-in.failed",
  );
  expect(eventsQuery({ ...EMPTY, from: "2026-01-01" })).toBe(
    "page=1&from=2026-01-01",
  );
  expect(eventsQuery({ ...EMPTY, to: "2026-01-31" })).toBe(
    "page=1&to=2026-01-31",
  );
});

test("every filter together, and a page past the first", () => {
  const query = eventsQuery({
    actor: "u1",
    subject: "g1",
    action: "sign-in.failed",
    from: "2026-01-01",
    to: "2026-01-31",
    page: 3,
  });
  const params = new URLSearchParams(query);
  expect(params.get("page")).toBe("3");
  expect(params.get("actor")).toBe("u1");
  expect(params.get("subject")).toBe("g1");
  expect(params.get("action")).toBe("sign-in.failed");
  expect(params.get("from")).toBe("2026-01-01");
  expect(params.get("to")).toBe("2026-01-31");
});
