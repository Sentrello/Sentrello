import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SignIn } from "./sign-in";

/**
 * The sign-in page, rendered rather than only reasoned about.
 *
 * It is the first screen everybody meets, and it carries two lines that are
 * commitments rather than decoration: the AGPL source offer, and the
 * "Powered by Sentrello" credit below the form. The credit is asserted on the
 * static render — before any effect or fetch has run — because that is the
 * fail-safe: a Free instance whose /api/_signin call never returns still
 * shows the branding. Only an explicit answer from a Pro instance moves it.
 */
test("the sign-in form carries the credit before any request resolves", () => {
  const html = renderToStaticMarkup(<SignIn />);
  expect(html).toContain("Sign in to Sentrello");
  expect(html).toContain("Powered by Sentrello");
  expect(html).toContain('href="https://sentrello.com"');
  // Below the form, not inside it: the credit is the page's, not the form's.
  expect(html.indexOf("</form>")).toBeLessThan(
    html.indexOf("Powered by Sentrello"),
  );
});
