import { expect, test } from "bun:test";
import { findHandRolledUi } from "./ui-drift";

/**
 * What a screen must not build for itself once a primitive exists for it.
 *
 * Every one of these was found in a real screen in September: a heading styled
 * by hand three different ways, a tab strip copied from another screen, and
 * paging written twice because the shared machinery was not reachable.
 */
test("a hand-styled section heading is a finding", () => {
  expect(
    findHandRolledUi('<h2 className="font-semibold text-sm">Tax</h2>'),
  ).toHaveLength(1);
});

test("an unstyled heading is a finding too", () => {
  expect(
    findHandRolledUi("<h2 style={{ marginTop: 0 }}>Colour</h2>"),
  ).toHaveLength(1);
});

test("a heading inside SectionHeading is not a finding", () => {
  expect(
    findHandRolledUi("<SectionHeading level={3}>Colour</SectionHeading>"),
  ).toEqual([]);
});

test("paging state that is not useListState is a finding", () => {
  expect(findHandRolledUi("const [page, setPage] = useState(1);")).toHaveLength(
    1,
  );
});

test("the shared list machinery is not a finding", () => {
  expect(
    findHandRolledUi(
      "const state = useListState({ sort: 'name', order: 'asc' });",
    ),
  ).toEqual([]);
});

test("a clean screen reports nothing", () => {
  expect(
    findHandRolledUi("<Card><SectionHeading>Sales</SectionHeading></Card>"),
  ).toEqual([]);
});
