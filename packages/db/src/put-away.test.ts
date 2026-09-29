import { afterAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "./client";
import { isEnabled, moduleStates, putAway, setModuleEnabled } from "./modules";
import { moduleState, organizations } from "./schema";

/**
 * Three states, not two.
 *
 * A module can be set up, put away, or never asked about — and the third is
 * why `putAway` exists beside `isEnabled`. `isEnabled` answers "is this in the
 * sidebar", where no decision means no; `putAway` answers "did somebody switch
 * this off", where no decision means no as well. Reading the first as the
 * second would shut the storefront of every business that had never opened
 * Settings → Modules.
 */
const orgId = crypto.randomUUID();

afterAll(async () => {
  await db.delete(moduleState).where(eq(moduleState.organizationId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
});

test("never asked, set up, and put away are three different answers", async () => {
  await db.insert(organizations).values({
    id: orgId,
    name: "Put away",
    slug: `put-away-${orgId.slice(0, 8)}`,
    createdAt: new Date(),
  });

  // Never asked: not in the sidebar, and not switched off either.
  expect(isEnabled(await moduleStates(orgId), "shop")).toBe(false);
  expect(await putAway(orgId, "shop")).toBe(false);

  await setModuleEnabled(orgId, "shop", true);
  expect(isEnabled(await moduleStates(orgId), "shop")).toBe(true);
  expect(await putAway(orgId, "shop")).toBe(false);

  await setModuleEnabled(orgId, "shop", false);
  expect(isEnabled(await moduleStates(orgId), "shop")).toBe(false);
  expect(await putAway(orgId, "shop")).toBe(true);

  // And it is per module: one put away says nothing about the next.
  expect(await putAway(orgId, "scheduling")).toBe(false);
});
