import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, schema } from "@sentrello/db";
import { SENTRELLO_CREDIT, creditFor, resolveCredit } from "./credit";
import { dropOrganization } from "./testing";

/**
 * Whose name goes at the foot of a page a visitor sees.
 *
 * Free always says ours — that is part of what Free is. Pro is paid for, so
 * the line is the business's to replace or remove; but a Pro business that has
 * never touched the setting still shows ours, because saying nothing is not
 * asking for nothing. And when the answer cannot be worked out at all, the
 * page shows ours: no failure anywhere may quietly take the credit off a Free
 * instance's pages.
 */

const suffix = crypto.randomUUID().slice(0, 8);
const made: string[] = [];

async function org(credit: {
  creditText?: string | null;
  creditUrl?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(schema.organizations)
    .values({
      id: crypto.randomUUID(),
      name: `Credit ${suffix} ${made.length}`,
      slug: `credit-${suffix}-${made.length}`,
      createdAt: new Date(),
      creditText: credit.creditText ?? null,
      creditUrl: credit.creditUrl ?? null,
    })
    .returning();
  if (!row) throw new Error("could not create organization");
  made.push(row.id);
  return row.id;
}

afterAll(async () => {
  await dropOrganization(...made);
});

test("a free instance always credits Sentrello, whatever is stored", async () => {
  const id = await org({ creditText: "Built by Pike & Co" });
  expect(await creditFor(id, false)).toEqual(SENTRELLO_CREDIT);
});

test("a pro instance that never touched the setting still shows ours", async () => {
  const id = await org({});
  expect(await creditFor(id, true)).toEqual(SENTRELLO_CREDIT);
});

test("a pro instance can put its own line there", async () => {
  const id = await org({
    creditText: "Built by Pike & Co",
    creditUrl: "https://pike.example",
  });
  expect(await creditFor(id, true)).toEqual({
    text: "Built by Pike & Co",
    url: "https://pike.example",
  });
});

test("a pro instance can remove the line entirely", async () => {
  const id = await org({ creditText: "" });
  expect(await creditFor(id, true)).toBeNull();
});

test("an organization that cannot be read shows ours, never nothing", async () => {
  // The row is missing, so whether the business removed the line cannot be
  // known — and an error must never hide the branding on a Free instance.
  expect(await creditFor(crypto.randomUUID(), true)).toEqual(SENTRELLO_CREDIT);
  expect(resolveCredit(undefined, true)).toEqual(SENTRELLO_CREDIT);
});

test("a custom line of only spaces is a removal, not a blank anchor", async () => {
  const id = await org({ creditText: "   ", creditUrl: "https://x.example" });
  expect(await creditFor(id, true)).toBeNull();
});
