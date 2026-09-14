import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A permanent pin, not a one-off check.
 *
 * `receipts.ts` used to read and write `bills.receiptFileKey` directly — a
 * Free file naming a Pro-only table. Task 3 of the accounting relocation
 * moved bill receipts into `purchases.ts`, in the paid bundle, so this file
 * no longer needs to know bills exist at all. That property is cheap to lose
 * silently — a future change could reintroduce the coupling one line at a
 * time — so it is asserted here rather than only argued in a commit message.
 */
test("the Free half's receipts file no longer names the Pro-only bills table", () => {
  const source = readFileSync(join(import.meta.dir, "receipts.ts"), "utf8");
  expect(source).not.toContain("schema.bills");
});
