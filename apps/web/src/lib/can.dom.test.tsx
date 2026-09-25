import { expect, test } from "bun:test";
import type React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { type Meta, may, setGrants } from "./api";
import { Button, MenuItem, Select } from "./ui";

/**
 * What a screen is told about what this person may do.
 *
 * The rule worth pinning is the fallback, not the happy path: **unknown means
 * allowed**. The set arrives with the shell's own meta query, so a screen can
 * render before it lands, a person may belong to no organization yet, and a
 * module can name a resource the server has not compiled. In every one of
 * those the answer is yes, because hiding a control from somebody entitled to
 * it is the worse of the two mistakes and the route refuses what it must
 * regardless.
 */
function answers(can: Meta["can"] | undefined, asks: [string, string][]) {
  setGrants(can);
  return asks.map(([resource, action]) => may(resource, action));
}

test("an action the person holds is allowed, one they do not is refused", () => {
  expect(
    answers({ crm: ["read", "create"] }, [
      ["crm", "read"],
      ["crm", "create"],
      ["crm", "delete"],
    ]),
  ).toEqual([true, true, false]);
});

test("a resource nobody has said anything about is allowed", () => {
  // The whole set missing: the shell's query has not answered yet.
  expect(answers(undefined, [["crm", "delete"]])).toEqual([true]);
  // The set is there and says nothing about this resource: a module naming
  // one the server has not compiled, which must not black out its own screen.
  expect(answers({ crm: ["read"] }, [["shop", "create"]])).toEqual([true]);
  // An empty set is the same case, and is what somebody who belongs to no
  // organization yet is sent.
  expect(answers({}, [["crm", "delete"]])).toEqual([true]);
});

/**
 * An empty list for a resource is a real answer and not a missing one: it
 * says this person holds nothing here. Read as "unknown" it would hand every
 * control back to exactly the people a policy was written to keep out.
 */
test("a resource listed with no actions refuses all of them", () => {
  expect(
    answers({ crm: [] }, [
      ["crm", "read"],
      ["crm", "delete"],
    ]),
  ).toEqual([false, false]);
});

/**
 * The prop itself, because the point of putting the rule in the kit is that
 * several hundred call sites get the same behaviour from one line each.
 *
 * Disabled rather than hidden, on purpose: hiding teaches nobody that the
 * feature exists or that a colleague could do it for them, and a screen that
 * quietly loses half its buttons reads as broken rather than as restricted.
 */
function draw(can: Meta["can"], node: React.ReactNode) {
  setGrants(can);
  // No provider: a primitive that needs a query client to draw a button is a
  // primitive three sign-in tests cannot render, which is how this ended up a
  // module-level value rather than a hook.
  return renderToStaticMarkup(node);
}

