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
  /*
   * "file" used to be on this line with the rest of them, and it was right to
   * be: an upload from a public form is a stranger writing to the instance's
   * disk. It is allowed now because it is checked now — one format, the bytes
   * read on arrival, and a scanner when the instance has one. The others have
   * no such story and stay out.
   */
  expect(allowed).toContain("file");
  for (const dangerous of ["password", "hidden", "image", "button"]) {
    expect(allowed).not.toContain(dangerous);
  }
  // Everything not on the list becomes a plain text box rather than being
  // passed through to the DOM.
  expect(js).toContain('.indexOf(f.type) >= 0 ? f.type : "text"');
});

test("a choice field renders a select whose options are escaped", () => {
  // The options are written by the business and rendered on somebody else's
  // page, exactly like a label, so they go through the same escaping.
  expect(js).toContain("'<option value=\"' + esc(o) +");
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

/**
 * Radio groups, asked for by James on 22 September for the contact form.
 *
 * The reason to have both this and a dropdown is that the choice between them
 * is real: four options somebody should read before answering want radios,
 * and thirty countries want a dropdown. On a form where the answer routes the
 * enquiry, a visitor who picks the first item without opening the menu has
 * sent it to the wrong place, and nobody finds out.
 */
test("a radio field renders every option, and none of them starts chosen", () => {
  expect(js).toContain('type === "radio"');
  // Every option is rendered, rather than the first being special.
  expect(js).toContain("(f.options || []).forEach");
  /*
   * Nothing is preselected. A radio group with a default is a question the
   * visitor never answers — they submit whatever was already there.
   *
   * Asserted against the attribute the script could emit rather than against
   * the word, which also appears in the stylesheet's `:has(input:checked)`
   * and would make this pass for the wrong reason.
   */
  expect(js).toContain('<input type="radio"');
  expect(js).not.toContain('" checked"');
  expect(js).not.toContain("' checked'");
  expect(js).not.toMatch(/checked\s*:/);
});

test("a radio group is labelled rather than pointed at", () => {
  // `<label for>` names one control, and a group of four radios has no single
  // one to name: the browser would tie the question to the first option, and
  // a screen reader would read the question and the first answer as one
  // phrase. So the group carries its own id and the radiogroup refers to it.
  expect(js).toContain('role="radiogroup"');
  expect(js).toContain("aria-labelledby=");
});

test("the option box is the click target, not just the dot", () => {
  // The label wraps the input, so the whole card is clickable — a radio dot
  // is about 13 pixels across and this is a form people fill in on phones.
  expect(js).toContain('class="sentrello-opt"');
  expect(js).toContain(":has(input:checked)");
  // And it can still be seen when tabbed to, which `:has(input:focus-visible)`
  // is doing: the input itself is visually inside a bordered box, so the
  // browser's own focus ring on a 13px dot is easy to miss.
  expect(js).toContain(":has(input:focus-visible)");
});

/**
 * Two fields on one row, asked for so a contact form can put the name beside
 * the email — the shape every good one has and this could not draw.
 */
test("a field can take half a row, and the rest span the form", () => {
  expect(js).toContain("sentrello-half");
  // The grid is on the form element and not on the host div. The host is what
  // this script inserts, and the form sits inside it next to the stylesheet —
  // so a grid on the host lays out a style tag and a form, every field stays
  // in one column, and it looks precisely like the option not working.
  expect(js).toContain(".sentrello-form form{display:grid");
  expect(js).not.toContain(
    ".sentrello-form{font:inherit;max-width:32rem;display:grid",
  );
});

test("label and control are wrapped together", () => {
  // Two siblings in a grid would be laid out separately, which puts the
  // second field's label above the first field's input.
  expect(js).toContain('class="sentrello-field');
});

test("an optional field says so, rather than every other one shouting", () => {
  expect(js).toContain("sentrello-optional");
  expect(js).toContain("Optional");
});

test("the submit button is its own width", () => {
  // A grid child fills its track. A Send button as wide as the form reads as
  // a banner rather than as a thing to press.
  expect(js).toContain("justify-self:start");
});

/**
 * A file field asks for one format, and says so to the picker.
 *
 * The attribute filters nothing a determined visitor cannot get around — the
 * instance reads the bytes on arrival and that is the check that counts. This
 * is so somebody is told before they wait for an upload rather than after.
 */
test("an upload asks for a PDF", () => {
  expect(js).toContain('type="file" accept="application/pdf,.pdf"');
});

/**
 * A file cannot travel as JSON, and a multipart body cannot travel with a
 * content-type set by hand: writing the header drops the boundary the browser
 * generated, and the instance receives something it cannot parse.
 */
test("a form carrying a file posts the body the browser built", () => {
  expect(js).toContain("var data = new FormData(el)");
  expect(js).toContain("if (!carrying) {");
  expect(js).toContain(
    'sending.headers = { "content-type": "application/json" }',
  );
});
