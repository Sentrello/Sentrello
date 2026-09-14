import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SectionHeading } from "./ui";

/**
 * One heading, so a panel in a module and a panel in Core are the same weight.
 *
 * The level is a separate decision from the size, and that is the point of
 * having this at all: a heading nested under another has to drop a level for a
 * screen reader, and every screen that hand-rolled one picked the tag that
 * looked right instead.
 */
test("a section heading is an h2 at the size Core uses", () => {
  const html = renderToStaticMarkup(<SectionHeading>Tax</SectionHeading>);
  expect(html).toContain("<h2");
  expect(html).toContain("text-sm");
  expect(html).toContain("Tax");
});

test("a nested heading drops a level without changing size", () => {
  const html = renderToStaticMarkup(
    <SectionHeading level={3}>Colour</SectionHeading>,
  );
  expect(html).toContain("<h3");
  expect(html).toContain("text-sm");
});

test("a hint sits beside the heading rather than inventing a second one", () => {
  const html = renderToStaticMarkup(
    <SectionHeading hint="last 30 days">Sales</SectionHeading>,
  );
  expect(html).toContain("last 30 days");
  expect(html.match(/<h[23]/g)).toHaveLength(1);
});
