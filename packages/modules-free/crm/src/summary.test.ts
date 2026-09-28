import { afterAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import { crmFigures } from "./summary";

/**
 * The CRM's dashboard panel, and the two ways its figures lie.
 *
 * A pipeline total that counts decided deals says a business is about to
 * receive money it has already received or lost. And a business renames its
 * stages — "invoiced", "dead" — so a figure that hard-codes "won" reports
 * every closed deal on such an instance as still open, which is the same lie
 * with nothing on screen to hint at it.
 */
const orgId = `org-crm-summary-${crypto.randomUUID().slice(0, 8)}`;
const renamed = `org-crm-renamed-${crypto.randomUUID().slice(0, 8)}`;

const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

const figure = (figures: Awaited<ReturnType<typeof crmFigures>>, l: string) => {
  const found = figures.find((f) => f.label === l);
  if (!found) throw new Error(`no figure ${l}`);
  return found;
};

afterAll(async () => {
  for (const org of [orgId, renamed]) {
    await db.delete(schema.deals).where(eq(schema.deals.organizationId, org));
    await db
      .delete(schema.crmSettings)
      .where(eq(schema.crmSettings.organizationId, org));
  }
});

test("an empty business reads as zero rather than as nothing", async () => {
  const figures = await crmFigures(orgId);
  expect(figures.map((f) => f.value)).toEqual([0, 0, 0]);
  expect(figure(figures, "In the pipeline").kind).toBe("money");
});

test("only undecided deals are in the pipeline", async () => {
  await db.insert(schema.deals).values([
    {
      organizationId: orgId,
      name: "Open one",
      stage: "opportunity",
      amountCents: 150_000,
    },
    {
      organizationId: orgId,
      name: "Won one",
      stage: "won",
      amountCents: 900_000,
    },
    {
      organizationId: orgId,
      name: "Lost one",
      stage: "lost",
      amountCents: 400_000,
    },
  ]);
  const figures = await crmFigures(orgId);
  expect(figure(figures, "In the pipeline").value).toBe(150_000);
  expect(figure(figures, "Open deals").value).toBe(1);
});

test("a deal past its close date is the number that asks for something", async () => {
  await db.insert(schema.deals).values({
    organizationId: orgId,
    name: "Slipped",
    stage: "opportunity",
    amountCents: 50_000,
    expectedCloseOn: yesterday,
  });
  const figures = await crmFigures(orgId);
  const slipped = figure(figures, "Past their close date");
  expect(slipped.value).toBe(1);
  expect(slipped.tone).toBe("bad");
});

/**
 * The stage names are this business's, not ours.
 */
test("a business that renamed its stages still has a decided deal", async () => {
  await db.insert(schema.crmSettings).values({
    organizationId: renamed,
    wonStages: ["invoiced"],
    lostStages: ["dead"],
  });
  await db.insert(schema.deals).values([
    {
      organizationId: renamed,
      name: "Paid",
      stage: "invoiced",
      amountCents: 700_000,
    },
    {
      organizationId: renamed,
      name: "Live",
      stage: "quoting",
      amountCents: 20_000,
    },
  ]);
  const figures = await crmFigures(renamed);
  expect(figure(figures, "In the pipeline").value).toBe(20_000);
  expect(figure(figures, "Open deals").value).toBe(1);
});

test("one business's pipeline is not another's", async () => {
  const fresh = `org-fresh-${crypto.randomUUID().slice(0, 8)}`;
  expect((await crmFigures(fresh)).map((f) => f.value)).toEqual([0, 0, 0]);
});
