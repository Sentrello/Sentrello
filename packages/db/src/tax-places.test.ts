import { afterAll, beforeAll, expect, test } from "bun:test";
import { db, eq, schema } from "@sentrello/db";
import {
  apportion,
  canadianComponents,
  saleTaxesFor,
  splitCharge,
} from "./tax-places";
import { dropOrganization, makeOrganization } from "./testing";

/**
 * Naming the taxes a Shop or till sale was, from its place and rate alone.
 *
 * Without a name the tax went to the shared Tax Payable, which neither the US
 * nor the Canadian return reads.
 */
const orgId = `tax-places-${crypto.randomUUID().slice(0, 8)}`;

beforeAll(async () => {
  await makeOrganization(orgId);
});
afterAll(async () => {
  await dropOrganization(orgId);
});

test("parts always add up to the whole", () => {
  expect(apportion(100, [50_000, 70_000])).toEqual([42, 58]);
  expect(apportion(1, [1, 1, 1]).reduce((a, b) => a + b, 0)).toBe(1);
  expect(apportion(-100, [50_000, 70_000])).toEqual([-42, -58]);
});

test("a Canadian rate splits only when its parts are what was charged", () => {
  expect(canadianComponents("BC", 120_000)?.map((c) => c.label)).toEqual([
    "GST",
    "PST",
  ]);
  expect(canadianComponents("ON", 130_000)?.map((c) => c.label)).toEqual([
    "HST",
  ]);
  expect(canadianComponents("QC", 149_750)?.map((c) => c.label)).toEqual([
    "GST",
    "QST",
  ]);
  // 11% is not what BC charges: not split, never invented.
  expect(canadianComponents("BC", 110_000)).toBeNull();
  expect(canadianComponents("XX", 50_000)).toBeNull();
});

test("a sale is named once, and named the same way the second time", async () => {
  const ny = await saleTaxesFor(orgId, { country: "US", region: "NY" }, 88_750);
  expect(ny).toHaveLength(1);
  const again = await saleTaxesFor(
    orgId,
    { country: "US", region: "ny" },
    88_750,
  );
  expect(again?.[0]?.taxDefinitionId).toBe(ny?.[0]?.taxDefinitionId);

  const bc = await saleTaxesFor(
    orgId,
    { country: "CA", region: "BC" },
    120_000,
  );
  const qc = await saleTaxesFor(
    orgId,
    { country: "CA", region: "QC" },
    149_750,
  );
  // One GST, shared by every province that charges it.
  expect(bc?.[0]?.taxDefinitionId).toBe(qc?.[0]?.taxDefinitionId);

  const defs = await db
    .select()
    .from(schema.taxDefinitions)
    .where(eq(schema.taxDefinitions.organizationId, orgId));
  const by = (j: string, rate: number) =>
    defs.find((d) => d.jurisdiction === j && d.ratePpm === rate);
  expect(by("US-NY", 88_750)).toMatchObject({
    regime: "us",
    recoverable: false,
  });
  expect(by("CA", 50_000)).toMatchObject({ regime: "ca", recoverable: true });
  // A province's own sales tax is not reclaimable; Quebec's QST is.
  expect(by("CA-BC", 70_000)).toMatchObject({ recoverable: false });
  expect(by("CA-QC", 99_750)).toMatchObject({ recoverable: true });

  // VAT is read from the shared account already, and nothing charged is
  // nothing to name.
  expect(
    await saleTaxesFor(orgId, { country: "GB", region: null }, 200_000),
  ).toBeNull();
  expect(
    await saleTaxesFor(orgId, { country: "US", region: "NY" }, 0),
  ).toBeNull();

  // And a BC charge of 120 divides five twelfths and seven.
  expect(splitCharge(120, bc ?? []).map((p) => p.cents)).toEqual([50, 70]);
  // Rounded down, spare cents to the larger — the receipt's own rule, so the
  // receipt and the books never disagree: 11 cents is 4 and 7, not 5 and 6.
  expect(splitCharge(11, bc ?? []).map((p) => p.cents)).toEqual([4, 7]);
  expect(splitCharge(-11, bc ?? []).map((p) => p.cents)).toEqual([-4, -7]);
});

test("a rate kept for purchases is not reused as a sales tax", async () => {
  const [bought] = await db
    .insert(schema.taxDefinitions)
    .values({
      organizationId: orgId,
      name: "TX use tax",
      rateBp: 625,
      ratePpm: 62_500,
      regime: "us",
      jurisdiction: "US-TX",
      appliesTo: "purchases",
    })
    .returning();
  const [sold] =
    (await saleTaxesFor(orgId, { country: "US", region: "TX" }, 62_500)) ?? [];
  expect(sold?.taxDefinitionId).toBeDefined();
  expect(sold?.taxDefinitionId).not.toBe(bought?.id);
});
