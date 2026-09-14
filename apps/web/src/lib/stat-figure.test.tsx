import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatFigure } from "./ui";

/**
 * The four-figure row at the top of every dashboard, written once.
 *
 * Each module built its own and picked its own size, which is why the same row
 * is text-2xl in one module and text-base in another. The tones come from the
 * shop's version, which had already worked out that a figure sometimes needs to
 * read as good or bad rather than neutral.
 */
test("a figure carries its label and its value", () => {
  const html = renderToStaticMarkup(
    <StatFigure label="Income" value="$98,750.15" />,
  );
  expect(html).toContain("Income");
  expect(html).toContain("$98,750.15");
});

test("a plain figure takes no colour of its own", () => {
  const html = renderToStaticMarkup(
    <StatFigure label="Orders" value="1,802" />,
  );
  expect(html).not.toContain("--color-success");
  expect(html).not.toContain("--color-danger");
});

test("tone colours the figure, never the label", () => {
  const good = renderToStaticMarkup(
    <StatFigure label="Net profit" value="$11,426.10" tone="good" />,
  );
  const bad = renderToStaticMarkup(
    <StatFigure label="Overdue" value="$2,300.00" tone="bad" />,
  );
  expect(good).toContain("--color-success");
  expect(bad).toContain("--color-danger");
  // The label stays muted in both, so a red figure does not make a red row.
  expect(good.indexOf("--color-success")).toBeGreaterThan(
    good.indexOf("Net profit"),
  );
});
