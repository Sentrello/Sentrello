import { expect, test } from "bun:test";
import { parseStages, parseTaskTypes, stageId } from "./settings";

/**
 * The id is what deals store. It is derived from the label only when a stage
 * is first created — after that the browser sends it back and it is kept,
 * because renaming "Proposal" to "Quote sent" must not orphan every deal
 * sitting in it.
 */
test("a new stage gets an id from its name", () => {
  expect(stageId("Quote sent")).toBe("quote-sent");
  expect(stageId("  Measured!  ")).toBe("measured");
  expect(stageId("50% deposit")).toBe("50-deposit");
  // Something with nothing usable in it still has to produce an id.
  expect(stageId("···")).toBe("stage");
});

test("an existing stage keeps its id when the label changes", () => {
  const stages = parseStages([
    { id: "proposal", label: "Quote sent" },
    { id: "won", label: "Won" },
  ]);
  expect(stages[0]).toEqual({ id: "proposal", label: "Quote sent" });
});

test("a stage with no id yet gets one", () => {
  const stages = parseStages([{ label: "Site visit booked" }]);
  expect(stages[0]?.id).toBe("site-visit-booked");
});

test("a pipeline needs at least one stage and cannot be enormous", () => {
  expect(() => parseStages([])).toThrow(/at least one stage/);
  expect(() => parseStages("not a list")).toThrow(/must be a list/);
  expect(() =>
    parseStages(Array.from({ length: 13 }, (_, i) => ({ label: `S${i}` }))),
  ).toThrow(/at most 12/);
});

test("two stages cannot share an id", () => {
  // They would collide on the board: one column, two labels, deals in both.
  expect(() =>
    parseStages([{ label: "Quote sent" }, { label: "quote  sent" }]),
  ).toThrow(/two stages/);
});

test("a stage with no name is refused rather than saved blank", () => {
  expect(() => parseStages([{ label: "   " }])).toThrow(
    /every stage needs a name/,
  );
});

test("task types are tidied, deduped and kept non-empty", () => {
  expect(parseTaskTypes([" Call ", "CALL", "email"])).toEqual([
    "call",
    "email",
  ]);
  expect(() => parseTaskTypes([])).toThrow(/at least one/);
  expect(() => parseTaskTypes(["", "  "])).toThrow(/at least one/);
});
