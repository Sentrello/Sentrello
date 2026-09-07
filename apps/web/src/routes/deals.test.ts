import { expect, test } from "bun:test";

/**
 * Column totals. The question a business asks a pipeline is "how much is in
 * play", not "how many cards" — a board that only counts makes a £2,000 job
 * look like a £20,000 one.
 */
interface D {
  id: string;
  stage: string;
  amountCents: number;
  position: number;
  name: string;
  archivedAt?: string | null;
}

const total = (deals: D[]) => deals.reduce((s, d) => s + d.amountCents, 0);

const byStage = (deals: D[], stage: string) =>
  deals
    .filter((d) => d.stage === stage)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));

const openTotal = (deals: D[]) =>
  deals
    .filter((d) => d.stage !== "won" && d.stage !== "lost")
    .reduce((s, d) => s + d.amountCents, 0);

const deals: D[] = [
  {
    id: "1",
    name: "Bathroom refit",
    stage: "opportunity",
    amountCents: 480_00,
    position: 1,
  },
  {
    id: "2",
    name: "Cellar damp",
    stage: "proposal",
    amountCents: 220_00,
    position: 0,
  },
  {
    id: "3",
    name: "Awning",
    stage: "opportunity",
    amountCents: 90_00,
    position: 0,
  },
  {
    id: "4",
    name: "Garden room",
    stage: "won",
    amountCents: 340_00,
    position: 0,
  },
  { id: "5", name: "Loft", stage: "lost", amountCents: 2_400_00, position: 0 },
];

test("a column totals what is in it", () => {
  expect(total(byStage(deals, "opportunity"))).toBe(570_00);
});

test("cards sit where they were put, not where the name sorts", () => {
  // Position first: people arrange a column to mean something, and a board
  // that reorders itself on load is not a board.
  expect(byStage(deals, "opportunity").map((d) => d.name)).toEqual([
    "Awning",
    "Bathroom refit",
  ]);
});

/**
 * Won and lost are history, not pipeline. Counting a lost £24,000 job as "in
 * play" would overstate the top line by more than everything real combined.
 */
test("in play excludes won and lost", () => {
  expect(openTotal(deals)).toBe(790_00);
});

test("two cards at the same position fall back to the name", () => {
  const tied: D[] = [
    {
      id: "a",
      name: "Zinc gutter",
      stage: "proposal",
      amountCents: 100,
      position: 0,
    },
    {
      id: "b",
      name: "Apex roof",
      stage: "proposal",
      amountCents: 100,
      position: 0,
    },
  ];
  expect(byStage(tied, "proposal").map((d) => d.name)).toEqual([
    "Apex roof",
    "Zinc gutter",
  ]);
});
