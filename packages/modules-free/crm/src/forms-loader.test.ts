import { expect, test } from "bun:test";
import { embedScript } from "./forms-loader";

/**
 * The script runs on somebody else's website. Anything wrong with it is theirs
 * to explain to their visitors, not ours to notice in a log — so these check
 * the properties that make it safe to paste onto a page you do not control.
 */
const js = embedScript();

test("it escapes anything that reaches innerHTML", () => {
  // Field labels are written by the business but rendered in the browser of
  // whoever is filling the form in.
  expect(js).toContain("function esc(");
  expect(js).toContain("&amp;");
  expect(js).toContain("&lt;");
  expect(js).toContain("&#39;");
});

test("it sends no credentials", () => {
  // A form on a third-party site must never carry the visitor's cookies for
  // this instance, whatever else that site is doing.
  const fetches = js.split("fetch(").length - 1;
  expect(fetches).toBeGreaterThan(0);
  expect(js.split('credentials: "omit"').length - 1).toBe(fetches);
});

test("a colour or radius that is not one is ignored", () => {
  // style comes from the database, but a bad value would land in a stylesheet
  // on somebody else's page. Both are pattern-checked before use.
  expect(js).toContain("/^#[0-9a-fA-F]{3,8}$/");
  expect(js).toContain("/^[0-9.]+(px|rem|em)$/");
});

test("field types are an allow-list, and anything else renders as text", () => {
  // Otherwise a form could ask for `type=password` or something stranger on a
  // page the business does not own.
  //
  // The list is read out of the script and checked by membership rather than
  // by matching the literal, so adding a type to the product does not need
  // this test edited to agree with it — only a type that should not be there
  // fails, which is the thing actually worth catching.
  const match = js.match(/var type = (\[[^\]]*\])\.indexOf\(f\.type\)/);
  if (!match?.[1]) throw new Error("could not find the type allow-list");
  const allowed = JSON.parse(match[1].replaceAll("'", '"')) as string[];

  expect(allowed).toContain("date");
  expect(allowed).toContain("select");
  for (const dangerous of ["password", "file", "hidden", "image", "button"]) {
    expect(allowed).not.toContain(dangerous);
  }
  // Everything not on the list becomes a plain text box rather than being
  // passed through to the DOM.
  expect(js).toContain('.indexOf(f.type) >= 0 ? f.type : "text"');
});

test("a choice field renders a select whose options are escaped", () => {
  // The options are written by the business and rendered on somebody else's
  // page, exactly like a label, so they go through the same escaping.
  expect(js).toContain('"<option>" + esc(o) + "</option>"');
  // A blank first option: a dropdown that starts on a real answer is one the
  // visitor submits without reading it.
  expect(js).toContain('<option value="">');
});

test("failures are quiet on the page and loud in the console", () => {
  // A site owner whose allow-list is wrong should not have an error printed to
  // their visitors.
  expect(js).toContain("console.warn");
  expect(js).not.toContain("alert(");
});

test("it takes the origin from its own tag, not from the page", () => {
  // The script must talk to the instance that served it, whatever the host
  // page's own origin happens to be.
  expect(js).toContain("new URL(tag.src");
});
