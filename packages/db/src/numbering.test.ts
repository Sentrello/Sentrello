import { afterAll, beforeAll, expect, test } from "bun:test";
import { db } from "./client";
import { nextDocumentNumber, nextSequenceNumber } from "./numbering";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * Ten things numbered at the same moment take ten numbers.
 *
 * Every kind goes through `nextSequenceNumber` — invoices and quotes here,
 * the shop's orders and the till's receipts and Z reports in the modules —
 * so racing it once per shape covers them all: a counter that does not exist
 * yet, one that does, and one that starts from a history.
 */

const orgId = `numbering-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await makeOrganization(orgId);
});

afterAll(async () => {
  await dropOrganization(orgId);
});

const atOnce = (take: () => Promise<string>) =>
  Promise.all(Array.from({ length: 10 }, take));

for (const kind of ["invoice", "quote"] as const) {
  test(`ten ${kind}s numbered at once, from no counter and then from one, never share a number`, async () => {
    const take = () =>
      db.transaction((tx) => nextDocumentNumber(tx, orgId, kind));
    const first = await atOnce(take);
    const second = await atOnce(take);
    const prefix = kind === "invoice" ? "INV" : "QUO";
    expect([...first, ...second].sort()).toEqual(
      Array.from(
        { length: 20 },
        (_, i) => `${prefix}-${String(i + 1).padStart(4, "0")}`,
      ),
    );
  }, 30_000);
}

test("a sequence with a history behind it starts after it, however many arrive first", async () => {
  const taken = await atOnce(() =>
    db.transaction((tx) =>
      nextSequenceNumber(
        tx,
        orgId,
        "history",
        (n) => String(n),
        async () => 4000,
      ),
    ),
  );
  expect(taken.map(Number).sort((a, b) => a - b)).toEqual(
    Array.from({ length: 10 }, (_, i) => 4001 + i),
  );
}, 30_000);