test("a button whose permission is missing is disabled and says why", () => {
  const html = draw(
    { crm: ["read"] },
    <Button needs={{ crm: ["delete"] }}>Delete</Button>,
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain("Your role does not allow this.");
});

test("a button whose permission is held is left alone", () => {
  const html = draw(
    { crm: ["read", "delete"] },
    <Button needs={{ crm: ["delete"] }}>Delete</Button>,
  );
  expect(html).not.toContain('disabled=""');
  expect(html).not.toContain("does not allow");
});

/**
 * The reason, for somebody who is not holding a mouse.
 *
 * `title` is a tooltip and nothing else: it needs a pointer to hover, and it
 * says nothing at all to a screen reader. A disabled control is out of the tab
 * order too, so without this the explanation reached only the people who were
 * never going to be confused for long anyway. The whole point of dimming a
 * control instead of hiding it is that somebody learns the feature exists and
 * that a colleague could do it for them — which is worth nothing if the
 * sentence saying so is mouse-only.
 */
test("the reason is readable without a pointer, and linked to the control", () => {
  const html = draw(
    { crm: ["read"] },
    <Button needs={{ crm: ["delete"] }}>Delete</Button>,
  );
  const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
  expect(described).toBeTruthy();
  // The description is real text in the document, not a promise of one: an
  // `aria-describedby` pointing at an id that is not there reads as nothing.
  expect(html).toContain(
    `<span id="${described}" class="sr-only">Your role does not allow this.</span>`,
  );
});

test("a control nobody has refused describes nothing", () => {
  const html = draw(
    { crm: ["delete"] },
    <Button needs={{ crm: ["delete"] }}>Delete</Button>,
  );
  expect(html).not.toContain("aria-describedby");
  expect(html).not.toContain("sr-only");
});

/** Every gated primitive, because the point of the kit is one decision. */
test("each primitive links its own reason", () => {
  // Thunks rather than an array of elements: each is drawn on its own, and a
  // list of JSX asks for keys these will never need.
  for (const node of [
    () => <Button needs={{ crm: ["delete"] }}>Delete</Button>,
    () => <MenuItem needs={{ crm: ["delete"] }}>Delete</MenuItem>,
    () => (
      <Select needs={{ crm: ["update"] }}>
        <option>Open</option>
      </Select>
    ),
  ]) {
    const html = draw({ crm: ["read"] }, node());
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeTruthy();
    expect(html).toContain(`id="${described}" class="sr-only"`);
  }
});

/**
 * Two resources at once — a control that both raises an invoice and touches
 * the ledger needs each of them, and holding one is not holding both.
 */
test("every resource a control names has to be held", () => {
  const html = draw(
    { invoicing: ["create"], bookkeeping: [] },
    <Button needs={{ invoicing: ["create"], bookkeeping: ["create"] }}>
      Raise it
    </Button>,
  );
  expect(html).toContain('disabled=""');
});

/** A control that asks for nothing is never touched by any of this. */
test("a button with no needs is never disabled by permissions", () => {
  expect(draw({ crm: [] }, <Button>Save</Button>)).not.toContain('disabled=""');
});

/**
 * The row menu is where invoices and quotes keep void, credit, delete and
 * send, and every one of them was a bare `<button className="menu-item">`
 * that no permission could reach.
 */
test("a menu item whose permission is missing is disabled and says why", () => {
  const html = draw(
    { invoicing: ["read"] },
    <MenuItem needs={{ invoicing: ["delete"] }}>Delete</MenuItem>,
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain("Your role does not allow this.");
  // Still in the menu. A menu that is a different length for different people
  // is a menu nobody can be told how to use.
  expect(html).toContain("Delete");
});

test("a menu item keeps its own class names", () => {
  const html = draw(
    { invoicing: ["delete"] },
    <MenuItem needs={{ invoicing: ["delete"] }} className="extra">
      Delete
    </MenuItem>,
  );
  // `menu-item-inline`, because there is no `RowMenu` around this one: the
  // menu-line shape is full width on its own line, which is right in a menu
  // and wrong in the table cell where most of these now live.
  expect(html).toContain("menu-item-inline extra");
  expect(html).not.toContain('disabled=""');
});

/**
 * A dropdown whose `onChange` fires a mutation is a control like any other —
 * a status picker on a row, a policy picker beside somebody's name. Six of
 * them across the product were the one shape the gating sweep could not
 * touch: choose an option, meet a 403.
 */
test("a select whose permission is missing is disabled and says why", () => {
  const html = draw(
    { crm: ["read"] },
    <Select needs={{ crm: ["update"] }}>
      <option>Open</option>
    </Select>,
  );
  expect(html).toContain('disabled=""');
  expect(html).toContain("Your role does not allow this.");
});

/** A filter above a list is a read, and disabling one would be nonsense. */
test("a select with no needs is never disabled by permissions", () => {
  const html = draw(
    { crm: [] },
    <Select>
      <option>All</option>
    </Select>,
  );
  expect(html).not.toContain('disabled=""');
});
