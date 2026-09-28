import { expect, test } from "bun:test";
import { TAG_COLOURS, randomTagColour } from "./tags";

/**
 * One palette, because there were two with nothing in common.
 *
 * `lib/tags.tsx` assigned a colour to every tag made from a contact, a company
 * or a deal, out of six Tailwind 500s. `routes/crm-settings.tsx` offered eight
 * lighter ones as swatches. Not one value appeared in both — so every tag the
 * product created arrived in a colour the settings screen could not show as
 * chosen. All eight swatches computed `aria-pressed={false}`, nothing looked
 * selected, and a screen reader was told none of them was the current colour.
 *
 * Neither list was wrong on its own, which is why this lasted: each file was
 * internally consistent and nothing ever compared them.
 */
test("a colour a tag is given is a colour the settings screen offers", () => {
  // Not a sample — every value the assigner can produce.
  for (let i = 0; i < 200; i += 1) {
    expect(TAG_COLOURS).toContain(randomTagColour());
  }
});

test("the palette is the one the server already falls back to", () => {
  // `modules-free/crm/src/settings.ts` gives a contact status `#94a3b8` when
  // it has run out of colours. That made the settings screen's list the one
  // the rest of the product had quietly agreed on, so it is the one that won.
  expect(TAG_COLOURS[0]).toBe("#94a3b8");
  expect(TAG_COLOURS).toHaveLength(8);
  expect(new Set(TAG_COLOURS).size).toBe(TAG_COLOURS.length);
});

test("every colour is a plain hex, because a tag chip writes it into a style", () => {
  for (const colour of TAG_COLOURS) {
    expect(colour).toMatch(/^#[0-9a-f]{6}$/);
  }
});
