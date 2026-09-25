import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost/" });
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { afterAll, afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { Row, RowMenu, Table } from "./ui";

afterAll(() => GlobalRegistrator.unregister());

/*
 * Unmounted, not wiped.
 *
 * `document.body.innerHTML = ""` is the usual teardown and it is wrong for a
 * component that portals: it removes the panel from the body behind React's
 * back, and the next unmount throws `removeChild ... not a child of this
 * node`. Which is a fair complaint. Let React take its own nodes out.
 */
const mounted: { unmount: () => void }[] = [];
afterEach(() => {
  for (const root of mounted.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

/**
 * The menu has to open outside the table, or it is cut in half.
 *
 * James reported this on the CRM's forms screen — "a UI issue when clicking
 * the 3 dots" — and it was on four screens, for one reason belonging to none
 * of them. `Table` wraps itself in `overflow-x-auto` so narrow screens scroll
 * sideways rather than burst, and CSS will not let a box be clipped on one
 * axis and visible on the other: `overflow-x: auto` makes the vertical axis
 * `auto` too. A panel positioned inside a cell is therefore cut off at the
 * table's bottom edge.
 *
 * No z-index fixes that, because clipping is not a stacking question. The only
 * fix is to not be inside the table, which is what this asserts: the panel's
 * parent is `document.body`.
 *
 * Asserting on the DOM parent rather than on a screenshot because that *is*
 * the fix. A visual check would pass on any table short enough to have room
 * beneath it, which is every table in a test and no table in a business.
 */
function openMenu() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  act(() => {
    root.render(
      <Table headers={["Name", ""]}>
        <Row>
          <td>Contact us</td>
          <td>
            <RowMenu label="Contact us">
              {(close) => (
                <button type="button" className="menu-item" onClick={close}>
                  Edit questions
                </button>
              )}
            </RowMenu>
          </td>
        </Row>
      </Table>,
    );
  });

  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="More for Contact us"]',
  );
  if (!trigger) throw new Error("no trigger rendered");
  act(() => trigger.click());
  return { trigger, host, root };
}

test("the panel is portalled to the body, not left inside the scrolling table", () => {
  const { host } = openMenu();

  const panel = document.querySelector(".menu-panel");
  expect(panel).not.toBeNull();

  // The whole fix, in one assertion.
  expect(panel?.parentElement).toBe(document.body);

  // And the belt: nothing between the panel and the body clips it.
  expect(host.querySelector(".menu-panel")).toBeNull();
  expect(document.querySelector(".overflow-x-auto")).not.toBeNull();
});

/**
 * Not a menu, and no longer claiming to be one.
 *
 * `role="menu"` was on the panel and `aria-haspopup="menu"` on the trigger for
 * months. Axe calls the result **critical**: a `menu` may only contain
 * `menuitem`, and every item here is a `<button>`. The screen walk never saw
 * it because it never opens a menu — 234 screens green over a critical
 * violation on the most-used control in the product.
 *
 * Relabelling the buttons `menuitem` would satisfy the rule and leave a
 * screen-reader user worse off: the role promises arrows, Home, End and
 * typeahead that this does not implement, and takes the items out of the tab
 * sequence to pay for it. `MenuItem` is used outside a menu on half a dozen
 * screens too, where a `menuitem` with no menu around it is a critical
 * violation of its own.
 */
test("the panel does not claim a keyboard model it has not got", () => {
  openMenu();
  const panel = document.querySelector(".menu-panel");
  expect(panel?.getAttribute("role")).toBeNull();
});

/**
 * Focus follows the press into the panel.
 *
 * The panel is portalled onto `document.body`, so it sits at the end of the
 * document however near the row it looks. Tab from the trigger therefore went
 * to the next row, and the only way to reach Void or Delete without a mouse
 * was to tab through the rest of the screen. Escape and returning focus to
 * the trigger were here already; this is the other half of them.
 */
test("opening it moves focus into the panel", () => {
  openMenu();
  const item = document.querySelector<HTMLButtonElement>(".menu-item");
  expect(document.activeElement).toBe(item);
});

test("the trigger says whether it is open, and the items can close it", () => {
  const { trigger } = openMenu();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  // `true`, not `menu` — there is no menu behind it, only buttons.
  expect(trigger.getAttribute("aria-haspopup")).toBe("true");

  const item = document.querySelector<HTMLButtonElement>(".menu-item");
  if (!item) throw new Error("no item rendered");
  act(() => item.click());

  expect(document.querySelector(".menu-panel")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("Escape closes it", () => {
  const { trigger } = openMenu();
  act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(document.querySelector(".menu-panel")).toBeNull();
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});
