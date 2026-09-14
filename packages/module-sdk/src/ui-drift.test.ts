import { expect, test } from "bun:test";
import { findHandRolledUi } from "./ui-drift";

/**
 * What a screen must not build for itself once a primitive exists for it.
 *
 * Every one of these was found in a real screen in September: a heading styled
 * by hand three different ways, a tab strip copied from another screen, and
 * paging written twice because the shared machinery was not reachable.
 */
test("a hand-styled section heading is a finding, with its line", () => {
  const findings = findHandRolledUi(
    'const x = 1;\n<h2 className="font-semibold text-sm">Tax</h2>',
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(2);
  expect(findings[0]?.say).toMatch(/SectionHeading/);
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

test("a tab strip with no ui.Tabs is a finding", () => {
  expect(
    findHandRolledUi('const [tab, setTab] = useState("all");'),
  ).toHaveLength(1);
});

test("setTab beside ui.Tabs is not a finding", () => {
  expect(
    findHandRolledUi(
      'const [tab, setTab] = useState("all");\n<Tabs tabs={t} active={tab} onChange={setTab} />',
    ),
  ).toEqual([]);
});

test("a doc comment mentioning <h2> or setTab is not a finding", () => {
  expect(
    findHandRolledUi(
      "/** an <h2> with no class, and setTab, both just words here */\nexport function Thing() {}",
    ),
  ).toEqual([]);
});

test("a marked line is excepted", () => {
  expect(
    findHandRolledUi(
      "// ui-drift-ignore: resets its own page elsewhere, a plain counter is safe\nconst [page, setPage] = useState(1);",
    ),
  ).toEqual([]);
});

test("the marker only excepts the line directly below it", () => {
  const findings = findHandRolledUi(
    "// ui-drift-ignore: applies to the next line only\nconst ok = 1;\nconst [page, setPage] = useState(1);",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(3);
});

test("an excepted violation does not hide a later unexcepted one of the same kind", () => {
  const findings = findHandRolledUi(
    "// ui-drift-ignore: resets elsewhere, safe here\n" +
      "const [page, setPage] = useState(1);\n" +
      "const [page, setPage] = useState(1);\n",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(3);
});

test("an excepted tab strip does not hide a later unexcepted one", () => {
  const findings = findHandRolledUi(
    "// ui-drift-ignore: reviewed, fine as a plain toggle\n" +
      "const [tab, setTab] = useState('a');\n" +
      "const [tab2, setTab] = useState('b');\n",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(3);
});
