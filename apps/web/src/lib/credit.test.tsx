import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CreditLine, SENTRELLO_CREDIT } from "./credit";

/**
 * The line at the foot of the pages a visitor meets before signing in.
 *
 * The component starts from Sentrello's line and only moves off it when the
 * server explicitly answers — which is the fail-safe the sign-in test below
 * pins down: rendered statically, before any fetch has run, the branding is
 * already there. Nothing that goes wrong later can have hidden it.
 */

test("the default line is Sentrello's, in a tab of its own", () => {
  const html = renderToStaticMarkup(<CreditLine credit={SENTRELLO_CREDIT} />);
  expect(html).toContain("Powered by Sentrello");
  expect(html).toContain('href="https://sentrello.com"');
  expect(html).toContain('target="_blank"');
  expect(html).toContain('rel="noopener noreferrer"');
});

test("a replaced line is the business's, not ours", () => {
  const html = renderToStaticMarkup(
    <CreditLine credit={{ text: "Built by Pike & Co", url: null }} />,
  );
  expect(html).toContain("Built by Pike &amp; Co");
  expect(html).not.toContain("Powered by Sentrello");
  // No URL means text, not a dead anchor.
  expect(html).not.toContain("<a");
});

test("a removed line renders nothing at all", () => {
  expect(renderToStaticMarkup(<CreditLine credit={null} />)).toBe("");
  expect(
    renderToStaticMarkup(<CreditLine credit={{ text: "   ", url: null }} />),
  ).toBe("");
});
