import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "./api";
import { ErrorNote } from "./ui";

/**
 * "not found" is what a route says to a log, and it reached the screen.
 *
 * A bookmark to a record somebody has since deleted drew the page's own
 * title above the server's two words — "Contacts not found" — which reads
 * as the Contacts screen being missing rather than one contact. The
 * commonest way to land there is an old link.
 */
test("a bookmark to something deleted gets a sentence", () => {
  const html = renderToStaticMarkup(
    <ErrorNote
      error={new ApiError(404, "GET /api/contacts/x failed", "not found")}
    />,
  );
  expect(html).toContain("not here any more");
  expect(html).not.toContain(">not found<");
});

/** A route that names what is missing has said something worth keeping. */
test("a server that said something better keeps it", () => {
  const html = renderToStaticMarkup(
    <ErrorNote
      error={new ApiError(404, "GET /api/x failed", "that automation is gone")}
    />,
  );
  expect(html).toContain("that automation is gone");
});

test("the other statuses are unchanged", () => {
  expect(
    renderToStaticMarkup(
      <ErrorNote error={new ApiError(403, "no", undefined)} />,
    ),
  ).toContain("Your role does not allow this");
  expect(
    renderToStaticMarkup(
      <ErrorNote error={new ApiError(401, "no", undefined)} />,
    ),
  ).toContain("session has expired");
});
