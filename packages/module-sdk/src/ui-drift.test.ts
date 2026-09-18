import { expect, test } from "bun:test";
import {
  findDroppedNotice,
  findFillAsText,
  findHandRolledUi,
  findUnpagedList,
  findUnthemedElevation,
} from "./ui-drift";

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

/*
 * The two ways the comment stripper was blinded, each proved through the
 * scanner rather than the stripper's output — a blinded scanner returns []
 * exactly like a clean file does, so only "the finding is still found" can
 * catch it.
 */
test("a /* inside a line comment does not hide what follows", () => {
  // The real comment on the last line matters: its closing marker is where
  // the phantom block comment opened on line 1 used to end, swallowing the
  // violation between them.
  const findings = findHandRolledUi(
    "// see the glob pattern /path/*.ts for details\n" +
      "const [page, setPage] = useState(1);\n" +
      "/* an ordinary comment */ const a = 1;",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(2);
});

test('a /* inside a string — accept="image/*" — does not hide what follows', () => {
  const findings = findHandRolledUi(
    '<input type="file" accept="image/*" />\n' +
      '<h2 className="font-semibold">Uploads</h2>\n' +
      "/* an ordinary comment */ const b = 2;",
  );
  expect(findings).toHaveLength(1);
  expect(findings[0]?.line).toBe(2);
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

test("a fill token written as text is a finding, JSX and CSS spellings alike", () => {
  const jsx = findFillAsText('style={{ color: "var(--color-danger)" }}');
  expect(jsx).toHaveLength(1);
  expect(jsx[0]?.say).toContain("--text-");

  const css = findFillAsText(".warn { color: var(--color-warning); }");
  expect(css).toHaveLength(1);

  const brand = findFillAsText(
    'style={{ color: "var(--brand-on-white-text)" }}',
  );
  expect(brand).toHaveLength(1);
  expect(brand[0]?.say).toContain("--text-brand");
});

test("a ternary between two fills is still a finding, on the line color: sits on", () => {
  const findings = findFillAsText(
    "style={{\n  color:\n    net < 0\n" +
      '      ? "var(--color-danger)"\n      : "var(--color-success)",\n}}',
  );
  expect(findings.length).toBeGreaterThan(0);
  expect(findings[0]?.line).toBe(2);
});

test("fills doing fill work are not findings", () => {
  expect(
    findFillAsText(
      'style={{ background: "var(--color-danger)", borderColor: "var(--color-warning)" }}\n' +
        ".box { border-color: var(--color-danger); background-color: var(--color-success); }\n" +
        'style={{ background: "var(--brand-on-white-text)" }}',
    ),
  ).toEqual([]);
});

test("the text tokens themselves are never findings", () => {
  expect(findFillAsText('style={{ color: "var(--text-danger)" }}')).toEqual([]);
});

test("a marked fill-as-text line is excepted", () => {
  expect(
    findFillAsText(
      "// ui-drift-ignore: printed on the invoice PDF, which is always light\n" +
        'style={{ color: "var(--color-danger)" }}',
    ),
  ).toEqual([]);
});

/**
 * The exact line that shipped the defect, and the shapes that must not be
 * mistaken for it.
 *
 * Written from the real code rather than from the rule: the first of these is
 * `invoice-form.tsx` as it stood, and the rest are the calls on the same paths
 * that were always fine and would make the guard a nuisance if it flagged
 * them.
 */
test("a capped list read without a page is found", () => {
  const found = findUnpagedList(
    'api<{ companies: Company[] }>("/api/companies")',
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.say).toContain("/api/companies");

  // A literal query with no paging in it is the same defect wearing a filter.
  expect(
    findUnpagedList(
      "api<{ events: Event[] }>(`/api/users/events?actor=${encodeURIComponent(id)}`)",
    ),
  ).toHaveLength(1);
});

test("paging it, writing to it, or handing the path to a picker is not", () => {
  const fine = [
    // Asked for a page: the whole point.
    'api<{ contacts: Contact[] }>("/api/contacts?page=1&perPage=20")',
    "api<{ events: Event[] }>(`/api/users/events?subject=${id}&page=1&perPage=50`)",
    // Writes, which have always used the same path.
    'api("/api/notes", { method: "POST", body })',
    'api("/api/deals", { method: "POST", body: JSON.stringify(deal) })',
    // A path handed to something that searches server-side.
    '<RecordPicker path="/api/companies" resource="companies" />',
    // A route that only starts with the same words.
    'api<{ counts: Counts }>("/api/invoices/counts")',
    // A query built elsewhere: unreadable as text, so left alone.
    "api<{ quotes: Quote[] }>(`/api/quotes?${query}`)",
  ];
  for (const source of fine) {
    expect([source, findUnpagedList(source)]).toEqual([source, []]);
  }
});

test("a screen that must fetch one unpaged says why on the line above", () => {
  expect(
    findUnpagedList(
      "// ui-drift-ignore: a board draws every column whole; truncated is read below\n" +
        'api<{ deals: Deal[] }>("/api/deals")',
    ),
  ).toEqual([]);
});

/**
 * The other half of the same defect: asked for a page, told what was cut,
 * printed nothing. `WhoOwesPanel` was this until it rendered `data.notice`.
 */
test("a paged report fetched by a screen that never mentions notice is found", () => {
  const found = findDroppedNotice(
    'const { data } = useQuery({ queryFn: () => api<Aged>("/api/reports/accounts-receivable") });',
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.say).toContain("/api/reports/accounts-receivable");
});

test("rendering the sentence, or saying why not, is not", () => {
  const rendering =
    'api<Aged>("/api/reports/accounts-payable");\n{data.notice ? <p>{data.notice}</p> : null}';
  expect(findDroppedNotice(rendering)).toEqual([]);

  expect(
    findDroppedNotice(
      "// ui-drift-ignore: the export takes every row, so nothing is cut\n" +
        'api<Aged>("/api/reports/accounts-receivable?limit=1000")',
    ),
  ).toEqual([]);
});

test("a doc comment about the notice is not a screen rendering it", () => {
  // Comments are stripped first, which is the easy way this would be fooled.
  const found = findDroppedNotice(
    '/** The report carries a notice. */\napi<Aged>("/api/reports/accounts-receivable")',
  );
  expect(found).toHaveLength(1);
  expect(found[0]?.line).toBe(2);
});

/**
 * Elevation. The defect this catches is one nothing else can: a sheet, a
 * dialog and a dropdown all lifted by a black shadow over a near-black ground,
 * which draws three flat rectangles and leaves nobody able to say what is on
 * top of what. It passes every automated accessibility check there is.
 */
test("a shadow with a colour written into it is a finding, CSS and JSX alike", () => {
  expect(
    findUnthemedElevation("  box-shadow: 0 -0.5rem 1.5rem rgb(0 0 0 / 0.28);"),
  ).toHaveLength(1);
  expect(
    findUnthemedElevation('style={{ boxShadow: "0 8px 24px #00000022" }}'),
  ).toHaveLength(1);
  expect(
    findUnthemedElevation("form{box-shadow:0 1px 3px rgba(0,0,0,.1)}")[0]?.say,
  ).toMatch(/--shadow-overlay/);
});

test("a Tailwind elevation utility is a finding — the colour is compiled in", () => {
  expect(
    findUnthemedElevation('className="rounded border p-2 shadow-lg"'),
  ).toHaveLength(1);
  expect(findUnthemedElevation('className="text-xs shadow-sm"')).toHaveLength(
    1,
  );
});

test("a modal scrim written as literal black is a finding", () => {
  expect(
    findUnthemedElevation('style={{ background: "rgba(0,0,0,0.5)" }}'),
  ).toHaveLength(1);
  expect(
    findUnthemedElevation("  background: rgba(0,0,0,.4); display: none;")[0]
      ?.say,
  ).toMatch(/--scrim/);
});

test("the tokens themselves, and where they are defined, are not findings", () => {
  expect(
    findUnthemedElevation(
      [
        "  box-shadow: var(--shadow-overlay);",
        "  --shadow-raised: 0 1px 2px oklch(0 0 0 / 0.45);",
        "  --doc-navbar-shadow: var(--x);",
        "  box-shadow: none;",
        'className="overlay-panel raised-panel drop-shadow-none"',
        'style={{ background: "#ffffff" }}',
      ].join("\n"),
    ),
  ).toEqual([]);
});

/**
 * The escape hatch has to work in CSS too. Half of what this reads is a
 * stylesheet inside a template literal — a customer-facing page with its own
 * palette and no theme to inherit — and `//` there is a parse error, not a
 * comment.
 */
test("a page with its own palette says so on the line above, in either comment", () => {
  expect(
    findUnthemedElevation(
      "// ui-drift-ignore: a standalone page, its own palette\nform{box-shadow:0 1px 3px rgba(0,0,0,.1)}",
    ),
  ).toEqual([]);
  expect(
    findUnthemedElevation(
      "/* ui-drift-ignore: a standalone page, its own palette */\n  box-shadow: 0 8px 24px rgba(0,0,0,.14);",
    ),
  ).toEqual([]);
});
