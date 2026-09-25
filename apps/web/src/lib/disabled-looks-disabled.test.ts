import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A control that will not respond has to look like one.
 *
 * Until 25 September nothing in the app said so. 163 controls carry
 * `disabled` and every one was drawn exactly like a live control; the only
 * difference was the cursor, which needs a pointer device and a hover to
 * notice and does not exist on a phone.
 *
 * That is why the form builder's first question looked like it had a working
 * ↑. Pressing it did nothing, so the button was disabled — and a disabled
 * button that looks ready is the same complaint one step along.
 *
 * Nothing else would catch this rule being deleted. No screen asserts its own
 * opacity, and a stylesheet with the rule missing builds, passes and renders;
 * the loss is only visible to somebody looking at the screen. So this reads
 * the stylesheet.
 */
test("disabled controls are drawn dimmer than live ones", () => {
  const css = readFileSync(join(import.meta.dir, "../index.css"), "utf8");
  const rule = css.match(/button:disabled[^{]*\{[^}]*\}/);
  expect(
    rule?.[0],
    "no rule in index.css styles a disabled button",
  ).toBeString();
  expect(rule?.[0], "the disabled rule does not dim anything").toContain(
    "opacity",
  );
});
