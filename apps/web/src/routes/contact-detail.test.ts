import { expect, test } from "bun:test";

/**
 * Every way to reach somebody, gathered from the primary column and the
 * labelled list. Mirrors `ways()` in contact-detail.tsx.
 */
interface Labelled {
  label: string;
  value: string;
}

function ways(primary: string | null, rest: Labelled[] | null): Labelled[] {
  const out: Labelled[] = primary ? [{ label: "main", value: primary }] : [];
  for (const item of rest ?? []) {
    if (item.value && item.value !== primary) out.push(item);
  }
  return out;
}

test("the main number comes first, then the rest", () => {
  expect(
    ways("0117 496 0000", [{ label: "mobile", value: "07700 900000" }]),
  ).toEqual([
    { label: "main", value: "0117 496 0000" },
    { label: "mobile", value: "07700 900000" },
  ]);
});

/**
 * The primary is usually repeated inside the list. Showing it twice reads as a
 * data problem to whoever is looking at it.
 */
test("a number that is already the main one is not shown twice", () => {
  expect(
    ways("0117 496 0000", [
      { label: "work", value: "0117 496 0000" },
      { label: "mobile", value: "07700 900000" },
    ]),
  ).toEqual([
    { label: "main", value: "0117 496 0000" },
    { label: "mobile", value: "07700 900000" },
  ]);
});

test("a contact with nothing recorded gives nothing, not an empty row", () => {
  expect(ways(null, null)).toEqual([]);
  expect(ways(null, [{ label: "work", value: "" }])).toEqual([]);
});

test("a second number with no primary still shows", () => {
  // Contacts imported from a spreadsheet often have only the extra list.
  expect(ways(null, [{ label: "mobile", value: "07700 900000" }])).toEqual([
    { label: "mobile", value: "07700 900000" },
  ]);
});
