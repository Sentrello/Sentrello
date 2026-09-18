/**
 * The two accessibility faults a rendered screen can be asked about here.
 *
 * The browser suite that opens real screens and runs axe over them lives in
 * another repository, so nothing in this one could tell that a screen shipped
 * a control with no name or an ARIA reference pointing at an id that is in no
 * document. Both shipped on the same afternoon, on two different screens, and
 * both are what axe calls critical — the first because a control announced as
 * "button" and nothing else cannot be chosen deliberately, the second because
 * a screen reader following the reference lands nowhere.
 *
 * Neither needs layout, colours or a real browser: they are questions about
 * the markup, which happy-dom answers. Contrast and focus order still need the
 * browser suite, and this does not pretend otherwise.
 *
 * Findings out rather than assertions in, so a caller decides what to do with
 * them and the failure message names the element rather than a boolean.
 */

const CONTROLS = "input, select, textarea, button, a[href]";

/**
 * Every id in the tree, gathered once.
 *
 * Looked up rather than selected for: React's `useId` produces ids that are
 * not valid CSS identifiers, so `querySelector("#" + id)` either throws or
 * needs `CSS.escape`, which happy-dom does not have to provide.
 */
function idsIn(root: ParentNode): Map<string, Element> {
  const byId = new Map<string, Element>();
  for (const el of root.querySelectorAll("[id]")) {
    byId.set(el.getAttribute("id") ?? "", el);
  }
  return byId;
}

/** How an element is described in a finding — enough to find it in the file. */
function describe(el: Element): string {
  const attrs = ["type", "name", "placeholder", "href", "class"]
    .map((a) => (el.hasAttribute(a) ? ` ${a}="${el.getAttribute(a)}"` : ""))
    .join("");
  return `<${el.tagName.toLowerCase()}${attrs}>`;
}

function labelText(el: Element, root: ParentNode): string {
  const wrapping = el.closest("label");
  if (wrapping) return wrapping.textContent ?? "";
  const id = el.getAttribute("id");
  if (!id) return "";
  for (const label of root.querySelectorAll("label[for]")) {
    if (label.getAttribute("for") === id) return label.textContent ?? "";
  }
  return "";
}

/**
 * Controls a person cannot tell apart, because nothing names them.
 *
 * The same order the accessible-name calculation uses, cut to the parts that
 * matter on this platform's screens: `aria-labelledby`, `aria-label`, a label
 * (wrapping or `for=`), then the element's own text for the things that have
 * text of their own. A `title` counts last, as it does in the specification.
 */
export function namelessControls(root: ParentNode): string[] {
  const found: string[] = [];
  const byId = idsIn(root);
  for (const el of root.querySelectorAll(CONTROLS)) {
    // Hidden from everybody, so hidden from this too. A file input behind a
    // styled label is the common case and is correct.
    if (
      el.getAttribute("type") === "hidden" ||
      el.getAttribute("aria-hidden") === "true" ||
      el.closest("[aria-hidden='true']") ||
      el.classList.contains("hidden")
    ) {
      continue;
    }

    const by = el.getAttribute("aria-labelledby");
    const referenced = by
      ? by
          .split(/\s+/)
          .map((id) => byId.get(id)?.textContent ?? "")
          .join(" ")
      : "";

    const ownText =
      el.tagName === "BUTTON" || el.tagName === "A"
        ? (el.textContent ?? "")
        : "";

    const name = [
      referenced,
      el.getAttribute("aria-label") ?? "",
      labelText(el, root),
      ownText,
      el.getAttribute("title") ?? "",
    ]
      .join("")
      .trim();

    if (!name) found.push(describe(el));
  }
  return found;
}

/** Every ARIA attribute whose value is a list of element ids. */
const IDREFS = [
  "aria-controls",
  "aria-labelledby",
  "aria-describedby",
  "aria-owns",
  "aria-details",
  "aria-errormessage",
];

/**
 * ARIA pointing at nothing.
 *
 * The case that shipped: a search box kept `aria-controls` on the results list
 * whether or not the results list was rendered, and it is rendered only while
 * the picker is open. A screen at rest therefore carried a reference to an id
 * that no element had — on every screen with a picker on it, not just the one
 * the report happened to name.
 */
export function danglingAriaRefs(root: ParentNode): string[] {
  const found: string[] = [];
  const byId = idsIn(root);
  for (const el of root.querySelectorAll(
    IDREFS.map((a) => `[${a}]`).join(","),
  )) {
    for (const attr of IDREFS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      for (const id of value.split(/\s+/).filter(Boolean)) {
        if (!byId.has(id)) {
          found.push(
            `${describe(el)} ${attr}="${id}" — no element has that id`,
          );
        }
      }
    }
  }
  return found;
}
