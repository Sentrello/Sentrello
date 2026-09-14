import { expect, test } from "bun:test";
import { parseCsv } from "./csv";

/**
 * The only test `parseCsv` had anywhere in the repository lived in the
 * accounting module's own `pro.test.ts`, a local re-export away from the
 * function it was actually testing. That file left with the rest of the
 * paid half of Accounting; this is the genuine home for it, since nothing
 * here is accounting-specific — a bank statement, a mailing list and a
 * shop's export all read through this same parser.
 */
test("a quoted field keeps its commas", () => {
  const rows = parseCsv('a,"b,c",d\n1,2,3');
  expect(rows[0]).toEqual(["a", "b,c", "d"]);
  expect(rows[1]).toEqual(["1", "2", "3"]);
});
